import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';
import { lines } from '../../scripts/lib/language.mjs';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';

test('replays a click on card content by its unique visible title in the drawer', async (t) => {
    const html = `<style>.item {cursor:pointer}</style><h2>Count [events]</h2>
        <div role="dialog">
            <div class="item" onclick="document.body.dataset.chosen='count'">
                <div class="title"><span>Count [events]</span></div><p>Choose this description</p>
            </div>
            <div class="item"><div class="title">Same</div><p>Duplicate A</p></div>
            <div class="item"><div class="title">Same</div><p>Duplicate B</p></div>
            <div class="item"><div class="title">Mixed</div><p>Nested actions</p><button>More</button></div>
        </div>`;
    const server = http.createServer((_, res) =>
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(html),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const recording = await captureRecording({
        url,
        playwright: { chromium },
        headless: true,
        async onReady(page) {
            for (const text of ['Duplicate B', 'Nested actions', 'Choose this description'])
                await page.getByText(text, { exact: true }).click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    const actions = recording.actions.filter((action) => action.kind !== 'goto');
    assert.deepEqual(
        actions.map((action) => action.kind),
        ['unsupported', 'unsupported', 'click'],
    );
    const step = '在弹窗中点击标题为「Count [events]」的卡片';
    assert.equal(lines(generateRecordedCases(recording).cases[0].steps).at(-1), step);
    assert.match(
        renderRecordingSpec(recording),
        /await findDialogCard\(page\.locator\(.+"Count \[events\]"/,
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    const engine = new Engine(page, null, { delay: 0, pageTimeout: 1000 });
    await engine.step(step);
    assert.equal(await page.locator('body').getAttribute('data-chosen'), 'count');
    await assert.rejects(engine.step('在弹窗中点击标题为「Same」的卡片'), /无法唯一定位/);
});
