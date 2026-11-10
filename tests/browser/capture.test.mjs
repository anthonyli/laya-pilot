import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { Engine } from '../../lib/engine.mjs';

test('capture succeeds or records failure without using a stale screenshot', async () => {
    await fs.mkdir('runs', { recursive: true });
    const out = await fs.mkdtemp(path.resolve('runs/capture-'));
    await fs.mkdir(path.join(out, 'evidence'));
    const server = http.createServer((req, res) => res.end('<button>CONTROL</button>'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const engine = new Engine(
            page,
            {},
            {
                url,
                origins: [url],
                out,
                data: {},
                runId: 'test',
                maxSteps: 10,
                assertTimeout: 100,
                pageTimeout: 2000,
                delay: 0,
            },
        );
        const c = {
            id: 'capture',
            row: 2,
            key: 'test:2',
            sheet: 'test',
            title: 'capture',
            steps: '观察页面',
            expected: '页面显示「NOT_PRESENT」',
            url,
            preconditions: '',
            data: '',
        };
        const success = await engine.runCase(c);
        assert.equal(success.status, '失败');
        assert.ok((await fs.stat(path.join(out, success.screenshot))).size > 0);
        const old = await fs.readFile(path.join(out, success.screenshot));
        let attemptedPath;
        page.screenshot = async ({ path: screenshotPath }) => {
            attemptedPath = screenshotPath;
            await fs.writeFile(attemptedPath, old);
            throw Error('injected failure');
        };
        const failure = await engine.runCase(c);
        assert.equal(failure.status, '失败');
        assert.equal(failure.screenshot, undefined);
        assert.match(failure.screenshot_error, /injected failure/);
        assert.deepEqual(await fs.readFile(path.join(out, success.screenshot)), old);
        assert.notEqual(attemptedPath, path.join(out, success.screenshot));
        assert.deepEqual(await fs.readFile(attemptedPath), old);
        const controls = JSON.parse(
            await fs.readFile(attemptedPath.replace(/\.png$/, '-controls.json')),
        );
        assert.ok(controls.controls.some((c) => c.name === 'CONTROL'));
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
