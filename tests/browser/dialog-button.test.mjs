import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Engine } from '../../scripts/lib/engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
const dialogButton = '弹窗显示“保存”按钮';

test('dialog button assertions ignore background buttons and refuse an unclear dialog', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const engine = new Engine(page, {}, { assertTimeout: 50 });
        const check = async (html, text, status) => {
            await page.setContent(html);
            const result = await engine.verify(text);
            assert.equal(result.status, status, text + ' ' + html + ' ' + JSON.stringify(result));
            if (text.startsWith('弹窗')) assert.equal(result.scope, '弹窗');
            return result;
        };

        // Issue fixture: a dialog is open, but the only 保存 button is behind it.
        await check(
            '<button>保存</button><div role="dialog"><p>内容</p></div>',
            dialogButton,
            '失败',
        );
        // No dialog at all. A unique page button must not count.
        const missing = await check('<button>保存</button>', dialogButton, '未验证');
        assert.match(missing.reason, /无法唯一确定弹窗范围（找到 0 个）/);
        // The button lives only in the dialog.
        await check('<div role="dialog"><button>保存</button></div>', dialogButton, '通过');
        await check(
            '<div role="dialog"><button>保存</button></div>',
            '弹窗展示「保存」按钮',
            '通过',
        );
        // Same name in the dialog and on the page: only the dialog button counts.
        await check(
            '<button>保存</button><div role="dialog"><button>保存</button></div>',
            dialogButton,
            '通过',
        );
        await check(
            '<button>保存</button><dialog open><button>保存</button></dialog>',
            dialogButton,
            '通过',
        );
        await check(
            '<button>保存</button><div class="ant-drawer ant-drawer-open"><div class="ant-drawer-content"><button>保存</button></div></div>',
            dialogButton,
            '通过',
        );
        // Page-scoped wording still searches the whole page, including both buttons.
        await check(
            '<button>保存</button><div role="dialog"><button>保存</button></div>',
            '页面显示「保存」按钮',
            '失败',
        );
        await check(
            '<button>保存</button><div role="dialog"><p>内容</p></div>',
            '页面显示「保存」按钮',
            '通过',
        );
        // Two visible dialogs, even when the page has exactly one matching button.
        const ambiguous = await check(
            '<div role="dialog"><button>保存</button></div><div role="dialog"><p>其他</p></div>',
            dialogButton,
            '未验证',
        );
        assert.match(ambiguous.reason, /无法唯一确定弹窗范围（找到 2 个）/);
        // A hidden dialog is not a scope. The visible background button must not pass.
        await check(
            '<button>保存</button><div role="dialog" hidden><button>保存</button></div>',
            dialogButton,
            '未验证',
        );
        await check(
            '<button>保存</button><div role="dialog" style="display:none"><button>保存</button></div>',
            dialogButton,
            '未验证',
        );
        await check(
            '<button>保存</button><dialog><button>保存</button></dialog>',
            dialogButton,
            '未验证',
        );
        // One hidden dialog does not make a single open dialog ambiguous.
        await check(
            '<div role="dialog" hidden><button>保存</button></div><div role="dialog"><button>保存</button></div><button>保存</button>',
            dialogButton,
            '通过',
        );
        // Accessibility role and exact name still apply inside the dialog.
        await check('<div role="dialog"><a href="/">保存</a></div>', dialogButton, '失败');
        await check('<div role="dialog"><label>保存<input></label></div>', dialogButton, '失败');
        await check(
            '<div role="dialog"><span tabindex="0" aria-label="保存">保存</span></div>',
            dialogButton,
            '失败',
        );
        await check(
            '<div role="dialog"><input type="submit" value="保存"></div>',
            dialogButton,
            '通过',
        );
        await check('<div role="dialog"><div role="button">保存</div></div>', dialogButton, '通过');
        await check('<div role="dialog"><button>保存草稿</button></div>', dialogButton, '失败');
        await check(
            '<div role="dialog"><button>保存</button><button>保存草稿</button></div>',
            dialogButton,
            '通过',
        );
        await check(
            '<div role="dialog"><button>保存</button><button>保存</button></div>',
            dialogButton,
            '失败',
        );
        await check(
            '<div role="dialog"><p>内容</p><button hidden>保存</button></div>',
            dialogButton,
            '失败',
        );
    } finally {
        await browser.close();
    }
});

