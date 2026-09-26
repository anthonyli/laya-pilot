// 探针：打开目标页，复用登录态，打印 observe() 的控件清单（role/name/placeholder/context）
// 用途：为手写 laya 用例提供精确的 target.name
import {openBrowser} from './lib/browser-provider.mjs';
import {observe} from './lib/dom.mjs';
import {waitForReady} from './lib/readiness.mjs';

const [, , url, clickName] = process.argv;
if (!url) throw new Error('usage: node probe_controls.mjs <url>');
const {browser, context, page} = await openBrowser({
  browserProvider: 'playwright', headless: true, browserChannel: 'msedge',
});
try {
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await waitForReady(page, {timeout: 30000});
  // 登录态失效：填表登录（用超管账号）
  if (/login/.test(page.url())) {
    const user = process.env.TEST_USER || 'superadmin@qq.com';
    const pass = process.env.TEST_PASSWORD || '123456';
    const emailBox = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
    await emailBox.waitFor({timeout: 10000});
    await emailBox.fill(user);
    await page.locator('input[type="password"]:visible').first().fill(pass);
    await page.locator('button:visible', {hasText: /登录|login/i}).first().click();
    await waitForReady(page, {timeout: 30000});
    if (!/super-admin/.test(page.url())) await page.goto(url, {waitUntil: 'domcontentloaded'});
    await waitForReady(page, {timeout: 30000});
  }
  // SPA 偶发把深链弹回 dashboard：再 goto 一次目标页
  if (!page.url().includes(new URL(url).pathname)) {
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    await waitForReady(page, {timeout: 30000});
  }
  await page.waitForTimeout(1500);
  let snap = await observe(page);
  if (clickName) {
    const btn = snap.controls.find((c) => c.name === clickName && c.role === 'button');
    if (!btn) throw new Error('找不到按钮：' + clickName);
    await page.locator(`[data-laya-live-ref="${btn.ref}"]`).click();
    await page.waitForTimeout(1200);
    snap = await observe(page);
  }
  const interesting = snap.controls.filter((c) =>
    ['button', 'link', 'textbox', 'spinbutton', 'combobox', 'checkbox', 'tab', 'menuitem'].includes(c.role));
  console.log('URL:', page.url());
  console.log('controls:', interesting.length);
  for (const c of interesting) {
    console.log(JSON.stringify({role: c.role, name: c.name, placeholder: c.placeholder, disabled: c.disabled, context: (c.context || '').slice(0, 60)}));
  }
  // 若在登录页，打印提示
  if (page.url().includes('login')) console.log('!! AT LOGIN PAGE — 登录态失效，请先手动跑一次回放重建登录态');
} finally {
  await browser.close().catch(() => {});
}
