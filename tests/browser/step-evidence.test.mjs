import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';
import { BrowserDiagnostics, HEALTH_EXPECTATIONS } from '../../scripts/lib/diagnostics.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
const html = `<!doctype html><meta charset="utf-8"><h1>列表</h1>
<button onclick="document.querySelector('dialog').showModal()">打开</button>
<dialog><h2>详情</h2><button onclick="this.closest('dialog').close()">关闭</button></dialog>`;
const model = {
    choose: async (_, criteria) => {
        const choice = Object.keys(criteria).find((key) => !['停止', 'Stop'].includes(key));
        return { choice, probabilities: { [choice]: 1 }, margin: 1 };
    },
};

async function fixture(fn, content = html) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-step-evidence-'));
    const server = http.createServer((req, res) => {
        if (req.url === '/api/http-error') return res.writeHead(500).end();
        if (req.url === '/api/body-error')
            return res
                .writeHead(200, { 'content-type': 'application/json' })
                .end('{"success":false,"message":"业务失败"}');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(content);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        await fs.mkdir(path.join(directory, 'evidence'));
        await fn(directory, url);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
}

test('real browser health checks distinguish visible errors, script errors, HTTP errors, and failed API bodies', async () => {
    const content = `<!doctype html><meta charset="utf-8"><h1>列表</h1>
<button onclick="document.getElementById('alert').hidden=false; fetch('/api/http-error'); fetch('/api/body-error'); throw Error('synthetic scripting failure')">运行</button>
<p id="alert" role="alert" hidden>操作失败</p>`;
    await fixture(async (out, url) => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const engine = new Engine(
                page,
                model,
                {
                    out,
                    url,
                    origins: [url],
                    data: {},
                    runId: 'test',
                    maxSteps: 10,
                    pageTimeout: 3000,
                    delay: 0,
                },
                new BrowserDiagnostics(page.context(), { checkBusinessResponses: true }),
            );
            const result = await engine.runCase(
                caseInput(url, {
                    steps: '点击「运行」按钮',
                    expected: Object.values(HEALTH_EXPECTATIONS).join('\n'),
                }),
            );
            assert.equal(result.status, '失败');
            assert.ok(result.health_checks.every((check) => check.status === '失败'));
            for (const kind of ['ui-error', 'pageerror', 'http', 'api-body'])
                assert.ok(
                    result.browser_events.some(
                        (event) => event.kind === kind && event.step?.index === 1,
                    ),
                    `missing ${kind}`,
                );
        } finally {
            await browser.close();
        }
    }, content);
});

function caseInput(url, changes = {}) {
    return {
        sheet: '用例',
        row: 2,
        id: '001',
        key: '用例:2',
        title: '弹窗证据',
        steps: '点击“打开”\n弹出详情弹窗\n点击“关闭”',
        expected: '页面显示“列表”\n列表按查询条件刷新，返回数据与条件一致，无报错',
        preconditions: '',
        data: '',
        url,
        ...changes,
    };
}

