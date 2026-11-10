import { loadAuthState, restoreSessionStorage } from './auth-state.mjs';
// Keep the browser boundary in one place. A future driver must provide the
// page/context methods used by the engines before it can be selected here.
export async function openBrowser(config) {
    if (config.browserProvider !== 'playwright') {
        throw new Error(
            `Unsupported browser provider: ${config.browserProvider}. Currently supported: playwright`,
        );
    }
    const auth = await loadAuthState(config);
    const { chromium } = await import('playwright');
    const options = { headless: config.headless };
    if (config.browserChannel) options.channel = config.browserChannel;
    const browser = await chromium.launch(options);
    try {
        const context = await browser.newContext({
            ...(auth ? { storageState: auth.storageState } : {}),
            viewport: { width: 1500, height: 980 },
            locale: 'zh-CN',
            acceptDownloads: true,
        });
        await restoreSessionStorage(context, auth, config);
        const page = await context.newPage();
        page.setDefaultTimeout(9000);
        page.setDefaultNavigationTimeout(config.pageTimeout || 18000);
        return { browser, context, page, authRestored: !!auth };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
