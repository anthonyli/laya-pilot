import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    caseDirectory,
    projectRunsDirectory,
    runDirectoryName,
    slug,
} from '../scripts/lib/run-layout.mjs';
import { assess, finalizeRun, latestReportIndex, outcome } from '../scripts/lib/run-index.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/laya.mjs', import.meta.url));

test('case directories are ordered, readable and stay inside cases/', () => {
    assert.equal(caseDirectory(1, '001', '标题检查'), 'cases/001-标题检查');
    assert.equal(caseDirectory(2, '005', '筛选'), 'cases/002-005-筛选');
    assert.equal(caseDirectory(3, 'TC 1', 'TC 1'), 'cases/003-TC-1');
    for (const unsafe of ['../../evil', 'a/b\\c:d*e?f"g<h>i|j', '\u0000\n'])
        assert.doesNotMatch(caseDirectory(4, unsafe, unsafe).slice('cases/'.length), /[\\/]/);
    assert.equal([...slug('长'.repeat(80))].length, 40);
    assert.match(runDirectoryName(new Date(2026, 10, 20, 9, 5, 7)), /^2026-11-20_09-05-07$/);
});

test('reliability verdict separates failures, gaps and clean passes', () => {
    const view = (cases, extra = {}) => ({
        kind: '普通 Excel 用例',
        cases,
        warnings: [],
        ...extra,
    });
    const item = (status, more = {}) => ({
        id: status,
        title: status,
        status,
        timeline: [],
        assertions: [],
        checks: [],
        events: [],
        network: [],
        ...more,
    });
    assert.equal(outcome('已验证'), 'pass');
    assert.equal(outcome('未执行（依赖阻断）'), 'blocked');

    const clean = assess(view([item('通过')], { modelCalls: 3 }));
    assert.equal(clean.verdict.level, 'ok');

    const gaps = assess(
        view([item('通过', { assertions: [{ status: '未验证' }], network: ['500 /api'] })]),
    );
    assert.equal(gaps.verdict.level, 'warn');
    assert.ok(gaps.signals.some((s) => /未验证/.test(s.text)));
    assert.ok(gaps.signals.some((s) => /接口错误/.test(s.text)));

    const failed = assess(view([item('失败'), item('阻断')]));
    assert.equal(failed.verdict.text, '未通过');
    assert.equal(failed.failed, 1);
    assert.equal(failed.blocked, 1);
    assert.equal(assess(view([])).verdict.level, 'bad');
});

test('finalizeRun writes an index that links every screenshot and a summary', async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-run-index-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const out = path.join(cwd, 'custom-out');
    await fs.mkdir(path.join(out, 'cases/001-缺失'), { recursive: true });
    await fs.writeFile(path.join(out, 'cases/001-缺失/01-预期1-失败.png'), 'png');
    await fs.writeFile(
        path.join(out, 'results.json'),
        JSON.stringify({
            source: 1,
            input: 'cases.xlsx',
            import_warnings: [],
            metrics: { model_calls: 0, model_errors: 0 },
            results: [
                {
                    id: '001',
                    title: '<缺失>',
                    status: '失败',
                    reason: '页面显示“不存在”',
                    evidence_dir: 'cases/001-缺失',
                    evidence: [
                        {
                            phase: 'assertion',
                            index: 1,
                            text: '页面显示“不存在”',
                            status: '失败',
                            screenshot: 'cases/001-缺失/01-预期1-失败.png',
                        },
                    ],
                    assertions: [{ status: '失败' }],
                    health_checks: [
                        { status: '通过', text: '页面检查' },
                        { status: '未验证', text: '环境检查' },
                        { status: '未执行', text: '后续检查' },
                        { status: '待补充', text: '业务预期' },
                        { status: '失败', text: '保存校验' },
                        { status: '失败', severity: 'info', text: '后台读取' },
                    ],
                    browser_events: [
                        { kind: 'pageerror', detail: 'script failed' },
                        { kind: 'requestcancelled', method: 'GET', url: '/cancelled' },
                        { kind: 'api-body', method: 'GET', url: '/background', severity: 'info' },
                    ],
                },
            ],
        }),
    );
    const { assessment } = await finalizeRun(out, cwd);
    assert.equal(assessment.verdict.text, '未通过');
    const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.ok(
        html.includes(['cases', '001-缺失', '01-预期1-失败.png'].map(encodeURIComponent).join('/')),
    );
    assert.ok(html.includes('&lt;缺失&gt;'), 'case text is escaped');
    for (const [tone, text] of [
        ['pass', '通过 · 页面检查'],
        ['unverified', '未验证 · 环境检查'],
        ['blocked', '未执行 · 后续检查'],
        ['blocked', '待补充 · 业务预期'],
        ['fail', '失败 · 保存校验'],
        ['neutral', '失败 · 后台读取'],
        ['fail', '前端异常：script failed'],
        ['neutral', '请求取消 GET /cancelled'],
        ['neutral', '接口返回失败 GET /background'],
    ])
        assert.ok(html.includes(`<li class="${tone}">${text}`), text);
    assert.doesNotMatch(html, /show-trace/, 'no trace hint without a trace file');
    assert.match(await fs.readFile(path.join(out, 'summary.md'), 'utf8'), /# 未通过/);
    assert.equal(await latestReportIndex(cwd), path.join(out, 'index.html'));
});