test('step and assertion screenshots precede later actions and retain original identity', async () => {
    await fixture(async (out, url) => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const engine = new Engine(page, model, {
                out,
                url,
                origins: [url],
                data: {},
                runId: 'test',
                maxSteps: 10,
                assertTimeout: 100,
                pageTimeout: 2000,
                delay: 0,
            });
            const captures = [];
            const screenshot = page.screenshot.bind(page);
            page.screenshot = async (options) => {
                captures.push({
                    file: options.path,
                    open: await page.locator('dialog').isVisible(),
                });
                return screenshot(options);
            };
            const input = caseInput(url);
            const original = JSON.stringify(input);
            const result = await engine.runCase(input);
            assert.equal(JSON.stringify(input), original);
            assert.equal(result.status, '部分验证');
            assert.deepEqual(
                result.evidence.map((e) => [e.phase, e.index, e.status]),
                [
                    ['step', 1, '已完成'],
                    ['step', 2, '已完成'],
                    ['step', 3, '已完成'],
                    ['assertion', 1, '通过'],
                    ['assertion', 2, '未验证'],
                ],
            );
            assert.deepEqual(
                captures.map((c) => c.open),
                [true, true, false, false, false, false],
            );
            assert.deepEqual(
                result.actions.map((a) => a.evidence_sequence),
                [1, 2, 3],
            );
            assert.deepEqual(
                result.assertions.map((a) => a.evidence_sequence),
                [4, 5],
            );
            assert.equal(result.evidence[1].text, '弹出详情弹窗');
            assert.equal(result.evidence[4].text, input.expected.split('\n')[1]);
            for (const e of result.evidence) {
                assert.equal(e.url, url + '/');
                assert.ok(Number.isFinite(Date.parse(e.at)));
                assert.ok((await fs.stat(path.join(out, e.screenshot))).size > 0);
            }
            const again = await engine.runCase(input);
            const paths = [result, again].flatMap((r) => [
                r.screenshot,
                ...r.evidence.map((e) => e.screenshot),
            ]);
            assert.equal(new Set(paths).size, paths.length);
            const otherSheet = await engine.runCase({ ...input, sheet: '另表' });
            assert.ok(otherSheet.evidence.every((e) => !paths.includes(e.screenshot)));

            const failed = await engine.runCase(
                caseInput(url, {
                    steps: '点击“打开”\n弹出不存在弹窗',
                    expected: '页面显示“列表”',
                }),
            );
            assert.equal(failed.status, '部分执行（未完成）');
            assert.equal(failed.evidence[1].status, '未完成');
            assert.equal(failed.evidence[1].text, '弹出不存在弹窗');
            assert.equal(captures.at(-2).open, true);

            const captureCount = captures.length;
            const blocked = await engine.runCase({ ...input, import_error: '执行列含公式' });
            assert.deepEqual(blocked.evidence, []);
            assert.equal(blocked.screenshot, undefined);
            assert.equal(captures.length, captureCount);
        } finally {
            await browser.close();
        }
    });
});

test('capture errors do not change assertions or link partial files, and scopes are retained', async () => {
    await fixture(async (out, url) => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const engine = new Engine(page, model, {
                out,
                url,
                origins: [url],
                data: {},
                runId: 'test',
                maxSteps: 10,
                assertTimeout: 100,
                pageTimeout: 2000,
                delay: 0,
            });
            const screenshot = page.screenshot.bind(page);
            let captureCount = 0;
            page.screenshot = async (options) => {
                captureCount++;
                if (captureCount <= 2) {
                    await fs.writeFile(options.path, 'partial');
                    throw Error('injected capture failure');
                }
                return screenshot(options);
            };
            const result = await engine.runCase(
                caseInput(url, {
                    steps: '点击“打开”',
                    expected: '弹窗显示“关闭”按钮\n弹窗显示“不存在”按钮',
                }),
            );
            assert.equal(result.status, '失败');
            assert.deepEqual(
                result.assertions.map((a) => a.status),
                ['通过', '失败'],
            );
            assert.equal(result.evidence[1].scope, '弹窗');
            assert.equal(result.evidence[2].scope, '弹窗');
            for (const e of result.evidence.slice(0, 2)) {
                assert.equal(e.screenshot, undefined);
                assert.match(e.screenshot_error, /injected capture failure/);
            }
            assert.ok(result.evidence[2].screenshot);
            assert.ok(result.screenshot);
        } finally {
            await browser.close();
        }
    });
});

