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
  // 登录态复用：存在 .laya-auth/<hash>.json 则注入（免登录，绕开限流与重复登录开销）。
  // --no-auth-reuse 显式禁用：访客视角走查公开页时必须用干净会话，否则缓存登录态会污染结果。
  const {createHash} = await import('node:crypto');
  const {existsSync} = await import('node:fs');
  const authFile = config.user && !config.noAuthReuse ? '.laya-auth/' + createHash('sha256').update(String(config.user)).digest('hex').slice(0, 16) + '.json' : '';
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 }, locale: 'zh-CN', acceptDownloads: true, ...(authFile && existsSync(authFile) ? {storageState: authFile} : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  // 原生 confirm()/alert() 默认会被 Playwright 自动取消，导致删除类操作静默失败；
  // 测试自动化语义下统一接受
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // 非 GET 的 4xx/5xx 直接打到控制台：写场景失败时能立刻看到后端拒绝原因
  page.on('response', (r) => {
    if (r.request().method() !== 'GET' && r.status() >= 400) {
      console.log(`[API-ERR] ${r.request().method()} ${r.status()} ${r.url().slice(0, 120)}`);
    }
  });
  return { browser, context, page };
}
