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

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';

test('compound assertions never pass when a child fails, is unsupported or has an ambiguous scope', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(
            '<button>搜索</button><button>删除</button><div role="dialog"><button>保存</button></div>',
        );
        const engine = new Engine(page, {}, { assertTimeout: 50 });
        const positive = await engine.verify('弹窗显示“保存”按钮且页面显示“搜索”按钮');
        assert.equal(positive.status, '通过');
        assert.equal(positive.assertions[0].scope, '弹窗');
        assert.equal(
            (await engine.verify('页面显示“搜索”按钮且页面显示“不存在”按钮')).status,
            '失败',
        );
        const partial = await engine.verify('页面显示“搜索”按钮且数据正确');
        assert.equal(partial.status, '未验证');
        assert.deepEqual(
            partial.assertions.map((a) => a.status),
            ['通过', '未验证'],
        );
        assert.match(partial.reason, /业务判定依据/);
        assert.equal((await engine.verify('弹窗显示“保存”按钮且显示“删除”按钮')).status, '未验证');
    } finally {
        await browser.close();
    }
});

test(
    'public inspect diagnoses without page access and runtime keeps originals and unverified results',
    { timeout: 90000 },
    async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-case-diagnostics-'));
        let hits = 0;
        const server = http.createServer((req, res) => {
            hits++;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
                '<button>搜索</button><button>重置</button>',
            );
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
            const workbook = path.join(directory, 'cases.xlsx');
            const rows = [
                ['用例编号', '用例名称', '测试步骤', '预期结果'],
                ['001', '业务语义', '观察页面', '列表按查询条件刷新，返回数据与条件一致，无报错'],
                ['002', '缺数据', '查询条件输入合法数据', '页面显示“搜索”按钮'],
                ['003', '明确复合预期', '观察页面', '页面显示“搜索”按钮且页面显示“重置”按钮'],
                ['004', '部分支持', '观察页面', '页面显示“搜索”按钮且数据正确'],
            ];
            const written = await run(python, [
                '-c',
                'import sys,json; from openpyxl import Workbook; b=Workbook(); s=b.active; [s.append(r) for r in json.loads(sys.argv[1])]; b.save(sys.argv[2])',
                JSON.stringify(rows),
                workbook,
            ]);
            assert.equal(written.code, 0, written.stderr);
            const original = await fs.readFile(workbook);
            const env = { ...process.env };
            for (const key of Object.keys(env))
                if (/^(LAYA_|TEST_|BROWSER_)/.test(key)) delete env[key];
            Object.assign(env, {
                TEST_USER: '',
                TEST_PASSWORD: '',
                TEST_AUTH_STATE: '',
                TEST_AUTH_CHECK: '',
                TEST_AUTH_SESSION_STORAGE: 'false',
                TEST_DATA: '',
                TEST_OPERATIONS: '',
                LAYA_API_KEY: '',
                BROWSER_CHANNEL: '',
                BROWSER_PROVIDER: 'playwright',
            });
            const out = path.join(directory, 'result');
            const args = [
                path.join(root, 'scripts/run.mjs'),
                '--excel',
                workbook,
                '--url',
                url,
                '--python',
                python,
                '--headless',
                '--lazy-model',
                '--provider',
                'local',
                '--out',
                out,
                '--delay',
                '0',
            ];
            const inspect = await run(process.execPath, [...args, '--inspect'], {
                cwd: directory,
                env,
            });
            assert.equal(inspect.code, 0, inspect.stderr);
            assert.equal(hits, 0);
            const inspection = JSON.parse(
                await fs.readFile(path.join(out, 'excel-inspection.json')),
            );
            assert.equal(
                inspection.cases[0].diagnostics.find((d) => d.field === 'expected').code,
                'missing-business-oracle',
            );
            assert.equal(inspection.cases[1].diagnostics[0].code, 'missing-test-value');
            assert.equal(inspection.cases[2].expected[0].kind, 'conjunction');
            const execute = await run(process.execPath, args, { cwd: directory, env });
            assert.notEqual(execute.code, 0);
            const result = JSON.parse(await fs.readFile(path.join(out, 'results.json')));
            assert.equal(result.metrics.model_calls, 0);
            assert.deepEqual(
                result.results.map((r) => r.status),
                ['部分验证', '跳过（未完成）', '通过', '部分验证'],
            );
            assert.equal(result.results[1].category, '缺少测试数据');
            assert.equal(result.results[0].expected, rows[1][3]);
            assert.equal(result.results[3].assertions[0].assertions[1].status, '未验证');
            assert.match(
                await fs.readFile(path.join(out, '报告.md'), 'utf8'),
                /缺少可执行的业务判定依据/,
            );
            assert.match(
                await fs.readFile(path.join(out, '结果.csv'), 'utf8'),
                /missing-test-value/,
            );
            assert.deepEqual(await fs.readFile(workbook), original);
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (s) => (stdout += s));
        child.stderr.on('data', (s) => (stderr += s));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}
