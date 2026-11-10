import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';

test('evidence keeps distinct cases and unsafe names inside the evidence directory', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-evidence-'));
    const server = http.createServer((req, res) =>
        res.end(`<button>CONTROL_${req.url.slice(1)}</button>`),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
        await fs.mkdir(path.join(out, 'evidence'));
        const page = await browser.newPage();
        const engine = new Engine(
            page,
            {
                choose: async () => {
                    throw Error('unexpected model call');
                },
            },
            {
                url: base,
                origins: [base],
                out,
                data: {},
                runId: 'test',
                maxSteps: 10,
                assertTimeout: 100,
                pageTimeout: 2000,
                delay: 0,
            },
        );
        const cases = [
            ['a b', '001'],
            ['a_b', '001'],
            ['../a', '../../evil'],
            ['中文', '001'],
            ['a b', '001'],
        ];
        const paths = [];
        for (const [i, [sheet, id]] of cases.entries()) {
            const result = await engine.runCase({
                sheet,
                id,
                row: 2,
                key: `${sheet}:2`,
                title: 'fixture',
                steps: '观察页面',
                expected: '页面显示「NOT_PRESENT」',
                url: `${base}/${i}`,
                preconditions: '',
                data: '',
            });
            assert.equal(result.id, id);
            assert.match(result.screenshot, /^evidence\/case-[a-f0-9]{64}-\d+\.png$/);
            const controls = JSON.parse(
                await fs.readFile(
                    path.join(out, result.screenshot.replace('.png', '-controls.json')),
                ),
            );
            assert.ok(controls.controls.some((c) => c.name === `CONTROL_${i}`));
            assert.ok((await fs.stat(path.join(out, result.screenshot))).size > 0);
            paths.push(result.screenshot);
        }
        assert.equal(new Set(paths).size, cases.length);
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(out, { recursive: true, force: true });
    }
});