test('ordinary Excel CLI report scopes dialog button assertions', { timeout: 120000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-dialog-button-'));
    const pages = {
        '/background': '<button>保存</button><div role="dialog"><p>内容</p></div>',
        '/inside': '<div role="dialog"><button>保存</button></div>',
        '/both': '<button>保存</button><div role="dialog"><button>保存</button></div>',
        '/none': '<button>保存</button>',
        '/two': '<div role="dialog"><button>保存</button></div><div role="dialog"><p>其他</p></div>',
        '/hidden': '<button>保存</button><div role="dialog" hidden><button>保存</button></div>',
    };
    const server = http.createServer((req, res) => {
        const html = pages[req.url];
        if (!html) {
            res.writeHead(404).end('missing');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const workbook = path.join(directory, 'dialog-buttons.xlsx');
    const cases = [
        ['001', '背景按钮不能代替弹窗', '/background', '失败', '失败'],
        ['002', '弹窗内唯一按钮', '/inside', '通过', '通过'],
        ['003', '弹窗和背景各有一个', '/both', '通过', '通过'],
        ['004', '没有弹窗', '/none', '部分验证', '未验证'],
        ['005', '两个可见弹窗', '/two', '部分验证', '未验证'],
        ['006', '只有隐藏弹窗', '/hidden', '部分验证', '未验证'],
    ];
    try {
        const written = await writeWorkbook(workbook, [
            ['测试编号', '用例名称', '测试步骤', '预期结果', '页面地址'],
            ...cases.map(([id, title, route]) => [
                id,
                title,
                '查看当前页面',
                dialogButton,
                base + route,
            ]),
        ]);
        assert.equal(written.code, 0, written.stderr || written.stdout);
        const output = path.join(directory, 'report');
        const { code, stdout, stderr } = await runCli(output, [
            '--excel',
            workbook,
            '--url',
            base + '/inside',
            '--headless',
            '--lazy-model',
            '--provider',
            'local',
            '--python',
            python,
            '--delay',
            '0',
            '--assert-timeout',
            '1000',
            '--page-timeout',
            '8000',
            '--out',
            output,
        ]);
        const summary = JSON.parse(
            await fs.readFile(path.join(output, 'results.json'), 'utf8').catch((error) => {
                throw new Error(`${error.message}\n${stdout}\n${stderr}`);
            }),
        );
        const inspection = JSON.parse(
            await fs.readFile(path.join(output, 'excel-inspection.json'), 'utf8'),
        );
        const csv = await fs.readFile(path.join(output, '结果.csv'), 'utf8');
        const markdown = await fs.readFile(path.join(output, '报告.md'), 'utf8');
        assert.equal(summary.workbookFormat, 'natural-language', stdout + stderr);
        assert.equal(summary.metrics.model_calls, 0, stdout + stderr);
        assert.equal(code === 0, false, stdout + stderr);
        assert.equal(inspection.cases.length, cases.length);
        for (const item of inspection.cases) {
            assert.deepEqual(item.expected, [
                {
                    text: dialogButton,
                    kind: 'controlVisible',
                    target: '保存',
                    role: 'button',
                    scope: '弹窗',
                },
            ]);
        }
        const byId = Object.fromEntries(summary.results.map((result) => [result.id, result]));
        for (const [id, title, , caseStatus, assertionStatus] of cases) {
            const result = byId[id];
            assert.ok(result, id);
            assert.equal(result.status, caseStatus, id + ' ' + result.reason);
            assert.equal(result.assertions.length, 1, id);
            assert.equal(result.assertions[0].status, assertionStatus, id + ' ' + result.reason);
            assert.equal(result.assertions[0].scope, '弹窗', id);
            assert.equal(result.assertions[0].kind, 'controlVisible', id);
            assert.equal(result.status === '通过', assertionStatus === '通过', id);
            assert.match(csv, new RegExp(title));
            assert.match(csv, new RegExp(caseStatus));
            assert.match(markdown, new RegExp(`\\|${id}\\|${title}\\|${caseStatus}\\|`));
        }
        assert.match(byId['004'].assertions[0].reason, /找到 0 个/);
        assert.match(byId['005'].assertions[0].reason, /找到 2 个/);
        assert.match(byId['006'].assertions[0].reason, /找到 0 个/);
        assert.equal(byId['001'].assertions[0].status === '通过', false);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});

function writeWorkbook(file, rows) {
    const script = `
import json, sys
from openpyxl import Workbook
book = Workbook()
sheet = book.active
for row in json.loads(sys.argv[1]):
    sheet.append(row)
book.save(sys.argv[2])
`;
    return run(python, ['-c', script, JSON.stringify(rows), file]);
}

function runCli(output, args) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('LAYA_') || key.startsWith('TEST_') || key.startsWith('BROWSER_'))
            delete env[key];
    }
    // Empty values prevent .env.local from reintroducing real login settings.
    Object.assign(env, {
        TEST_USER: '',
        TEST_PASSWORD: '',
        TEST_AUTH_STATE: '',
        TEST_AUTH_CHECK: '',
        TEST_AUTH_SESSION_STORAGE: 'false',
        LAYA_API_KEY: '',
    });
    env.LAYA_PROVIDER = 'local';
    env.BROWSER_PROVIDER = 'playwright';
    env.BROWSER_CHANNEL = '';
    env.BROWSER_HEADLESS = 'true';
    return run(process.execPath, [path.join(root, 'scripts/runner.mjs'), ...args], {
        cwd: root,
        env,
    });
}

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
