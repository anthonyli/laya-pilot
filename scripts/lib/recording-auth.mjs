import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { saveAuthState } from './auth-state.mjs';
import { saveLoginCredentials } from './credentials.mjs';

const passwordHints = ['id', 'name', 'placeholder', 'aria-label'].flatMap((attribute) =>
    ['password', 'passwd', '密码', '口令'].map((word) => `[${attribute}*="${word}" i]`),
);
export const loginPasswordSelector = [
    'input[type=password]',
    'input[autocomplete~="current-password" i]',
    `input:is([type=text],:not([type])):is(${passwordHints.join(',')})`,
].join(',');

const digest = (value) => createHash('sha256').update(value).digest('hex');
function authDirectory(root, url) {
    return path.join(root, '.auth', 'recordings', digest(new URL(url).origin));
}

export async function findRecordingAuth(root, url, user = '') {
    if (!root || !url) return null;
    const dir = authDirectory(root, url);
    const files = await fs.readdir(dir).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const matches = files.filter(
        (name) => /^[0-9a-f]{64}\.json$/.test(name) && (!user || name === digest(user) + '.json'),
    );
    if (!matches.length) return null;
    if (matches.length > 1) throw Error('此站点保存了多个账号，请用 --user 选择本次账号。');
    const authState = path.join(dir, matches[0]);
    let saved;
    try {
        saved = JSON.parse(await fs.readFile(authState, 'utf8'));
    } catch {
        throw Error('此站点的登录态文件无法读取，请使用 --auth-reset 重新登录。');
    }
    const info = saved?.recordedLogin;
    if (
        !info ||
        saved.schemaVersion !== 1 ||
        !Array.isArray(saved.storageState?.cookies) ||
        !Array.isArray(saved.storageState?.origins) ||
        typeof saved.account !== 'string' ||
        matches[0] !== digest(saved.account) + '.json' ||
        saved.origin !== new URL(url).origin ||
        [info.loginUrl, info.landingUrl].some(
            (address) => !URL.canParse(address) || new URL(address).origin !== saved.origin,
        ) ||
        typeof info.check !== 'string' ||
        !info.check
    )
        throw Error('此站点的录制登录态信息无效，请使用 --auth-reset 重新登录。');
    return { authState, account: saved.account, info };
}

export function authRoute(address) {
    const url = new URL(address);
    const hashRoute = /^#!?\//.test(url.hash) ? url.hash.split('?')[0] : '';
    return url.origin + url.pathname + hashRoute;
}

export async function rememberRecordingAuth(
    root,
    context,
    page,
    login,
    configuredCheck,
    isCurrent = () => true,
    { interactive = false, stateFile } = {},
) {
    if (!login || (!login.account && !interactive) || !root || page.isClosed()) return false;
    const origin = new URL(login.url).origin;
    const proof = await page
        .evaluate(
            ({ origin, configuredCheck, publicLabels, loginPasswordSelector }) => {
                if (location.origin !== origin) return null;
                const visible = (element) =>
                    element.getClientRects().length &&
                    getComputedStyle(element).visibility !== 'hidden';
                if (
                    [
                        ...document.querySelectorAll(
                            loginPasswordSelector + ',input[autocomplete~=one-time-code i]',
                        ),
                    ].some(visible)
                )
                    return null;
                const rejected =
                    /invalid credentials|incorrect (?:password|credentials)|authentication failed|login failed|access denied|unauthorized|登录失败|密码错误|账号或密码错误/i;
                if (
                    [...document.querySelectorAll('[role=alert],h1,h2,[role=heading]')].some(
                        (el) => visible(el) && rejected.test(el.innerText || el.textContent),
                    )
                )
                    return null;
                const checks = [];
                if (configuredCheck) checks.push(configuredCheck);
                else {
                    for (const el of document.querySelectorAll(
                        'nav a[href],a[href],[role=tab],h1,h2,[role=heading],button',
                    )) {
                        const label = (
                            el.getAttribute('aria-label') ||
                            el.textContent ||
                            ''
                        ).trim();
                        if (
                            !visible(el) ||
                            el.closest('[data-laya-recording-tools]') ||
                            !label ||
                            label.length > 80 ||
                            publicLabels.includes(label) ||
                            /login|sign in|password|登录|密码|error|错误|验证码/i.test(label)
                        )
                            continue;
                        const role =
                            el.getAttribute('role') ||
                            { A: 'link', H1: 'heading', H2: 'heading', BUTTON: 'button' }[
                                el.tagName
                            ];
                        if (role) {
                            checks.push('role=' + role + '[name=' + JSON.stringify(label) + 's]');
                            if (checks.length === 24) break;
                        }
                    }
                }
                return { checks: [...new Set(checks)], landingUrl: location.href };
            },
            {
                origin,
                configuredCheck,
                publicLabels: login.publicLabels || [],
                loginPasswordSelector,
            },
        )
        .catch(() => null);
    if (!proof) return false;
    let check;
    for (const candidate of proof.checks) {
        const locator = page.locator(candidate);
        if ((await locator.count()) === 1 && (await locator.isVisible())) {
            check = candidate;
            break;
        }
    }
    if (!check) return false;
    const info = { loginUrl: authRoute(login.url), landingUrl: authRoute(proof.landingUrl), check };
    if (page.url() !== proof.landingUrl || !(await isCurrent())) return false;
    const authState =
        stateFile || path.join(authDirectory(root, login.url), digest(login.account) + '.json');
    const saved = await saveAuthState(context, page, {
        url: login.url,
        user: login.account,
        authState,
        authSessionStorage: true,
        recordedLogin: info,
        validateBeforeSave: async () => page.url() === proof.landingUrl && (await isCurrent()),
    });
    if (saved && login.credentials && (await isCurrent()) && page.url() === proof.landingUrl) {
        await saveLoginCredentials(root, login.url, login.account, {
            ...login.credentials,
            loginUrl: info.loginUrl,
            landingUrl: info.landingUrl,
            check: info.check,
        });
    }
    return saved;
}
