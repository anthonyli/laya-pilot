import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';

const ariaRows = `<div role="table" aria-label="客户">
  <div role="rowgroup">
    <div role="row"><span role="columnheader">名称</span></div>
  </div>
  <div role="rowgroup">
    <div role="row"><span role="cell">A</span></div>
  </div>
</div>`;
const emptyAria = `<div role="table" aria-label="客户">
  <div role="rowgroup">
    <div role="row"><span role="columnheader">名称</span></div>
  </div>
</div>`;
const nativeRows = `<table>
  <thead><tr><th>名称</th><th>状态</th></tr></thead>
  <tbody>
    <tr><th colspan="2">分组</th></tr>
    <tr><th scope="row">A</th><td>正常</td></tr>
  </tbody>
</table>`;
const emptyNative = `<table><thead><tr><th>名称</th></tr></thead><tbody></tbody></table>`;

async function expectCount(engine, html, cases) {
    await engine.page.setContent(html);
    for (const [text, status, actual] of cases) {
        const result = await engine.verify(text);
        assert.equal(result.status, status, text + ' ' + JSON.stringify(result));
        assert.equal(result.actual, actual, text + ' ' + JSON.stringify(result));
    }
}

test('rowcount counts ARIA data rows and refuses structures it cannot count', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const engine = new Engine(page, null, { assertTimeout: 80 });
        await expectCount(engine, ariaRows, [
            ['表格记录数为0', '失败', 1],
            ['表格记录数为1', '通过', 1],
            ['列表记录数为0', '失败', 1],
            ['列表记录数为1', '通过', 1],
        ]);
        await expectCount(engine, emptyAria, [
            ['表格记录数为0', '通过', 0],
            ['列表记录数为1', '失败', 0],
        ]);
        await expectCount(
            engine,
            `<div role="table" aria-label="客户" style="min-height:24px;min-width:80px"></div>`,
            [['表格记录数为0', '通过', 0]],
        );
        await expectCount(
            engine,
            `<div role="table" aria-label="客户">
              <div role="rowgroup">
                <div role="row"><span role="columnheader">名称</span><span role="columnheader">状态</span></div>
              </div>
              <div role="rowgroup">
                <div role="row"><span role="cell">A</span><span role="cell">正常</span></div>
                <div role="row"><span role="cell">B</span><span role="cell">停用</span></div>
              </div>
            </div>`,
            [
                ['表格记录数为2', '通过', 2],
                ['表格记录数为3', '失败', 2],
                ['表格记录数为4', '失败', 2],
            ],
        );
        await expectCount(
            engine,
            `<div role="table" aria-label="客户">
              <div role="row" hidden><span role="cell">隐藏</span></div>
              <div role="row"><span role="cell">A</span></div>
            </div>`,
            [['表格记录数为1', '通过', 1]],
        );
        await expectCount(
            engine,
            `<div role="table" aria-label="客户"><div role="row"><span role="gridcell">A</span></div></div>`,
            [['表格记录数为1', '通过', 1]],
        );
        await expectCount(engine, nativeRows, [
            ['表格记录数为0', '失败', 1],
            ['表格记录数为1', '通过', 1],
            ['表格记录数为2', '失败', 1],
        ]);
        await expectCount(engine, emptyNative, [
            ['表格记录数为0', '通过', 0],
            ['列表记录数为1', '失败', 0],
        ]);
        for (const html of [
            `<div role="table" aria-label="客户">客户 A</div>`,
            `<div role="table" aria-label="客户"><div role="rowgroup">客户 A</div></div>`,
            `<div role="table" aria-label="客户">客户 A<div role="row"><span role="cell">B</span></div></div>`,
            `<div role="table" aria-label="客户"><div role="rowgroup">客户 A<div role="row"><span role="cell">B</span></div></div></div>`,
            `<div role="table" aria-label="客户"><div class="row"><span>A</span></div></div>`,
            `<div role="table" aria-label="客户"><div role="row"><span>A</span></div></div>`,
        ]) {
            await engine.page.setContent(html);
            for (const text of ['表格记录数为0', '表格记录数为1']) {
                const result = await engine.verify(text);
                assert.equal(result.status, '未验证', text + ' ' + JSON.stringify(result));
                assert.equal(result.actual, undefined, text);
                assert.match(result.reason, /不能把未知结构当成0行/);
            }
        }
        await expectCount(
            engine,
            '<div role="table"><div role="caption"><span>客户列表</span></div><div role="rowgroup"></div></div>',
            [['表格记录数为0', '通过', 0]],
        );
        await engine.page.setContent('<div role="table"><div id="host"></div></div>');
        await page.locator('#host').evaluate((host) => {
            host.attachShadow({ mode: 'open' }).innerHTML = '<p>客户 A</p>';
        });
        const shadow = await engine.verify('表格记录数为0');
        assert.equal(shadow.status, '未验证');
        assert.equal(shadow.actual, undefined);
        await engine.page.setContent(
            '<table><tbody><tr><td>A</td></tr></tbody></table><table><tbody><tr><td>B</td></tr></tbody></table>',
        );
        const several = await engine.verify('表格记录数为0');
        assert.equal(several.status, '未验证');
        assert.equal(several.actual, undefined);
        assert.match(several.reason, /多个表格/);
        await engine.page.setContent('<p>没有表格</p>');
        const none = await engine.verify('列表记录数为0');
        assert.equal(none.status, '未验证');
        assert.equal(none.actual, undefined);

        // A tbody-only wait never matches an ARIA row, so it sits until assertTimeout.
        engine.config.assertTimeout = 4000;
        await engine.page.setContent(ariaRows);
        const started = Date.now();
        const waited = await engine.verify('表格记录数为1');
        const elapsed = Date.now() - started;
        assert.equal(waited.status, '通过', JSON.stringify(waited));
        assert.equal(waited.actual, 1);
        assert.ok(elapsed < 1500, `row wait fell through to the timeout (${elapsed}ms)`);

        await engine.page.setContent(emptyAria);
        const pending = engine.verify('列表记录数为1');
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const row = document.createElement('div');
            row.setAttribute('role', 'row');
            row.innerHTML = '<span role="cell">A</span>';
            document.querySelector('[role="table"]').appendChild(row);
        });
        const appeared = await pending;
        assert.equal(appeared.status, '通过', JSON.stringify(appeared));
        assert.equal(appeared.actual, 1);
    } finally {
        await browser.close();
    }
});

