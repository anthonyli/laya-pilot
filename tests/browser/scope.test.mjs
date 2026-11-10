import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Engine } from '../../lib/engine.mjs';

test('text assertions honor a unique dialog or list', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(
            '<p>保存成功</p><dialog open><p>操作失败</p></dialog><table><tbody><tr><td>列表内容</td></tr></tbody></table>',
        );
        const engine = new Engine(page, null, { assertTimeout: 50 });
        for (const [text, status] of [
            ['弹窗显示「保存成功」', '失败'],
            ['弹窗不显示「保存成功」', '通过'],
            ['弹窗显示「操作失败」', '通过'],
            ['弹窗不显示「操作失败」', '失败'],
            ['列表显示「列表内容」', '通过'],
            ['列表显示「保存成功」', '失败'],
            ['页面显示「保存成功」', '通过'],
        ])
            assert.equal((await engine.verify(text)).status, status, text);
        await page.evaluate(() => document.querySelector('dialog').remove());
        assert.equal((await engine.verify('弹窗不显示「保存成功」')).status, '未验证');
        await page.evaluate(() =>
            document.body.insertAdjacentHTML(
                'beforeend',
                '<dialog open>A</dialog><dialog open>B</dialog>',
            ),
        );
        assert.equal((await engine.verify('弹窗显示「A」')).status, '未验证');
    } finally {
        await browser.close();
    }
});
