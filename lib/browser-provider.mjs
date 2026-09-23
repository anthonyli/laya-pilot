// Keep the browser boundary in one place. A future driver must provide the
// page/context methods used by the engines before it can be selected here.
export async function openBrowser(config) {
  if (config.browserProvider !== 'playwright') {
    throw new Error(`Unsupported browser provider: ${config.browserProvider}. Currently supported: playwright`);
  }
  const { chromium } = await import('playwright');
  const options = { headless: config.headless };
  if (config.browserChannel) options.channel = config.browserChannel;
  const browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 }, locale: 'zh-CN', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  return { browser, context, page };
}
