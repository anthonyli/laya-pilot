// Only a visible replay host can provide an operator and a live browser window.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authRoute, findRecordingAuth, rememberRecordingAuth } from './recording-auth.mjs';

let prompt;
const sessions = new WeakMap();

export function setReplayLoginPrompt(handler) {
    prompt = handler;
}

export function hasReplayLogin(page) {
    return sessions.has(page);
}

export async function restoreReplayLogin(config) {
    if (!prompt || config.headless || config.authState || config.authReset) return;
    const cached = await findRecordingAuth(config.credentialRoot, config.url, config.user);
    if (!cached) return;
    config.authState = cached.authState;
    config.authAccount = cached.account;
    config.authSessionStorage = true;
    config.recordedLogin = cached.info;
}

export function attachReplayLogin(page, context, config) {
    if (!prompt || config.headless) return;
    const session = { context, config, prompt, moduleRoutes: config.moduleRoutes };
    sessions.set(page, session);
    page.on('response', (response) => {
        if (
            response.status() === 401 &&
            new URL(response.url()).origin === new URL(config.url).origin
        )
            session.unauthorized = true;
    });
}

export function setReplayTraces(page, traces) {
    const session = sessions.get(page);
    if (session) session.traces = traces;
}

// Inspect the form structure, without reading field values, labels or URL keywords.
async function formSignal(page) {
    return page.evaluate(() => {
        const visible = (el) =>
            el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        let possible = false;
        for (const field of inputs) {
            if (
                !field.matches(
                    'input[type=password],input[autocomplete~=current-password i],input[autocomplete~=one-time-code i],input[autocomplete~=username i]',
                )
            )
                continue;
            const scope = field.form || field.closest('[role=form],[role=dialog]') || document;
            const fields = inputs.filter((el) => scope.contains(el));
            if (
                fields.some((el) => el.matches('[autocomplete~=new-password i]')) ||
                fields.filter((el) => el.type === 'password').length > 1
            )
                continue;
            const submit = [
                ...scope.querySelectorAll('button,input[type=submit],[role=button]'),
            ].some(visible);
            const password = fields.some(
                (el) => el.type === 'password' || el.autocomplete === 'current-password',
            );
            const identity = fields.some((el) =>
                el.matches('[autocomplete~=username i],input[type=email]'),
            );
            if (
                submit &&
                password &&
                (identity || fields.some((el) => el.matches('[autocomplete~=current-password i]')))
            )
                return 'login';
            if (submit) possible = true;
        }
        return possible ? 'possible' : null;
    });
}

async function markerVisible(page, selector) {
    if (!selector) return false;
    const marker = page.locator(selector);
    return (await marker.count()) === 1 && (await marker.isVisible());
}

async function challenge(page, session, startup, failedRedirect = false) {
    const { config } = session;
    if (await session.prompt({ phase: 'sso-pending' })) return { crossSite: true };
    const route = authRoute(page.url());
    if (new URL(page.url()).origin !== new URL(config.url).origin) return null;
    if (await session.prompt({ phase: 'requested' })) return 'login';
    const form = await formSignal(page);
    if (form === 'login') return 'login';
    const known = session.knownLogin || config.recordedLogin;
    const knownLoginRoute = known?.loginUrl === route && known.landingUrl !== route;
    if (knownLoginRoute && form) return 'login';
    if (!form && (await markerVisible(page, config.authCheck || known?.check))) return null;
    const possible =
        form ||
        knownLoginRoute ||
        session.unauthorized ||
        failedRedirect ||
        (startup && (route !== authRoute(config.url) || config.manualLogin || config.authCheck));
    if (!possible) {
        session.dismissed = null;
        return null;
    }
    const key = JSON.stringify([route, form]);
    return session.dismissed === key ? null : { key };
}

async function ask(session, page, message, choices) {
    for (;;) {
        session.config.signal?.throwIfAborted();
        if (page.isClosed()) throw Error('回放窗口已关闭');
        const answer = await session.prompt(message);
        if (choices.includes(answer)) return answer;
        await delay(250, undefined, { signal: session.config.signal });
    }
}

