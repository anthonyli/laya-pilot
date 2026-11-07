import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Engine } from '../../lib/engine.mjs';
import { expectation } from '../../lib/language.mjs';

test('button expectation enforces role even with same-name controls', async () => {
    assert.equal(expectation('页面显示「保存」按钮').role, 'button');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const engine = new Engine(page, {}, {});
        for (const [html, expected] of [
            ['<label>保存<input></label>', false],
            ['<a href="/">保存</a>', false],
            ['<button>保存</button>', true],
            ['<input type=button value=保存>', true],
            ['<input type=submit value=保存>', true],
            ['<input type=reset value=保存>', true],
            ['<div role=button>保存</div>', true],
            ['<span tabindex=0 aria-label=保存>保存</span>', false],
            ['<div contenteditable=true aria-label=保存>保存</div>', false],
            ['<button hidden>保存</button>', false],
            ['<label>保存<input></label><a href="/">保存</a>', false],
            ['<label>保存<input></label><a href="/">保存</a><button>保存</button>', true],
            ['<button>保存</button><button>保存</button>', false],
        ]) {
            await page.setContent(html);
            const result = await engine.verify('页面显示「保存」按钮');
            assert.equal(result.status === '通过', expected, html + JSON.stringify(result));
        }
    } finally {
        await browser.close();
    }
});
