import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { writePrivateJson } from './run-state.mjs';
import { waitForReady, switchLanguage } from './readiness.mjs';

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
        saved.account !== (config.user || '') ||
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
    const sessionStorage = config.authSessionStorage
        ? await page.evaluate(() =>
              Object.fromEntries(
                  Object.entries(window.sessionStorage).filter(
                      ([key]) => key !== '__laya_auth_restored__',
                  ),
              ),
          )
        : undefined;
    writePrivateJson(path.resolve(config.authState), {
        schemaVersion: 1,
        origin: new URL(config.url).origin,
        account: config.user || '',
        savedAt: new Date().toISOString(),
        storageState,
        ...(sessionStorage ? { sessionStorage } : {}),
    });
}

export async function ensureAuthentication(page, config, readSecret, chooseTarget, restored) {
    if (config.manualLogin && config.headless) throw Error('手动登录需要可见浏览器');
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
    if (config.manualLogin) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            await rl.question('请在浏览器登录并打开目标模块，回车继续：', {
                signal: config.signal,
            });
        } finally {
            rl.close();
        }
    } else if (config.user) {
        await page.locator('input[type="password"]:visible').first().waitFor({ timeout: 30000 });
        await switchLanguage(page, config.language === 'auto' ? 'zh-CN' : config.language);
        const accountName =
            /^(?:(?:请输入|请填写)\s*)?(?:登录)?(?:账号|账户|用户名|邮箱)$|^(account|username|email)$/i;
        const accounts = page
            .getByRole('textbox', { name: accountName })
            .or(page.getByPlaceholder(accountName))
            .filter({ visible: true });
        const account =
            (await accounts.count()) === 1 && (await accounts.isVisible())
                ? { locator: accounts }
                : await chooseTarget('账号 Account Username', 'fill');
        const password = await readSecret();
        await account.locator.fill(config.user);
        const passwords = page.locator('input[type="password"]:visible');
        if ((await passwords.count()) !== 1)
            throw Error('登录页密码框不唯一，请使用 --manual-login');
        await passwords.fill(password);
        // A fresh observation replaces live refs; finish filling before resolving
        // another target so the account locator cannot become stale.
        const buttons = page.getByRole('button', { name: /^(登\s*录|login|log in|sign in)$/i });
        const login =
            (await buttons.count()) === 1 && (await buttons.isVisible())
                ? { locator: buttons }
                : await chooseTarget('登录 Login Sign in');
        await login.locator.click();
        await passwords.waitFor({ state: 'hidden', timeout: 30000 });
    } else if (restored || (await passwordVisible())) {
        throw Error('登录态已失效或仍在登录页，请提供 --user 或使用 --manual-login 重新登录');
    }
    if (page.url() !== config.url) await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    await waitForReady(page, { timeout: config.pageTimeout });
    if (config.authCheck)
        await page
            .locator(config.authCheck)
            .waitFor({ state: 'visible', timeout: config.pageTimeout });
    if (!(await check())) throw Error('登录后目标页面或 --auth-check 未通过，不保存登录态');
    return config.user || config.manualLogin ? 'logged-in' : 'not-required';
}
