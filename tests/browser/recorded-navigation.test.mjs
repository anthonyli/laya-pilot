import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
    declaredIconName,
    findNamedIcon,
    iconOwner,
} from '../../scripts/lib/recorded-navigation.mjs';

test('waits for late SPA navigation icons and rejects duplicate visible matches', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const locate = () =>
        findNamedIcon(page, page.locator('nav'), 'Reports', iconOwner, declaredIconName, 3000);
    const icon = (name) =>
        `<button aria-label="${name}"><svg width="20" height="20"></svg></button>`;
    for (const existing of ['', icon('Overview')]) {
        await page.setContent(`<nav>${existing}</nav>`);
        await page.evaluate((markup) => {
            setTimeout(
                () => document.querySelector('nav').insertAdjacentHTML('beforeend', markup),
                350,
            );
        }, icon('Reports'));
        const target = await locate();
        assert.equal(await target.getAttribute('aria-label'), 'Reports');
        await target.dispose();
    }
    await page.setContent('<nav></nav>');
    await page.evaluate((markup) => {
        setTimeout(() => {
            document.querySelector('nav').innerHTML = markup;
        }, 350);
    }, icon('Reports').repeat(2));
    await assert.rejects(locate(), /找到 2 个匹配项/);
});
