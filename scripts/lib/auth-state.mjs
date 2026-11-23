import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { writePrivateJson } from './run-state.mjs';
import { waitForReady, switchLanguage } from './readiness.mjs';
import { registerSecret } from './diagnostics.mjs';
import { loadLoginCredentials, saveLoginCredentials } from './credentials.mjs';

function loginLocator(page, descriptor) {
    if (!descriptor) return null;
    if (descriptor.kind === 'role')
        return page
            .getByRole(descriptor.role, { name: descriptor.name, exact: true })
            .filter({ visible: true });
    const method = { label: 'getByLabel', placeholder: 'getByPlaceholder' }[descriptor.kind];
    return method ? page[method](descriptor.name, { exact: true }).filter({ visible: true }) : null;
}

async function submitLogin(page, config, credentials, readSecret, chooseTarget) {
    const origin = new URL(config.url).origin;
    const loginUrl = credentials?.loginUrl || config.recordedLogin?.loginUrl;
    if (loginUrl && new URL(loginUrl).origin !== origin) throw Error('登录凭据与目标站点不匹配。');
    const timeout = config.pageTimeout || 30000;
    const loginRoute = (address) => {
        const url = new URL(address);
        return url.origin + url.pathname + url.hash.split('?')[0];
    };
    if (loginUrl && loginRoute(page.url()) !== loginRoute(loginUrl))
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=password]:visible').first().waitFor({ timeout });
    if (new URL(page.url()).origin !== origin)
        throw Error('登录页面已跳转到其他站点，无法使用当前站点凭据。');
    if (!credentials?.recipe)
        await switchLanguage(page, config.language === 'auto' ? 'zh-CN' : config.language);
    const attemptedUrl = page.url();
    const accountName =
        /^(?:(?:请输入|请填写)\s*)?(?:登录)?(?:账号|账户|用户名|邮箱)$|^(?:(?:enter|input)\s+(?:the\s+)?)?(?:(?:login|sign in)\s+)?(?:account|username|user name|email)$/i;
    const recipe = credentials?.recipe;
    let account =
        loginLocator(page, recipe?.account) ||
        page
            .getByRole('textbox', { name: accountName })
            .or(page.getByPlaceholder(accountName))
            .filter({ visible: true });
    if ((await account.count()) !== 1 && chooseTarget)
        account = (await chooseTarget('账号 Account Username', 'fill')).locator;
    const passwords = (
        loginLocator(page, recipe?.password) || page.locator('input[type=password]:visible')
    ).and(page.locator('input[type=password]:visible'));
    if ((await account.count()) !== 1 || (await passwords.count()) !== 1)
        throw Error('登录表单无法唯一确定账号或密码框，请重新录制登录。');
    const accountValue = credentials?.account || config.user;
    const password = registerSecret(
        config.preferPassword || !credentials ? await readSecret() : credentials.password,
    );
    if (typeof password !== 'string' || !password) throw Error('本次登录缺少密码。');
    const handles = [];
    const bind = async (locator) => {
        const handle = await locator.elementHandle({ timeout });
        handles.push(handle);
        return handle;
    };
    try {
        const accountInput = await bind(account);
        const passwordInput = await bind(passwords);
        let login =
            loginLocator(page, recipe?.submit) ||
            page
                .getByRole('button', { name: /^(登\s*录|login|log in|sign in)$/i })
                .filter({ visible: true });
        if (
            (await login.count()) !== 1 &&
            chooseTarget &&
            (await page.getByRole('button').filter({ visible: true }).count())
        )
            login = (await chooseTarget('登录 Login Sign in')).locator;
        let submit = (await login.count()) === 1 ? await bind(login) : null;
        const validateForm = async () => {
            const valid = await page.evaluate(
                ({ accountInput, passwordInput, submit, origin, route }) => {
                    if (
                        location.origin !== origin ||
                        location.origin + location.pathname + location.hash.split('?')[0] !== route
                    )
                        return false;
                    if (
                        ![accountInput, passwordInput, submit]
                            .filter(Boolean)
                            .every((el) => el.isConnected && el.ownerDocument === document)
                    )
                        return false;
                    if (
                        accountInput === passwordInput ||
                        !passwordInput.matches('input[type=password]')
                    )
                        return false;
                    const formOf = (el) => el.form || el.closest('form');
                    const form = formOf(passwordInput);
                    if (formOf(accountInput) !== form || (submit && formOf(submit) !== form))
                        return false;
                    const action =
                        submit?.getAttribute('formaction') ?? form?.getAttribute('action');
                    return new URL(action || location.href, document.baseURI).origin === origin;
                },
                {
                    accountInput,
                    passwordInput,
                    submit,
                    origin,
                    route: loginRoute(loginUrl || attemptedUrl),
                },
            );
            if (!valid) throw Error('登录表单或提交站点已改变。');
        };
        // Element handles belong to one document. A redirect during username entry cannot
        // retarget the password fill, even if the next page uses identical field labels.
        await validateForm();
        await accountInput.fill(accountValue, { timeout });
        await validateForm();
        await passwordInput.fill(password, { timeout });
        // Some forms mount their submit control only when both required inputs are filled.
        if (!submit) {
            await login.waitFor({ state: 'visible', timeout });
            submit = await bind(login);
        }
        await validateForm();
        // A retry of this whole block could submit the same credentials twice.
        await submit.click({ timeout });
        await page.locator('input[type=password]:visible').waitFor({ state: 'hidden', timeout });
    } catch {
        throw Error(
            '自动登录未成功，当前登录态仍然失效。请检查账号密码或登录页是否要求验证码，重新登录一次可更新本地凭据。',
        );
    } finally {
        await Promise.allSettled(handles.map((handle) => handle.dispose()));
    }
    return { account: accountValue, password, loginUrl: loginUrl || attemptedUrl, recipe };
}