function pageHtml(body) {
    return `<!doctype html><meta charset="utf-8"><button type="button">刷新</button>${body}`;
}

test(
    'plain Excel CLI does not pass a zero-row assertion against a non-empty ARIA table',
    { timeout: 120000 },
    async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-rowcount-'));
        const workbook = path.join(directory, 'rowcount.xlsx');
        const output = path.join(directory, 'out');
        const server = http.createServer((req, res) => {
            if (req.url === '/favicon.ico') {
                res.writeHead(204).end();
                return;
            }
            const pages = {
                '/aria': pageHtml(ariaRows),
                '/empty': pageHtml(emptyAria),
                '/native': pageHtml(nativeRows),
                '/custom': pageHtml(
                    '<div role="table" aria-label="客户"><div class="row"><span>A</span></div></div>',
                ),
            };
            const body = pages[req.url];
            if (!body) {
                res.writeHead(404).end('missing');
                return;
            }
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(body);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const rows = [
                ['1', '非空ARIA表格不应被当成零记录', '查看页面', '表格记录数为0', `${base}/aria`],
                ['2', '非空ARIA表格记录数为1', '查看页面', '列表记录数为1', `${base}/aria`],
                ['3', '空ARIA表格记录数为0', '查看页面', '表格记录数为0', `${base}/empty`],
                ['4', '原生表格排除表头后记录数为1', '查看页面', '表格记录数为1', `${base}/native`],
                [
                    '5',
                    '无法计数的表格不能当成零记录',
                    '查看页面',
                    '表格记录数为0',
                    `${base}/custom`,
                ],
            ];
            const written = spawnSync(
                python,
                [
                    '-c',
                    `import json, sys
from openpyxl import Workbook
rows = json.loads(sys.argv[1])
book = Workbook()
sheet = book.active
sheet.append(['测试编号', '用例名称', '测试步骤', '预期结果', '页面地址'])
for row in rows:
    sheet.append(row)
book.save(sys.argv[2])`,
                    JSON.stringify(rows),
                    workbook,
                ],
                { encoding: 'utf8' },
            );
            assert.equal(written.status, 0, written.stderr || written.stdout);
            const env = { ...process.env };
            for (const key of Object.keys(env)) {
                if (
                    key.startsWith('LAYA_') ||
                    key.startsWith('TEST_') ||
                    key.startsWith('BROWSER_')
                )
                    delete env[key];
            }
            Object.assign(env, {
                TEST_URL: '',
                TEST_USER: '',
                TEST_AUTH_STATE: '',
                TEST_AUTH_CHECK: '',
                TEST_PASSWORD: '',
                LAYA_API_KEY: '',
                BROWSER_PROVIDER: 'playwright',
                BROWSER_CHANNEL: '',
                BROWSER_HEADLESS: 'true',
                PYTHONPATH: path.join(root, 'tests/fixtures/local-model'),
            });
            const child = spawn(
                process.execPath,
                [
                    'scripts/runner.mjs',
                    '--headless',
                    '--lazy-model',
                    '--provider',
                    'local',
                    '--python',
                    python,
                    '--language',
                    'none',
                    '--delay',
                    '0',
                    '--assert-timeout',
                    '400',
                    '--page-timeout',
                    '8000',
                    '--excel',
                    workbook,
                    '--url',
                    `${base}/aria`,
                    '--out',
                    output,
                ],
                { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let logs = '';
            child.stdout.on('data', (chunk) => (logs += chunk));
            child.stderr.on('data', (chunk) => (logs += chunk));
            const code = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    reject(Error('CLI timed out\n' + logs));
                }, 90000);
                child.once('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once('close', (status) => {
                    clearTimeout(timer);
                    resolve(status);
                });
            });
            const summary = JSON.parse(
                await fs.readFile(path.join(output, 'results.json'), 'utf8'),
            );
            assert.equal(code, 1, logs);
            assert.equal(summary.workbookFormat, 'natural-language');
            assert.equal(summary.metrics.model_calls, 0, logs);
            const byId = Object.fromEntries(summary.results.map((item) => [item.id, item]));
            const assertion = (id) => {
                assert.equal(byId[id].assertions.length, 1, JSON.stringify(byId[id]));
                return byId[id].assertions[0];
            };
            const zero = assertion('001');
            assert.equal(byId['001'].status, '失败', logs);
            assert.equal(zero.text, '表格记录数为0');
            assert.equal(zero.status, '失败');
            assert.equal(zero.actual, 1);
            const one = assertion('002');
            assert.equal(byId['002'].status, '通过', logs);
            assert.equal(one.text, '列表记录数为1');
            assert.equal(one.status, '通过');
            assert.equal(one.actual, 1);
            const empty = assertion('003');
            assert.equal(byId['003'].status, '通过', logs);
            assert.equal(empty.status, '通过');
            assert.equal(empty.actual, 0);
            const native = assertion('004');
            assert.equal(byId['004'].status, '通过', logs);
            assert.equal(native.status, '通过');
            assert.equal(native.actual, 1);
            const custom = assertion('005');
            assert.equal(byId['005'].status, '部分验证', logs);
            assert.equal(custom.status, '未验证');
            assert.equal(custom.actual, undefined);
            assert.match(custom.reason, /不能把未知结构当成0行/);
            const report = await fs.readFile(path.join(output, '报告.md'), 'utf8');
            assert.match(report, /\|001\|非空ARIA表格不应被当成零记录\|失败\|/);
            assert.match(report, /\|002\|非空ARIA表格记录数为1\|通过\|/);
            assert.match(report, /\|003\|空ARIA表格记录数为0\|通过\|/);
            assert.match(report, /\|005\|无法计数的表格不能当成零记录\|部分验证\|/);
            assert.doesNotMatch(report, /\|001\|[^|]*\|通过\|/);
        } finally {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        }
    },
);
