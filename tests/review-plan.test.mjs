import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateReviewPlan, loadReviewedPlan } from '../scripts/lib/review-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
const source = (url) => ({
    url,
    allowWrite: false,
    uncovered: ['其他菜单未覆盖'],
    cases: [
        {
            id: '001',
            title: '查看入口',
            steps: '观察页面',
            expected: '页面显示“搜索”按钮且页面显示“搜索”',
            pending: [],
        },
    ],
});

function run(args, cwd, overrides = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LAYA_|TEST_|BROWSER_)/.test(key)) delete env[key];
    Object.assign(env, {
        TEST_USER: '',
        TEST_PASSWORD: '',
        TEST_AUTH_STATE: '',
        TEST_AUTH_CHECK: '',
        TEST_AUTH_SESSION_STORAGE: 'false',
        TEST_URL: '',
        TEST_EXCEL: '',
        TEST_DATA: '',
        TEST_OPERATIONS: '',
        TEST_CASE_FILE: '',
        TEST_TEMPLATE_EXCEL: '',
        TEST_OUTPUT: '',
        LAYA_API_KEY: '',
        BROWSER_CHANNEL: '',
        BROWSER_PROVIDER: 'playwright',
        ...overrides,
    });
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, 'scripts/run.mjs'), ...args], {
            cwd,
            env,
        });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (s) => (stdout += s));
        child.stderr.on('data', (s) => (stderr += s));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('review schema requires explicit scope and preserves unknown business prerequisites', () => {
    const input = source('https://example.test');
    input.cases[0].pending = ['待补充合法客户编号'];
    const plan = validateReviewPlan(input);
    assert.equal(plan.status, 'draft-unverified');
    assert.deepEqual(plan.cases[0].pending, input.cases[0].pending);
    assert.equal(plan.cases[0].expected, input.cases[0].expected);
    assert.throws(() => validateReviewPlan({ ...input, allowWrite: undefined }), /allowWrite/);
    assert.throws(() => validateReviewPlan({ ...input, url: 'file:///tmp/local' }), /HTTP/);
    assert.throws(
        () => validateReviewPlan({ ...input, url: 'https://user:password@example.test' }),
        /凭据/,
    );
    assert.throws(
        () => validateReviewPlan({ ...input, cases: [...input.cases, ...input.cases] }),
        /重复/,
    );
    assert.throws(() => validateReviewPlan({ ...input, executable: 'anything' }), /未知字段/);
    for (const key of ['id', 'title', 'preconditions', 'data', 'steps', 'expected']) {
        for (const value of ['x'.repeat(32768), '前\u0000后'])
            assert.throws(
                () =>
                    validateReviewPlan({ ...input, cases: [{ ...input.cases[0], [key]: value }] }),
                /Excel 文本限制/,
            );
    }
    assert.equal(
        validateReviewPlan({
            ...input,
            cases: [{ ...input.cases[0], expected: 'x'.repeat(32767) }],
        }).cases[0].expected.length,
        32767,
    );
});