test('latest report stays with a copied or moved project and preserves external outputs', async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-portable-report-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const original = path.join(temp, 'original');
    const copy = path.join(temp, 'copy');
    const moved = path.join(temp, 'moved');
    const relative = path.join('runs', 'laya-pilot', 'first-run');
    const out = path.join(original, relative);
    const makeReport = async (output, cwd) => {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results: [] }));
        await finalizeRun(output, cwd);
    };
    const latest = (cwd) => path.join(projectRunsDirectory(cwd), 'latest.json');
    const index = (cwd) => path.join(cwd, relative, 'index.html');

    await makeReport(out, original);
    const pointer = JSON.parse(await fs.readFile(latest(original), 'utf8'));
    assert.equal(pointer.directory, relative);
    assert.equal(pointer.index, path.join(relative, 'index.html'));
    await fs.cp(original, copy, { recursive: true });
    assert.equal(await latestReportIndex(original), index(original));
    assert.equal(await latestReportIndex(copy), index(copy));

    await fs.writeFile(latest(copy), JSON.stringify({ directory: out, index: index(original) }));
    assert.equal(await latestReportIndex(copy), index(copy));
    await fs.rename(original, moved);
    assert.equal(await latestReportIndex(moved), index(moved));
    assert.equal(await latestReportIndex(copy), index(copy));

    // A new external pointer is explicit even when its path looks like the old default.
    const external = path.join(temp, 'external', relative);
    await makeReport(external, moved);
    assert.equal(await latestReportIndex(moved), path.join(external, 'index.html'));
    assert.equal(JSON.parse(await fs.readFile(latest(moved), 'utf8')).directory, external);
});

test(
    'report opens the project latest and can still open a specific run',
    { skip: process.platform === 'win32' },
    async (t) => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-report-cli-'));
        t.after(() => fs.rm(cwd, { recursive: true, force: true }));
        const env = { ...process.env, LAYA_HOME: path.join(cwd, 'state'), PATH: cwd };
        const report = (...args) => exec(process.execPath, [cli, 'report', ...args], { cwd, env });
        await fs.writeFile(
            path.join(cwd, process.platform === 'darwin' ? 'open' : 'xdg-open'),
            '#!/bin/sh\nexit 0\n',
            { mode: 0o700 },
        );
        await assert.rejects(report(), { code: 1, stderr: /No completed report/ });
        await assert.rejects(report('first', 'second'), { code: 1, stderr: /report \[RUN_DIR\]/ });

        const root = projectRunsDirectory(cwd);
        const older = path.join(root, 'older');
        const custom = path.join(cwd, 'custom report');
        for (const out of [older, custom]) {
            await fs.mkdir(out, { recursive: true });
            await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ results: [] }));
            await finalizeRun(out, cwd);
        }
        assert.ok((await report()).stdout.includes(path.join(custom, 'index.html')));
        assert.ok(
            (await report('runs/laya-pilot/older')).stdout.includes(path.join(older, 'index.html')),
        );

        await fs.rm(custom, { recursive: true });
        assert.ok((await report()).stdout.includes(path.join(older, 'index.html')));
        await fs.writeFile(path.join(root, 'latest.json'), 'incomplete');
        assert.ok((await report()).stdout.includes(path.join(older, 'index.html')));
    },
);
