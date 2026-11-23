import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';
import { lines } from '../../scripts/lib/language.mjs';
import { Laya } from '../../scripts/lib/model.mjs';
import { attachRecordedCases, exportRecording } from '../../scripts/lib/recorded-excel.mjs';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';

async function servePage(t, html) {
    const server = http.createServer((_, response) =>
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/`;
}

test('records classless ARIA comboboxes and replays only their owned portal options from Excel and standalone code', async (t) => {
    const html = `<!doctype html>
      <div role="dialog" aria-label="Channels">
        <button role="combobox" aria-label="Main channel" aria-controls="primary" aria-expanded="false">Choose</button>
        <label for="backup">Backup channel</label>
        <input role="combobox" id="backup" readonly aria-controls="secondary" aria-expanded="false">
      </div>
      <div id="unrelated" role="listbox"><button role="option">Shared value</button></div>
      <div id="primary" role="listbox" hidden>
        <button role="option" id="wrong-option" aria-label="Other value">Shared value</button>
        <button role="option">Shared value</button>
      </div>
      <span id="secondary-choice-name" hidden>Shared value</span>
      <div id="secondary" role="listbox" hidden><button role="option" aria-labelledby="secondary-choice-name">Choose</button></div>
      <script>
        for (const control of document.querySelectorAll('[role=combobox]')) {
          control.onclick = () => {
            document.getElementById(control.getAttribute('aria-controls')).hidden = false;
            control.setAttribute('aria-expanded', 'true');
          };
        }
        for (const option of document.querySelectorAll('[role=option]')) {
          option.onclick = () => {
            const current = document.body.dataset.picks;
            document.body.dataset.picks = [current, option.id || option.parentElement.id].filter(Boolean).join(',');
          };
        }
      </script>`;
    const url = await servePage(t, html);
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox', { name: 'Main channel' }).click();
            await page.locator('#primary').getByRole('option', { name: 'Shared value' }).click();
            await page.getByRole('combobox', { name: 'Backup channel' }).click();
            await page.locator('#secondary').getByRole('option').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-aria-select-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workbook = path.join(directory, 'channels.xlsx');
    const spec = path.join(directory, 'channels.spec.cjs');
    const source = renderRecordingSpec(recording);
    await fs.writeFile(spec, attachRecordedCases(source, generateRecordedCases(recording)));
    const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
    await exportRecording(spec, workbook, python);
    const laya = new Laya(
        python,
        fileURLToPath(new URL('../../scripts/worker.py', import.meta.url)),
    );
    t.after(() => laya.close());
    const { cases } = await laya.request({ action: 'read_excel', path: workbook });
    const steps = cases.flatMap((entry) => lines(entry.steps));
    assert.deepEqual(steps, [
        `打开网址 ${url}`,
        '在弹窗中点击「Main channel」字段的下拉框',
        '在弹窗的「Main channel」字段下拉框中点击「Shared value」选项',
        '在弹窗中点击「Backup channel」字段的下拉框',
        '在弹窗的「Backup channel」字段下拉框中点击「Shared value」选项',
    ]);

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        assertTimeout: 500,
    });
    for (const step of steps) await engine.step(step);
    assert.equal(await page.locator('body').getAttribute('data-picks'), 'primary,secondary');
    let run;
    new Function('require', source)(() => ({
        test: (_title, fn) => {
            run = fn;
        },
    }));
    await run({ page });
    assert.equal(await page.locator('body').getAttribute('data-picks'), 'primary,secondary');
});

test('keeps unnamed fields and ambiguous unowned options in sequence for review', async (t) => {
    const url = await servePage(
        t,
        `
        <input role="combobox" readonly>
        <div role="listbox"><div role="option">Shared</div></div>
        <div role="listbox"><div role="option">Shared</div></div>
        <button>Continue</button>`,
    );
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.getByRole('combobox').click();
            await page.getByRole('option').last().click();
            await page.getByRole('button', { name: 'Continue' }).click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const steps = generateRecordedCases(recording).cases.flatMap((entry) => lines(entry.steps));
    assert.equal(steps.length, 4);
    assert.match(steps[1], /待补录.*下拉框.*字段名称/);
    assert.match(steps[2], /待补录.*Shared.*无法确定所属字段/);
    assert.equal(steps[3], '点击「Continue」按钮');
});