test(
    'public Excel CLI exposes timestamped evidence in JSON, CSV and Markdown without editing input',
    { timeout: 120000 },
    async () => {
        await fixture(async (directory, url) => {
            const workbook = path.join(directory, 'cases.xlsx');
            const written = await run(python, [
                '-c',
                `
import sys
from openpyxl import Workbook
book = Workbook()
sheet = book.active
sheet.append(['用例编号', '用例名称', '测试步骤', '预期结果'])
sheet.append(['001', '页面检查', '观察页面', '页面显示“列表”\\n页面显示“不存在”'])
book.save(sys.argv[1])
`,
                workbook,
            ]);
            assert.equal(written.code, 0, written.stderr);
            const before = await fs.readFile(workbook);
            const out = path.join(directory, 'report');
            const env = { ...process.env };
            for (const key of Object.keys(env))
                if (/^(LAYA_|TEST_|BROWSER_)/.test(key)) delete env[key];
            Object.assign(env, {
                TEST_USER: '',
                TEST_PASSWORD: '',
                TEST_AUTH_STATE: '',
                TEST_AUTH_CHECK: '',
                TEST_AUTH_SESSION_STORAGE: 'false',
                LAYA_API_KEY: '',
                BROWSER_CHANNEL: '',
                BROWSER_PROVIDER: 'playwright',
                BROWSER_HEADLESS: 'true',
            });
            const executed = await run(
                process.execPath,
                [
                    path.join(root, 'scripts/run.mjs'),
                    '--excel',
                    workbook,
                    '--url',
                    url,
                    '--headless',
                    '--lazy-model',
                    '--provider',
                    'local',
                    '--python',
                    python,
                    '--delay',
                    '0',
                    '--assert-timeout',
                    '100',
                    '--page-timeout',
                    '8000',
                    '--out',
                    out,
                ],
                { cwd: root, env },
            );
            assert.notEqual(executed.code, 0);
            const summary = JSON.parse(
                await fs.readFile(path.join(out, 'results.json'), 'utf8').catch((e) => {
                    throw Error(e.message + '\n' + executed.stdout + executed.stderr);
                }),
            );
            assert.equal(summary.metrics.model_calls, 0);
            assert.equal(summary.results[0].status, '失败');
            const evidence = summary.results[0].evidence;
            assert.equal(evidence.length, 3);
            assert.deepEqual(
                evidence.map((e) => e.status),
                ['已完成', '通过', '失败'],
            );
            const md = await fs.readFile(path.join(out, 'summary.md'), 'utf8');
            const index = await fs.readFile(path.join(out, 'index.html'), 'utf8');
            const href = (file) => file.split('/').map(encodeURIComponent).join('/');
            assert.match(md, /步骤与断言证据/);
            assert.match(index, /未通过/);
            await fs.access(path.join(out, 'results.xlsx'));
            for (const e of evidence) {
                // Screenshots live in the case's own directory and are shown on the index page.
                assert.ok(e.screenshot.startsWith(summary.results[0].evidence_dir + '/'));
                assert.ok(md.includes(e.screenshot));
                assert.ok(index.includes(href(e.screenshot)));
                assert.ok(md.includes(e.at));
                assert.ok((await fs.stat(path.join(out, e.screenshot))).size > 0);
            }
            assert.deepEqual(await fs.readFile(workbook), before);
        });
    },
);

test('Excel replay budgets each recorded scene independently and honors explicit limits', async () => {
    await fixture(async (directory, url) => {
        const workbook = path.join(directory, 'steps.xlsx');
        const written = await run(python, [
            '-c',
            `
import sys
from openpyxl import Workbook
book = Workbook()
sheet = book.active
sheet.append(['用例编号', '用例名称', '测试步骤', '预期结果', '测试数据'])
for ident, data in [('REC-001', '{"recordedScene":{"kind":"custom"}}'), ('002', '{}')]:
    sheet.append([ident, '页面检查', '\\n'.join(['观察页面'] * 26), '页面显示“列表”', data])
book.save(sys.argv[1])
`,
            workbook,
        ]);
        assert.equal(written.code, 0, written.stderr);
        for (const [label, options, completed] of [
            ['default', [], [26, 25]],
            ['limited', ['--max-steps', '2'], [2, 2]],
        ]) {
            const out = path.join(directory, label);
            const executed = await run(
                process.execPath,
                [
                    path.join(root, 'bin/laya.mjs'),
                    'replay',
                    workbook,
                    '--url',
                    url,
                    '--lazy-model',
                    '--provider',
                    'local',
                    '--headless',
                    '--python',
                    python,
                    '--out',
                    out,
                    '--delay',
                    '0',
                    ...options,
                ],
                { env: { ...process.env, LAYA_HOME: directory } },
            );
            const { results } = JSON.parse(
                await fs.readFile(path.join(out, 'results.json'), 'utf8'),
            );
            assert.deepEqual(
                results.map((r) => r.evidence.filter((e) => e.status === '已完成').length),
                completed,
                executed.stdout,
            );
            assert.match(results.at(-1).reason, /最大操作次数/);
            assert.equal(results[0].status, label === 'default' ? '通过' : '部分执行（未完成）');
        }
    });
});

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}
