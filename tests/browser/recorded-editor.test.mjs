import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { Engine } from '../../scripts/lib/engine.mjs';
import { lines } from '../../scripts/lib/language.mjs';
import { replayEditorOperation } from '../../scripts/lib/recorded-editor.mjs';

test('records and replays a click in the blank Monaco editing surface before typing @', async (t) => {
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
            <div class="monaco-editor" style="position:relative">
              <div class="margin-view-overlays"><div style="top:0"><span class="line-numbers">01</span></div></div>
              <div class="monaco-scrollable-element" style="width:400px;height:160px">
                <div class="lines-content" style="height:100%" onclick="document.querySelector('textarea').focus()">
                  <div class="view-lines"><div class="view-line" style="top:0;height:24px"><span><span></span></span></div></div>
                </div>
              </div>
              <textarea class="inputarea" aria-label="Editor content" style="position:absolute;top:20px;left:1px;width:2px;height:18px"></textarea>
            </div>`),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    const captured = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.locator('.inputarea').click();
            await page.locator('.lines-content').click({ position: { x: 90, y: 35 } });
            await page.keyboard.type('@');
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const operations = captured.actions.filter((a) => a.kind !== 'goto').map((a) => a.operation);
    const cursor = { type: 'cursor', from: { line: 1, column: 1 } };
    assert.deepEqual(operations, [cursor, cursor, { type: 'text', value: '@' }]);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    for (const op of operations) await replayEditorOperation(page, op);
    assert.equal(await page.locator('textarea').inputValue(), '@');
});

test('records Monaco selections, keystrokes, tree paths and a suggestion removed on mousedown', async (t) => {
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
        <div role="tree"><div role="treeitem" aria-expanded="false">
          <button class="ant-tree-switcher" onclick="this.parentElement.setAttribute('aria-expanded','true');this.nextElementSibling.nextElementSibling.hidden=false">+</button>
          <span class="ant-tree-node-content-wrapper"><span class="ant-tree-title">Arrays</span></span>
          <div role="group" hidden><div role="treeitem"><button class="ant-tree-node-content-wrapper" onclick="document.body.dataset.leaf='yes'"><span class="ant-tree-title">Add Element</span></button></div></div></div></div>
        <div class="monaco-editor">
          <div class="margin-view-overlays"><div style="top:0"><span class="line-numbers">1</span></div></div>
          <div class="lines-content"><div class="view-lines"><div class="view-line" style="top:0;font:20px monospace"><span>abcdef</span></div></div></div>
          <textarea class="inputarea" aria-label="Editor content"></textarea>
          <div class="suggest-widget visible"><div role="option" class="monaco-list-row" onmousedown="document.body.dataset.pick='editor';this.remove()"><span class="label-name">Remarks</span></div></div>
        </div><button onclick="document.body.dataset.pick='wrong'">Remarks</button>`),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const captured = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            await page.locator('.ant-tree-switcher').click();
            await page.getByText('Add Element', { exact: true }).click();
            const coords = await page.locator('.view-line span').evaluate((el) =>
                [1, 4].map((offset) => {
                    const range = document.createRange();
                    range.setStart(el.firstChild, offset);
                    range.collapse(true);
                    const box = range.getBoundingClientRect();
                    return { x: box.left, y: box.top + box.height / 2 };
                }),
            );
            await page.mouse.move(coords[0].x, coords[0].y);
            await page.mouse.down();
            await page.mouse.move(coords[1].x, coords[1].y);
            await page.mouse.up();
            await page.locator('textarea').focus();
            await page.keyboard.type('abc');
            await page.keyboard.press('Backspace');
            await page.keyboard.insertText('甲乙');
            await page.locator('.label-name').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    assert.deepEqual(
        captured.actions.filter((a) => a.kind !== 'goto').map((a) => a.operation),
        [
            { type: 'tree', path: ['Arrays'], part: 'toggle', expanded: true },
            { type: 'tree', path: ['Arrays', 'Add Element'], part: 'title' },
            { type: 'cursor', from: { line: 1, column: 2 }, to: { line: 1, column: 5 } },
            { type: 'text', value: 'abc' },
            { type: 'key', key: 'Backspace' },
            { type: 'text', value: '甲乙', input: 'insert' },
            { type: 'suggest', name: 'Remarks' },
        ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 890, height: 560 } });
    const result = async () => {
        assert.equal(await page.locator('textarea').inputValue(), 'ab甲乙');
        assert.equal(await page.locator('body').getAttribute('data-leaf'), 'yes');
        assert.equal(await page.locator('body').getAttribute('data-pick'), 'editor');
    };
    await page.goto(url);
    const engine = new Engine(page, null, {
        url,
        origins: [new URL(url).origin],
        maxSteps: 12,
        pageTimeout: 1500,
        delay: 0,
    });
    const steps = lines(generateRecordedCases(captured).cases[0].steps);
    for (const step of steps.slice(1)) await engine.step(step);
    await result();
    let run;
    new Function('require', renderRecordingSpec(captured))(() => ({
        test: (_, fn) => {
            run = fn;
        },
    }));
    await run({ page });
    await result();
});