async function recover(page, session, action, detected) {
    const { config, context } = session;
    const id = randomUUID();
    const url = page.url();
    const origin = new URL(config.url).origin;
    const tracing = session.traces?.open;
    // Discard the interrupted trace before handing over the browser for login.
    if (tracing) await session.traces.suspend();
    config.replayLoginActive = true;
    const labels = detected.crossSite
        ? []
        : await page.locator('a,button,h1,h2,[role=heading],[role=tab]').allTextContents();
    const login = {
        url,
        account: config.authAccount || config.user || '',
        publicLabels: labels.map((label) => label.trim()).filter(Boolean),
    };
    let resumeTrace = false;
    try {
        if (detected.key) {
            const answer = await ask(session, page, { id, phase: 'identify' }, [
                'login',
                'continue',
            ]);
            if (answer === 'continue') {
                session.dismissed = detected.key;
                session.unauthorized = false;
                resumeTrace = true;
                return 'unchanged';
            }
        }
        await session.prompt({ id, phase: 'login' });
        let previous;
        for (;;) {
            config.signal?.throwIfAborted();
            if (page.isClosed()) throw Error('登录窗口已关闭');
            await delay(350, undefined, { signal: config.signal });
            const address = page.url();
            const site = new URL(address).origin;
            const location = await session.prompt({ id, phase: 'sso-location' });
            const allowed = location
                ? location.documentOk &&
                  site === location.origin &&
                  !location.loading &&
                  (location.automatic || location.approved)
                : site === origin;
            // Observe a stable, authorized business document across two polls. Intermediate
            // identity providers can redirect several times without exposing their DOM or storage.
            const revision = JSON.stringify([address, location?.generation]);
            if (!allowed || previous !== revision) {
                previous = allowed ? revision : undefined;
                continue;
            }
            if (await formSignal(page).catch(() => true)) continue;
            const current = async () => {
                if (page.isClosed() || config.signal?.aborted || page.url() !== address)
                    return false;
                if (!location) return true;
                const live = await session.prompt({ id, phase: 'sso-location' });
                return (
                    live?.generation === location.generation &&
                    live.origin === site &&
                    live.documentOk &&
                    !live.loading &&
                    (live.approved || live.automatic)
                );
            };
            const businessLogin =
                detected.crossSite || site !== origin
                    ? { ...login, url: authRoute(address), publicLabels: [] }
                    : login;
            const check = site === origin ? config.authCheck : config.explicitAuthCheck;
            const saved = await rememberRecordingAuth(
                config.credentialRoot,
                context,
                page,
                businessLogin,
                check,
                current,
                { interactive: true, stateFile: site === origin ? config.authState : undefined },
            ).catch(async (error) => {
                if (await current()) throw error;
                return false;
            });
            if (!saved) continue;
            if (
                location &&
                !(await session.prompt({
                    id,
                    phase: 'sso-finish',
                    origin: site,
                    generation: location.generation,
                }))
            )
                continue;
            if (site !== origin) {
                config.url = authRoute(address);
                if (config.origins && !config.origins.includes(site)) config.origins.push(site);
                if (session.moduleRoutes)
                    config.moduleRoutes = new Map(
                        [...session.moduleRoutes].filter(
                            ([, route]) => new URL(route).origin === site,
                        ),
                    );
                config.authState = undefined;
                config.recordedLogin = undefined;
                config.authCheck = check;
            } else if (authRoute(config.url) === authRoute(url)) config.url = authRoute(address);
            session.knownLogin = {
                loginUrl: authRoute(businessLogin.url),
                landingUrl: authRoute(address),
            };
            break;
        }
        session.unauthorized = false;
        session.dismissed = null;
        config.authenticated = true;
        console.log('AUTH 已在当前回放窗口验证并保存站点登录态。');
        resumeTrace = true;
        if (!action) return;
        const decision = await ask(session, page, { id, phase: 'confirm', label: action.label }, [
            'completed',
            'retry',
        ]);
        console.log(
            decision === 'completed'
                ? 'AUTH 操作者确认上一步已完成。'
                : 'AUTH 操作者确认重新执行上一步。',
        );
        return decision;
    } finally {
        await session.prompt({ id, phase: 'clear' });
        config.replayLoginActive = !resumeTrace;
        if (tracing && resumeTrace && !page.isClosed()) await session.traces.begin();
    }
}

// Chromium holds cross-site document requests until the in-flight action yields.
export async function pauseForReplayRedirect(page) {
    const session = sessions.get(page);
    if (!session || !(await session.prompt({ phase: 'sso-pending' }))) return false;
    if (session.executing) throw Error('回放已遇到跨站跳转');
    return resumeReplay(page, session, { crossSite: true });
}

export async function navigateReplayPage(page, url) {
    const navigation = page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!sessions.has(page)) return navigation;
    const settled = navigation.then(
        () => ({ done: true }),
        (error) => ({ done: true, error }),
    );
    for (;;) {
        const result = await Promise.race([settled, delay(100)]);
        if (await pauseForReplayRedirect(page)) {
            // A human login can outlive the original navigation's timeout.
            await settled;
            return;
        }
        if (result?.error) throw result.error;
        if (result?.done) return;
    }
}

export async function awaitReplayLogin(page, startup = false) {
    const session = sessions.get(page);
    if (!session) return false;
    const detected = await challenge(page, session, startup);
    return detected ? resumeReplay(page, session, detected) : false;
}

async function resumeReplay(page, session, detected) {
    const last = session.last;
    session.last = undefined;
    const decision = await recover(page, session, last, detected);
    if (decision === 'unchanged') {
        session.last = last;
        return false;
    }
    if (decision === 'completed') last?.onConfirmed?.();
    if (decision === 'retry')
        await runReplayOperation(page, last.label, true, last.work, last.onConfirmed);
    return true;
}

// Retain the last potentially mutating operation until the next operation starts.
// A redirect can arrive after a click resolves and before the next step is dispatched.
export async function runReplayOperation(page, label, uncertain, work, onConfirmed) {
    const session = sessions.get(page);
    if (!session) return work();
    const action = uncertain ? { label, work, onConfirmed } : undefined;
    for (;;) {
        await awaitReplayLogin(page);
        const pending = action || session.last;
        session.last = pending;
        const before = authRoute(page.url());
        let result, failure;
        session.executing = true;
        try {
            result = await work();
        } catch (error) {
            failure = error;
        } finally {
            session.executing = false;
        }
        const detected = await challenge(
            page,
            session,
            false,
            !!failure && before !== authRoute(page.url()),
        );
        if (!detected) {
            if (!action && !failure) session.last = undefined;
            if (failure) throw failure;
            return result;
        }
        session.last = undefined;
        const decision = await recover(page, session, pending, detected);
        if (decision === 'unchanged') {
            session.last = pending;
            if (failure) throw failure;
            return result;
        }
        if (decision === 'completed') {
            pending?.onConfirmed?.();
            if (action) return;
        }
        if (decision === 'retry' && pending !== action)
            await runReplayOperation(page, pending.label, true, pending.work, pending.onConfirmed);
        // Only observations repeat automatically. Retrying an action requires the operator.
    }
}
