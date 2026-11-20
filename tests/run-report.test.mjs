import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { caseDirectory, runDirectoryName, slug } from '../scripts/lib/run-layout.mjs';
import { assess, finalizeRun, outcome } from '../scripts/lib/run-index.mjs';

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
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-run-index-'));
    t.after(() => fs.rm(out, { recursive: true, force: true }));
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
                },
            ],
        }),
    );
    const { assessment } = await finalizeRun(out);
    assert.equal(assessment.verdict.text, '未通过');
    const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.ok(
        html.includes(['cases', '001-缺失', '01-预期1-失败.png'].map(encodeURIComponent).join('/')),
    );
    assert.ok(html.includes('&lt;缺失&gt;'), 'case text is escaped');
    assert.doesNotMatch(html, /show-trace/, 'no trace hint without a trace file');
    assert.match(await fs.readFile(path.join(out, 'summary.md'), 'utf8'), /# 未通过/);
});
