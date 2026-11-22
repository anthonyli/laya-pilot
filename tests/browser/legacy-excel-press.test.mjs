import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const target = '按下 ArrowDown（角色 textbox 名称精确匹配「Second」）';

test('legacy Playwright spec and exported Excel send the key to the same control', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-legacy-press-'));
    const server = http.createServer((request, response) => {
        if (request.url === '/api/key-check') {
            response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
            <input aria-label="First" autofocus>
            <input aria-label="Second" onkeydown="if (event.key === 'ArrowDown') fetch('/api/key-check').then(() => this.value = 'received')">
            <input aria-label="Second choice">`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(cwd, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const spec = 'legacy.spec.cjs';
    const workbook = 'legacy.xlsx';
    await fs.writeFile(
        path.join(cwd, spec),
        `const { test, expect } = require('playwright/test');
test('press a key in the second input', async ({ page }) => {
    await page.goto(${JSON.stringify(url)});
    await page.getByRole('textbox', { name: 'Second', exact: true }).press('ArrowDown');
    await expect(page.getByRole('textbox', { name: 'Second', exact: true })).toHaveValue('received');
});`,
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(LAYA_|TEST_|BROWSER_)/.test(key)),
    );
    env.LAYA_HOME = path.join(cwd, 'state');
    env.PYTHONPATH = path.join(root, 'tests/fixtures/local-model');
    const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
    const laya = (...args) =>
        exec(process.execPath, [path.join(root, 'bin/laya.mjs'), ...args], { cwd, env });
    await laya('replay', spec, '--out', 'playwright');
    await laya('export-excel', spec, '--out', workbook, '--python', python);
    await laya(
        'replay',
        workbook,
        '--url',
        url,
        '--python',
        python,
        '--provider',
        'local',
        '--lazy-model',
        '--headless',
        '--delay',
        '0',
        '--out',
        'excel',
    ).catch((error) => assert.fail(`${error.stdout}\n${error.stderr}`));
    const results = JSON.parse(await fs.readFile(path.join(cwd, 'excel/results.json'), 'utf8'));
    assert.equal(results.results[0].status, '通过');
});

test('targeted key delivery stops on missing, ambiguous or unfocusable targets', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const engine = new Engine(page, {}, { maxSteps: 10, pageTimeout: 1000, delay: 0 });
    for (const [controls, category] of [
        ['', '按键目标不明确'],
        ['<input aria-label="Second"><input aria-label="Second">', '按键目标不明确'],
        ['<input aria-label="Second" disabled>', '按键目标无法聚焦'],
    ]) {
        await page.setContent('<input autofocus onkeydown="this.value = event.key">' + controls);
        await assert.rejects(engine.step(target), { category });
        assert.equal(await page.locator('input').first().inputValue(), '');
    }
    await assert.rejects(engine.step(target.replace('ArrowDown', 'Enter')), {
        category: '写入未启用',
    });
    await page.locator('input').first().focus();
    await engine.step('按下 ArrowDown');
    assert.equal(await page.locator('input').first().inputValue(), 'ArrowDown');
});