export async function captureFailureScreenshot(page, file) {
    if (!page) return false;
    try {
        await page.screenshot({
            path: file,
            timeout: 3000,
            mask: [page.locator('input, textarea, [contenteditable="true"]')],
        });
        return true;
    } catch {
        return false;
    }
}

export async function loadAuthState(config) {
    if (!config.authState || config.authReset) return null;
    let saved;
    try {
        saved = JSON.parse(await fs.readFile(path.resolve(config.authState), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw Error('登录态文件无法读取，请重新登录并使用 --auth-reset');
    }
    if (
        saved.schemaVersion !== 1 ||
        saved.origin !== new URL(config.url).origin ||
        saved.account !== (config.authAccount ?? config.user ?? '') ||
        !Array.isArray(saved.storageState?.cookies) ||
        !Array.isArray(saved.storageState?.origins)
    )
        throw Error('登录态的站点、账号或格式不匹配，请使用独立文件或 --auth-reset');
    return saved;
}

export async function restoreSessionStorage(context, saved, config) {
    if (!config.authSessionStorage || !saved?.sessionStorage) return;
    await context.addInitScript(
        ({ origin, entries }) => {
            if (location.origin === origin && !sessionStorage.getItem('__laya_auth_restored__')) {
                for (const [key, value] of Object.entries(entries))
                    sessionStorage.setItem(key, value);
                sessionStorage.setItem('__laya_auth_restored__', '1');
            }
        },
        { origin: saved.origin, entries: saved.sessionStorage },
    );
}

export async function saveAuthState(context, page, config) {
    if (!config.authState) return;
    if (new URL(page.url()).origin !== new URL(config.url).origin)
        throw Error('登录后未返回目标站点，不保存登录态');
    const storageState = await context.storageState({ indexedDB: true });
    if (config.recordedLogin) {
        const { origin, hostname } = new URL(config.url);
        storageState.origins = storageState.origins.filter((item) => item.origin === origin);
        storageState.cookies = storageState.cookies.filter((cookie) => {
            const domain = cookie.domain.replace(/^\./, '');
            return (
                hostname === domain ||
                (cookie.domain.startsWith('.') && hostname.endsWith('.' + domain))
            );
        });
    }
    const sessionStorage = config.authSessionStorage
        ? await page.evaluate(
              (origin) =>
                  location.origin === origin
                      ? Object.fromEntries(
                            Object.entries(window.sessionStorage).filter(
                                ([key]) =>
                                    key !== '__laya_auth_restored__' &&
                                    !/^__layaRecord_.*_toolbarBottom$/.test(key),
                            ),
                        )
                      : null,
              new URL(config.url).origin,
          )
        : undefined;
    if (new URL(page.url()).origin !== new URL(config.url).origin || sessionStorage === null)
        throw Error('登录态保存期间站点已改变。');
    if (
        config.recordedLogin &&
        !storageState.cookies.length &&
        !storageState.origins.some((item) => item.localStorage?.length || item.indexedDB?.length) &&
        !Object.keys(sessionStorage || {}).length
    )
        return false;
    writePrivateJson(path.resolve(config.authState), {
        schemaVersion: 1,
        origin: new URL(config.url).origin,
        account: config.authAccount ?? config.user ?? '',
        ...(config.recordedLogin && { recordedLogin: config.recordedLogin }),
        savedAt: new Date().toISOString(),
        storageState,
        ...(sessionStorage ? { sessionStorage } : {}),
    });
    return true;
}

export async function ensureAuthentication(page, config, readSecret, chooseTarget, restored) {
    if (config.manualLogin && config.headless) throw Error('手动登录需要可见浏览器');
    const loginEntry =
        !config.authState && /\/(?:login|signin|sign-in)\/?$/i.test(new URL(config.url).pathname);
    const passwordVisible = () => page.locator('input[type="password"]:visible').count();
    const check = async () => {
        if (await passwordVisible()) return false;
        const expected = new URL(config.url),
            actual = new URL(page.url());
        if (expected.origin !== actual.origin || expected.pathname !== actual.pathname)
            return false;
        if (config.authCheck) {
            const marker = page.locator(config.authCheck);
            return (await marker.count()) === 1 && (await marker.isVisible());
        }
        return true;
    };
    if (restored && config.authCheck) {
        // Let hydration either show the authenticated marker or redirect to login.
        await Promise.race([
            page
                .locator(config.authCheck)
                .waitFor({ state: 'visible', timeout: config.pageTimeout }),
            page
                .locator('input[type="password"]:visible')
                .first()
                .waitFor({ timeout: config.pageTimeout }),
        ]).catch(() => {});
    }
    if (restored && (await check())) return 'reused';
    const account = config.authAccount || config.user;
    const credentials =
        !config.manualLogin && !config.authReset && config.credentialRoot && account
            ? await loadLoginCredentials(config.credentialRoot, config.url, account)
            : null;
    if (credentials?.landingUrl && credentials.check) {
        config.url = credentials.landingUrl;
        config.authCheck ||= credentials.check;
        config.recordedLogin ||= {
            loginUrl: credentials.loginUrl,
            landingUrl: credentials.landingUrl,
            check: credentials.check,
        };
    }
    let submitted;
    if (config.manualLogin) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            await rl.question('请在浏览器登录并打开目标模块，回车继续：', {
                signal: config.signal,
            });
        } finally {
            rl.close();
        }
    } else if (credentials || config.user) {
        if (credentials)
            console.log('AUTH 登录态需要更新，正在使用此站点和账号的已保存凭据重新登录。');
        submitted = await submitLogin(page, config, credentials, readSecret, chooseTarget);
    } else if (restored) {
        if (await passwordVisible())
            throw Error(
                '已加载此站点的登录态，但页面仍显示登录密码框，当前会话可能已失效。请使用 --manual-login 或 --user 重新登录。',
            );
        throw Error(
            '已加载的登录态未通过目标页面或 --auth-check 校验。请确认目标页面和登录标记，或使用 --manual-login 重新登录。',
        );
    } else if (await passwordVisible()) {
        throw Error(
            '当前在登录页，本次未加载可用的站点登录态。请在录制浏览器中登录一次，或使用 --manual-login。',
        );
    }
    if (
        loginEntry &&
        !credentials?.landingUrl &&
        new URL(page.url()).origin === new URL(config.url).origin &&
        !(await passwordVisible())
    )
        config.url = page.url();
    if (page.url() !== config.url) await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    await waitForReady(page, { timeout: config.pageTimeout });
    if (config.authCheck)
        await page
            .locator(config.authCheck)
            .waitFor({ state: 'visible', timeout: config.pageTimeout });
    if (!(await check())) throw Error('登录后目标页面或 --auth-check 未通过，不保存登录态');
    if (submitted && config.credentialRoot) {
        await saveLoginCredentials(config.credentialRoot, config.url, submitted.account, {
            ...submitted,
            landingUrl: page.url(),
            ...(config.authCheck && { check: config.authCheck }),
        });
        config.authAccount = submitted.account;
        console.log('AUTH 登录已验证，已更新此站点和账号的本地凭据。');
    }
    return submitted || config.manualLogin ? 'logged-in' : 'not-required';
}
