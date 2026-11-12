import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';

test('required-only cases assert the first value before the next case types', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-boundary-replay-'));
    const workbook = path.join(directory, 'cases.xlsx');
    const written = spawnSync(
        python,
        [
            '-c',
            `
from openpyxl import Workbook
from pathlib import Path
book = Workbook()
sheet = book.active
sheet.append(["用例编号", "用例名称", "前置条件", "测试数据", "测试步骤", "预期结果"])
sheet.append([None, None, None, None, "在“姓名”输入“甲”", "“姓名”的值为“甲”"])
sheet.append([None, None, None, None, "在“姓名”输入“乙”", "“姓名”的值为“乙”"])
book.save(Path(${JSON.stringify(workbook)}))
book.close()
`,
        ],
        { encoding: 'utf8' },
    );
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const imported = spawnSync(python, [path.join(root, 'scripts/worker.py')], {
        input: JSON.stringify({ id: 1, action: 'read_excel', path: workbook }) + '\n',
        encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    const { cases, warnings } = JSON.parse(imported.stdout);
    assert.equal(warnings.length, 0);
    assert.deepEqual(
        cases.map((item) => item.steps),
        ['在“姓名”输入“甲”', '在“姓名”输入“乙”'],
    );

    const out = path.join(directory, 'out');
    await fs.mkdir(path.join(out, 'evidence'), { recursive: true });
    const server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><label for="name">姓名</label><input id="name">');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            channel: 'chrome',
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        const engine = new Engine(
            page,
            {
                choose: async (_state, criteria) => {
                    const choice = Object.keys(criteria).find(
                        (key) => !['停止', 'Stop'].includes(key),
                    );
                    const rest = Object.keys(criteria).filter((key) => key !== choice);
                    return {
                        choice,
                        probabilities: {
                            [choice]: 0.98,
                            ...Object.fromEntries(rest.map((key) => [key, 0.02 / rest.length])),
                        },
                        margin: 0.96,
                    };
                },
            },
            {
                url,
                origins: [new URL(url).origin],
                out,
                data: {},
                runId: 'boundary',
                maxSteps: 10,
                assertTimeout: 1000,
                pageTimeout: 8000,
                delay: 0,
            },
        );
        const results = [];
        for (const item of cases) results.push(await engine.runCase(item));
        const timeline = results.flatMap((result) => [
            ...result.actions
                .filter((action) => action.action === 'fill')
                .map((action) => `fill:${action.text}`),
            ...result.assertions.map(
                (assertion) => `assert:${assertion.text}:${assertion.actual}:${assertion.status}`,
            ),
        ]);
        assert.deepEqual(timeline, [
            'fill:在“姓名”输入“甲”',
            'assert:“姓名”的值为“甲”:甲:通过',
            'fill:在“姓名”输入“乙”',
            'assert:“姓名”的值为“乙”:乙:通过',
        ]);
        assert.deepEqual(
            results.map((result) => result.id),
            ['Sheet-2', 'Sheet-3'],
        );
        assert.equal(
            results[0].actions.some((action) => action.text.includes('乙')),
            false,
        );
        const shots = await Promise.all(
            results.map(async (result) => {
                const file = path.join(out, result.screenshot);
                const stat = await fs.stat(file);
                assert.ok(stat.size > 0, result.screenshot);
                return result.screenshot;
            }),
        );
        assert.equal(new Set(shots).size, 2);
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
