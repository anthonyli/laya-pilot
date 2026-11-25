import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { finalizeRun } from '../../scripts/lib/run-index.mjs';

test('local report opens screenshot evidence in place and returns focus on close', async (t) => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-report-viewer-'));
    t.after(() => fs.rm(out, { recursive: true, force: true }));
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const files = ['步骤 1.png', 'final.png', '运行失败.png'];
    const png = await page.screenshot();
    for (const file of files) await fs.writeFile(path.join(out, file), png);
    await fs.writeFile(
        path.join(out, 'results.json'),
        JSON.stringify({
            error: { message: '运行失败', screenshot: files[2] },
            results: [
                {
                    id: '001',
                    title: '新增配置',
                    status: '失败',
                    screenshot: files[1],
                    evidence: [{ phase: 'step', index: 1, status: '通过', screenshot: files[0] }],
                },
            ],
        }),
    );
    await finalizeRun(out, out);
    const url = pathToFileURL(path.join(out, 'index.html')).href;
    await page.goto(url);
    const dialog = page.getByRole('dialog');
    for (const [i, file] of files.entries()) {
        const button = page
            .getByRole('button', { name: /^放大查看/ })
            .and(page.locator(`[data-shot="${encodeURIComponent(file)}"]`));
        await button.focus();
        await page.keyboard.press('Enter');
        await dialog.waitFor();
        const image = dialog.locator('img');
        await image.evaluate((el) => el.decode());
        assert.equal(await image.getAttribute('src'), encodeURIComponent(file));
        assert.equal(page.url(), url);
        assert.equal(page.context().pages().length, 1);
        if (i === 0) await page.keyboard.press('Escape');
        else if (i === 1) await page.mouse.click(1, 1);
        else await dialog.getByRole('button', { name: '关闭大图' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.ok(await button.evaluate((el) => document.activeElement === el));
    }
});