test(
    'offline plan, approval binding and public execution keep scope and original draft intact',
    { timeout: 90000 },
    async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-review-plan-'));
        let hits = 0;
        const server = http.createServer((req, res) => {
            hits++;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
                '<button>搜索</button><button id="unknown"><svg width="20" height="20"></svg></button>',
            );
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
            await fs.writeFile(path.join(directory, 'source.json'), JSON.stringify(source(url)));
            const createArgs = ['--mode', 'plan', '--plan-source', 'source.json', '--out', 'draft'];
            const created = await run(createArgs, directory, {
                LAYA_PYTHON: '/missing/python',
                LAYA_API_BASE: 'invalid',
            });
            assert.equal(created.code, 0, created.stderr);
            assert.equal(hits, 0);
            const metadata = JSON.parse(created.stdout.trim());
            assert.equal(metadata.browserStarted, false);
            const file = path.join(directory, 'draft/draft-plan.json');
            const original = await fs.readFile(file);
            assert.equal(metadata.sha256, createHash('sha256').update(original).digest('hex'));
            assert.equal(
                (await run(createArgs, directory)).code,
                1,
                'must not overwrite reviewed output',
            );
            assert.deepEqual(await fs.readFile(file), original);
            const base = [
                '--mode',
                'reviewed',
                '--review-plan',
                file,
                '--python',
                python,
                '--provider',
                'local',
                '--lazy-model',
                '--headless',
                '--delay',
                '0',
                '--out',
                'result',
            ];
            const missing = await run(base, directory);
            assert.equal(missing.code, 1);
            assert.match(missing.stderr, /approved-hash/);
            const bad = await run([...base, '--approved-hash', '0'.repeat(64)], directory);
            assert.equal(bad.code, 1);
            const overridden = await run(
                [...base, '--approved-hash', metadata.sha256, '--url', url + '/other'],
                directory,
            );
            assert.equal(overridden.code, 1);
            assert.match(overridden.stderr, /覆盖已审核范围/);
            const rebound = await run(
                [
                    ...base,
                    '--approved-hash',
                    metadata.sha256,
                    '--control-bindings',
                    'bindings.json',
                ],
                directory,
            );
            assert.equal(rebound.code, 1);
            assert.match(rebound.stderr, /覆盖已审核范围/);
            assert.equal(hits, 0);
            const inspection = await run([...base, '--inspect'], directory);
            assert.equal(inspection.code, 0, inspection.stderr);
            assert.match(inspection.stdout, /inspected-unverified/);
            assert.equal(hits, 0);
            const pending = JSON.parse(original);
            pending.cases[0].pending = ['未知业务规则'];
            await fs.writeFile(file, JSON.stringify(pending));
            const pendingHash = createHash('sha256')
                .update(await fs.readFile(file))
                .digest('hex');
            const refused = await run([...base, '--approved-hash', pendingHash], directory);
            assert.equal(refused.code, 1);
            assert.match(refused.stderr, /pending/);
            await fs.writeFile(file, original);
            const changed = Buffer.concat([original, Buffer.from('\n')]);
            await fs.writeFile(file, changed);
            await assert.rejects(
                loadReviewedPlan(['--review-plan', file, '--approved-hash', metadata.sha256]),
                /摘要不符/,
            );
            await fs.writeFile(file, original);
            const executed = await run([...base, '--approved-hash', metadata.sha256], directory, {
                TEST_URL: 'http://invalid.invalid',
                TEST_EXCEL: '/missing.xlsx',
                TEST_DATA: '{"injected":"wrong"}',
                TEST_OPERATIONS: 'delete',
            });
            assert.equal(executed.code, 0, executed.stderr + executed.stdout);
            assert.ok(hits > 0);
            const result = JSON.parse(
                await fs.readFile(path.join(directory, 'result/results.json')),
            );
            assert.equal(result.reviewPlan.sha256, metadata.sha256);
            assert.equal(result.reviewPlan.url, url);
            assert.equal(result.reviewPlan.allowWrite, false);
            assert.equal(result.results[0].status, '通过');
            assert.equal(result.results[0].unidentified_controls[0].elementId, 'unknown');
            assert.ok(result.results[0].input_diagnostics);
            assert.equal(result.results[0].evidence.length, 2);
            const markdown = await fs.readFile(path.join(directory, 'result/summary.md'), 'utf8');
            for (const heading of ['步骤与断言证据', '未识别控件与绑定诊断'])
                assert.ok(markdown.includes(heading));
            // Empty sections are omitted: the diagnostics heading appears only with content.
            const actionable = result.results[0].input_diagnostics.filter(
                (d) => d.code !== 'needs-live-target',
            );
            assert.equal(markdown.includes('用例可执行性诊断'), actionable.length > 0);
            assert.equal(result.results[0].assertions[0].kind, 'conjunction');
            assert.equal(result.results[0].assertions[0].assertions.length, 2);
            assert.equal(result.results[0].expected, source(url).cases[0].expected);
            assert.deepEqual(await fs.readFile(file), original);
            const approval = JSON.parse(
                await fs.readFile(path.join(directory, 'result/logs/review-plan-approval.json')),
            );
            assert.equal(approval.sha256, metadata.sha256);
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);
