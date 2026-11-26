import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LATEST_RUN, projectRunsDirectory, RUN_FILES } from './run-layout.mjs';
import { writePrivateJson } from './run-state.mjs';
import { eventLabel } from './diagnostics.mjs';
import { reportStyles, setupScreenshotViewer } from './report-presentation.mjs';

// Turns any run directory (ordinary Excel, structured plan or Playwright replay)
// into one view: a reliability verdict, then every case with its timeline and
// screenshots. index.html references files in the directory; it is not inlined.

const PASS = new Set(['通过', '已验证', '已完成', '预期失败', 'passed', 'expected']);
const FAIL = new Set(['失败', '未生成', 'failed', 'unexpected', 'timedOut']);
const UNVERIFIED = new Set(['未验证', '待补证']);
const NEUTRAL = new Set(['不适用', '未选择', '跳过', 'skipped']);

export function outcome(status = '') {
    if (PASS.has(status)) return 'pass';
    if (FAIL.has(status)) return 'fail';
    if (UNVERIFIED.has(status)) return 'unverified';
    if (NEUTRAL.has(status)) return 'neutral';
    if (status === '不稳定' || status === 'flaky') return 'flaky';
    return 'blocked'; // 阻断, 中断, 未执行…, 未完成, interrupted
}

const count = (items, test) => items.filter(test).length;

function diagnosticTone(entry, fallback = 'fail') {
    if (entry.severity === 'info' || entry.kind === 'requestcancelled') return 'neutral';
    if (entry.severity === 'warning') return 'unverified';
    if (typeof entry.status === 'string' && !/^\d+$/.test(entry.status))
        return outcome(entry.status);
    return fallback;
}

function browserDiagnostic(event) {
    return {
        tone: diagnosticTone(event),
        text: event.kind ? eventLabel(event) : event.message || event.text || '',
    };
}

function fromOrdinary(summary) {
    const cases = (summary.results || []).map((r) => ({
        id: r.id,
        title: r.title,
        location: r.sheet ? `${r.sheet} 第${r.row}行` : '',
        status: r.status,
        reason: r.reason,
        category: r.category,
        directory: r.evidence_dir || '',
        durationMs: r.duration_ms,
        screenshot: r.screenshot,
        screenshotError: r.screenshot_error,
        trace: r.trace,
        traceError: r.trace_error,
        timeline: (r.evidence || []).map((e) => ({
            label: `${e.phase === 'step' ? '步骤' : e.phase === 'assertion' ? '预期' : e.phase} ${e.index ?? ''}`,
            text: e.text,
            status: e.status,
            at: e.at,
            screenshot: e.screenshot,
            error: e.screenshot_error,
            notes: e.notes,
        })),
        assertions: r.assertions || [],
        checks: r.health_checks || [],
        events: (r.browser_events || []).map(browserDiagnostic),
        network: (r.network_errors || []).map((e) => ({
            tone: diagnosticTone(e),
            text: `${e.status ?? ''} ${e.url ?? ''}`.trim(),
        })),
        unidentified: (r.unidentified_controls || []).length,
    }));
    return {
        kind: '普通 Excel 用例',
        source: [summary.input, summary.url].filter(Boolean).join(' · '),
        provider: summary.provider,
        error: summary.error,
        cases,
        warnings: summary.import_warnings || [],
        selection: summary.selection,
        modelCalls: summary.metrics?.model_calls,
        modelErrors: summary.metrics?.model_errors,
    };
}

function fromStructured(summary) {
    const cases = (summary.results || []).map((r) => ({
        id: r.id,
        title: r.title,
        location: r.operation || '',
        status: r.status,
        reason: r.reason,
        category: r.diagnosis?.category,
        directory: r.evidence ? path.posix.dirname(r.evidence) : '',
        durationMs: r.durationMs,
        screenshot: r.evidence,
        trace: r.trace,
        traceError: r.trace_error,
        timeline: (r.attempts || []).map((a) => ({
            label: `${a.text || a.step}${a.attempt > 1 ? ` · 第${a.attempt}次` : ''}`,
            text: a.reason,
            status: a.status,
            screenshot: a.evidence,
        })),
        assertions: [],
        checks: [],
        events: (r.browserEvents || []).map(browserDiagnostic),
        network: [],
    }));
    return {
        kind: summary.mode === 'generate' ? '从页面生成用例' : '结构化用例',
        source: summary.caseFile || summary.moduleUrl,
        provider: summary.provider,
        error: summary.error ? { message: summary.error, screenshot: summary.runEvidence } : null,
        pendingWrite: summary.pendingWrite,
        cases,
        warnings: [],
        modelCalls: summary.metrics?.modelCalls,
        modelErrors: summary.metrics?.modelErrors,
    };
}

const PLAYWRIGHT_STATUS = {
    passed: '通过',
    expected: '通过',
    failed: '失败',
    unexpected: '失败',
    timedOut: '失败',
    flaky: '不稳定',
    skipped: '跳过',
    interrupted: '中断',
};
export const INTERRUPTED_REPLAY_VERDICT = '回放已中止，结果不完整';

function fromPlaywright(report, out) {
    const relative = (file) => (file ? path.relative(out, file).split(path.sep).join('/') : '');
    const statusLabel = (status) => PLAYWRIGHT_STATUS[status] || status || '未完成';
    const cases = [];
    const walk = (suite, trail) => {
        for (const spec of suite.specs || [])
            for (const t of spec.tests || []) {
                const results = t.results || [];
                const retried = results.length > 1;
                const attempts = results.map((result, index) => {
                    const label = `第 ${index + 1} 次尝试`;
                    const files = (result.attachments || []).filter((a) => a.path);
                    const screenshot = files.findLast((a) => a.contentType?.startsWith('image/'));
                    const errors = (result.errors || []).map((e) => e.message).filter(Boolean);
                    return { result, label, files, screenshot, errors };
                });
                const last = attempts.at(-1);
                const evidence = attempts.flatMap((a) => a.files);
                const trace = evidence.findLast((a) => a.name === 'trace');
                const evidenceFile = attempts.findLast((a) => a.screenshot)?.screenshot || trace;
                const lastStatus = last?.result.status;
                let status = statusLabel(t.status || lastStatus);
                // Playwright folds interrupted attempts and tests that never ran into "skipped".
                if (lastStatus === 'interrupted') status = statusLabel(lastStatus);
                else if (t.status === 'skipped' && !last && t.expectedStatus !== 'skipped')
                    status = '未执行';
                else if (t.status === 'expected' && t.expectedStatus === 'failed')
                    status = '预期失败';
                cases.push({
                    id: String(cases.length + 1).padStart(3, '0'),
                    title: [...trail, spec.title].filter(Boolean).join(' › '),
                    location: `${spec.file}:${spec.line}`,
                    status,
                    reason: attempts
                        .flatMap((a) =>
                            a.errors.map((error) => (retried ? `${a.label}：${error}` : error)),
                        )
                        .join('\n'),
                    directory: evidenceFile ? path.posix.dirname(relative(evidenceFile.path)) : '',
                    durationMs:
                        last && results.reduce((sum, result) => sum + (result.duration || 0), 0),
                    screenshot: relative(last?.screenshot?.path),
                    timeline: attempts.flatMap(({ result, label, screenshot }, index) => [
                        ...(retried
                            ? [
                                  {
                                      label,
                                      status: statusLabel(result.status),
                                      screenshot:
                                          index < attempts.length - 1
                                              ? relative(screenshot?.path)
                                              : '',
                                  },
                              ]
                            : []),
                        ...(result.steps || []).map((s) => ({
                            label: s.title,
                            status: s.error ? '失败' : '通过',
                        })),
                    ]),
                    attachments: attempts.flatMap((a) =>
                        a.files.map((file) => ({
                            name: retried ? `${a.label} · ${file.name}` : file.name,
                            path: relative(file.path),
                            isImage: file.contentType?.startsWith('image/'),
                        })),
                    ),
                    trace: relative(trace?.path),
                    assertions: [],
                    checks: [],
                    events: [],
                    network: [],
                });
            }
        for (const child of suite.suites || []) walk(child, [...trail, child.title]);
    };
    for (const suite of report.suites || []) walk(suite, []);
    return {
        kind: '录制回放（Playwright）',
        source: report.config?.rootDir,
        cases,
        interrupted: cases.some((c) => c.status === PLAYWRIGHT_STATUS.interrupted),
        error: report.errors?.length
            ? { message: report.errors.map((e) => e.message).join('\n') }
            : null,
        externalReport: 'playwright-report/index.html',
    };
}

/** Reliability signals: what a reader must know before trusting the result. */
export function assess(view, { interrupted = false } = {}) {
    const { cases } = view;
    const signals = [];
    const add = (level, text) => signals.push({ level, text });
    const tally = (kind) => count(cases, (c) => outcome(c.status) === kind);
    const passed = tally('pass');
    const failed = tally('fail');
    const blocked = tally('blocked');
    const flaky = tally('flaky');
    const skipped = count(cases, (c) => c.status === '跳过' || c.status === 'skipped');
    const allSkipped = skipped > 0 && skipped === cases.length;
    const unverifiedCases = tally('unverified');
    const assertions = cases.flatMap((c) => c.assertions);
    const unverified = count(assertions, (a) => outcome(a.status) === 'unverified');
    const checks = cases.flatMap((c) => c.checks);
    const problems = cases.reduce(
        (n, c) =>
            n + count([...c.events, ...c.network], (entry) => !entry.tone || entry.tone === 'fail'),
        0,
    );
    const missingShots = cases.reduce(
        (n, c) => n + (c.screenshotError ? 1 : 0) + count(c.timeline, (t) => t.error),
        0,
    );

    if (view.error) add('bad', `运行没有正常完成：${view.error.message ?? view.error}`);
    if (!cases.length && !view.error) add('bad', '没有执行任何用例。');
    if (failed) add('bad', `${failed} 条用例失败，先看下方标红的用例。`);
    if (allSkipped) add('warn', `全部 ${skipped} 条用例均被跳过，没有实际执行。`);
    else if (skipped) add('info', `${skipped} 条用例被跳过。`);
    if (flaky) add('warn', `${flaky} 条用例结果不稳定，请查看重试和前次失败证据。`);
    if (blocked)
        add('warn', `${blocked} 条用例被阻断或没有执行完，它们的结论不代表页面功能是否正确。`);
    if (unverifiedCases || unverified)
        add(
            'warn',
            `${unverified || unverifiedCases} 条预期无法自动判定（未验证），需要补充可观察的预期或人工确认。`,
        );
    const failedChecks = count(checks, (c) => diagnosticTone(c, 'neutral') === 'fail');
    if (failedChecks || problems)
        add('warn', `执行中发现 ${failedChecks + problems} 个页面、脚本或接口错误，详见各用例。`);
    if (count(checks, (c) => outcome(c.status) === 'unverified'))
        add('info', '部分环境检查未观察到对应请求，标为未验证。');
    if (view.modelErrors) add('warn', `模型调用失败 ${view.modelErrors} 次。`);
    if (missingShots) add('warn', `${missingShots} 张截图没有采集成功，证据不完整。`);
    if (view.warnings?.length) add('warn', `读取用例时有 ${view.warnings.length} 条警告。`);
    if (view.selection && view.selection.selected < view.selection.total)
        add(
            'info',
            `Excel 共 ${view.selection.total} 条，本轮执行 ${view.selection.selected} 条。`,
        );
    if (view.pendingWrite) add('bad', '存在未确认的写操作，核对 logs/checkpoint.json 后再重跑。');
    if (view.modelCalls === 0 && view.kind !== '录制回放（Playwright）')
        add('info', '本轮没有调用模型，结果来自固定规则和断言。');

    let verdict;
    if (interrupted || view.interrupted)
        verdict = { level: 'bad', text: INTERRUPTED_REPLAY_VERDICT };
    else if (signals.some((s) => s.level === 'bad')) verdict = { level: 'bad', text: '未通过' };
    else if (allSkipped) verdict = { level: 'warn', text: '未执行' };
    else if (flaky) verdict = { level: 'warn', text: '结果不稳定，需要复核' };
    else if (signals.some((s) => s.level === 'warn'))
        verdict = { level: 'warn', text: '通过，但需要复核' };
    else verdict = { level: 'ok', text: '通过，证据完整' };
    if (!signals.length && verdict.level === 'ok')
        add('ok', '全部用例通过，没有发现阻断、未验证预期、执行错误或缺失的截图。');
    return {
        verdict,
        signals,
        passed,
        failed,
        blocked,
        flaky,
        skipped,
        unverified,
        total: cases.length,
    };
}

export async function readRun(out) {
    const file = path.join(out, RUN_FILES.results);
    const summary = JSON.parse(await fs.readFile(file, 'utf8'));
    // Playwright records absolute, symlink-resolved paths (/tmp → /private/tmp on macOS).
    if (summary.suites && summary.config) return fromPlaywright(summary, await fs.realpath(out));
    if ('authStatus' in summary || 'moduleUrl' in summary) return fromStructured(summary);
    return fromOrdinary(summary);
}

// Terminal colour codes leak into Playwright error messages ("[2m … [22m").
const plain = (value) => String(value ?? '').replace(/\u001b?\[[0-9;]*m/g, '');
const escape = (value) =>
    plain(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
/** Local wall-clock time with milliseconds, e.g. 13:47:26.195. */
const clock = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n, size = 2) => String(n).padStart(size, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};
const localDate = (iso) => {
    const date = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const href = (file) => file.split('/').map(encodeURIComponent).join('/');
const ORDER = { fail: 0, flaky: 1, blocked: 2, unverified: 3, neutral: 4, pass: 5 };

function screenshotButton(file, caption, attachmentLabel) {
    if (!file) return '';
    const src = href(file);
    const label = escape(caption);
    const thumbnail = `<img loading="lazy" src="${src}" alt="">
        <span class="shot-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6m-3-3v6"/></svg></span>`;
    return `<button type="button" class="${attachmentLabel ? 'image-link' : 'shot'}" data-shot="${src}" data-caption="${label}" aria-haspopup="dialog" aria-label="放大查看：${label}">${attachmentLabel ? escape(attachmentLabel) : thumbnail}</button>`;
}

function caseHtml(c) {
    const kind = outcome(c.status);
    const shot = (file, label) => screenshotButton(file, `${c.id} · ${c.title} · ${label}`);
    const rows = c.timeline
        .map(
            (t) => `<li class="${outcome(t.status)}">
  <div class="step"><span class="badge ${outcome(t.status)}">${escape(t.status || '')}</span>
  <b>${escape(t.label)}</b> ${escape(t.text || '')}${t.at ? ` <small>${escape(clock(t.at))}</small>` : ''}
  ${(t.notes || []).map((note) => `<div class="note">${escape(note)}</div>`).join('')}
  ${t.error ? `<div class="note">${escape(t.error)}</div>` : ''}</div>
  ${shot(t.screenshot, t.label)}
</li>`,
        )
        .join('\n');
    const issues = [
        ...c.checks.map((x) => ({
            tone: diagnosticTone(x, 'neutral'),
            text: `${x.status} · ${x.text}${x.reason ? '：' + x.reason : ''}`,
        })),
        ...c.events,
        ...c.network,
    ];
    return `<details class="case ${kind}" ${kind === 'pass' || kind === 'neutral' ? '' : 'open'} id="case-${escape(c.id)}">
<summary><span class="badge ${kind}">${escape(c.status)}</span> <span class="case-id">${escape(c.id)}</span> <span class="case-title">${escape(c.title)}</span>
<small>${escape(c.location || '')}${c.durationMs != null ? ` · ${Math.round(c.durationMs)}ms` : ''}</small></summary>
<div class="case-body">
${c.reason ? `<p class="reason">${escape(c.reason)}${c.category ? ` <small>（${escape(c.category)}）</small>` : ''}</p>` : ''}
${issues.length ? `<details class="diagnostics"><summary>检查与诊断（${issues.length}）</summary><ul class="issues">${issues.map((i) => `<li class="${escape(i.tone || 'fail')}">${escape(i.text ?? i)}</li>`).join('')}</ul></details>` : ''}
${rows ? `<h3>执行步骤</h3><ol class="timeline">${rows}</ol>` : ''}
${c.screenshot ? `<div class="final"><b>用例结束时的页面</b>${shot(c.screenshot, '用例结束')}</div>` : ''}
${c.screenshotError ? `<p class="note">${escape(c.screenshotError)}</p>` : ''}
${c.trace ? `<p class="files">执行轨迹：<a href="${href(c.trace)}">${escape(c.trace)}</a> · 查看：<code>npx playwright show-trace ${escape(c.trace)}</code></p>` : ''}
${c.traceError ? `<p class="note">${escape(c.traceError)}</p>` : ''}
${(c.attachments || []).length ? `<p class="files">${c.attachments.map((a) => (a.isImage ? screenshotButton(a.path, `${c.id} · ${a.name}`, a.name) : `<a href="${href(a.path)}">${escape(a.name)}</a>`)).join(' · ')}</p>` : ''}
${c.directory ? `<p class="files">证据目录：<a href="${href(c.directory)}/">${escape(c.directory)}/</a></p>` : ''}
</div></details>`;
}

export function renderIndex(view, assessment, files, hasTrace = false) {
    const cases = [...view.cases].sort(
        (a, b) => ORDER[outcome(a.status)] - ORDER[outcome(b.status)],
    );
    const { verdict, signals } = assessment;
    const stat = (label, value, kind) =>
        `<div class="stat ${value ? kind : ''}"><b>${value}</b><span>${label}</span></div>`;
    const links = files
        .map(
            ([name, description]) =>
                `<li><a href="${href(name)}">${escape(name)}</a><span>${escape(description)}</span></li>`,
        )
        .join('');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>falcon · ${escape(verdict.text)}</title>
<style>${reportStyles}</style></head><body>
<header class="masthead"><div class="brand-row"><div class="brand"><svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h4l3-7 4 13 3-8h4"/></svg>falcon</div>
<small>生成于 ${escape(new Date().toLocaleString('zh-CN'))}</small></div></header>
<main><h1>测试报告</h1>
<p class="meta">${escape(view.kind)}${view.source ? ' · ' + escape(view.source) : ''}${view.provider ? ' · 模型：' + escape(view.provider) : ''}</p>
<div class="overview"><section class="verdict ${verdict.level}"><h2>${escape(verdict.text)}</h2>
<ul class="signals">${signals.map((s) => `<li class="${s.level}">${escape(s.text)}</li>`).join('')}</ul></section>
<div class="stats">${stat('用例', assessment.total, '')}${stat('通过', assessment.passed, 'pass')}${stat('失败', assessment.failed, 'fail')}${assessment.flaky ? stat('不稳定', assessment.flaky, 'blocked') : ''}${assessment.skipped ? stat('跳过', assessment.skipped, '') : ''}${stat('阻断/未完成', assessment.blocked, 'blocked')}${stat('未验证预期', assessment.unverified, 'unverified')}</div></div>
${view.error?.screenshot && !view.cases.some((c) => c.screenshot === view.error.screenshot) ? `<section class="run-evidence final"><h3>运行失败时的页面</h3>${screenshotButton(view.error.screenshot, '运行失败时的页面')}</section>` : ''}
${view.externalReport ? `<p>Playwright 原始报告：<a href="${href(view.externalReport)}">${escape(view.externalReport)}</a></p>` : ''}
<h2 class="section-title">用例</h2>
${cases.map(caseHtml).join('\n') || '<p>没有用例结果。</p>'}
<h2 class="section-title">本目录文件</h2><div class="resources"><ul class="file-list">${links}</ul>
${hasTrace || view.cases.some((c) => c.trace) ? `<p><small>执行轨迹记录了每次点击、页面变化和接口请求：<code>npx playwright show-trace 文件路径</code>，或把文件拖到 https://trace.playwright.dev 打开（只在本机浏览器中解析）。通过的用例不保留轨迹。</small></p>` : ''}
</div></main>
<dialog class="viewer" aria-labelledby="viewer-title"><header><span class="viewer-title" id="viewer-title">截图</span>
<button type="button" autofocus aria-label="关闭大图"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><img alt=""></dialog>
<script>(${setupScreenshotViewer.toString()})();</script>
</body></html>
`;
}

/** Plain-text report for runs whose executor does not write summary.md. */
export function renderSummary(view, assessment) {
    const cell = (v) =>
        plain(v)
            .replace(/[|\n\r]+/g, ' ')
            .slice(0, 300);
    const lines = [
        `# ${assessment.verdict.text}`,
        '',
        `${view.kind}${view.source ? '：' + view.source : ''}`,
        '',
        ...assessment.signals.map((s) => `- ${s.text}`),
        '',
        [
            `通过 ${assessment.passed}`,
            `失败 ${assessment.failed}`,
            ...(assessment.flaky ? [`不稳定 ${assessment.flaky}`] : []),
            ...(assessment.skipped ? [`跳过 ${assessment.skipped}`] : []),
            `阻断/未完成 ${assessment.blocked}`,
            `共 ${assessment.total}。`,
        ].join('，'),
        '',
        '|编号|用例|结果|原因|证据|',
        '|---|---|---|---|---|',
        ...view.cases.map(
            (c) =>
                `|${cell(c.id)}|${cell(c.title)}|${cell(c.status)}|${cell(c.reason)}|${c.directory ? `[${c.directory}](${c.directory}/)` : ''}|`,
        ),
        '',
    ];
    return lines.join('\n');
}

const DESCRIPTIONS = [
    [RUN_FILES.summary, '文字版报告，适合直接阅读或交给 AI'],
    [RUN_FILES.results, '机器可读的完整结果'],
    [RUN_FILES.workbook, '每条用例一行的结果表格'],
    ['cases/', '每条用例一个目录：按顺序编号的步骤与预期截图；未通过的用例另有 trace.zip'],
    ['run/', '整轮级别的截图：启动或登录失败'],
    [RUN_FILES.trace, 'Playwright 执行轨迹（旧版整轮轨迹）'],
    ['playwright-report/index.html', 'Playwright 原始 HTML 报告'],
    ['logs/', '过程文件：用例解析、选择范围、模型决策、浏览器事件、进度'],
];

async function exists(file) {
    return fs.access(file).then(
        () => true,
        () => false,
    );
}

async function reportFile(index) {
    try {
        const stat = await fs.stat(index);
        return stat.isFile() ? stat : null;
    } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return null;
    }
}

function isProjectRelative(directory) {
    return !path.isAbsolute(directory) && directory.split(path.sep)[0] !== '..';
}

export async function latestReportIndex(cwd = process.cwd()) {
    const root = projectRunsDirectory(cwd);
    let latest;
    try {
        latest = JSON.parse(await fs.readFile(path.join(root, LATEST_RUN), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const directory = latest?.directory;
    if (typeof directory === 'string' && directory) {
        if (path.isAbsolute(directory)) {
            // Legacy default runs were stored as absolute paths. Check for the same run in
            // this project before following an old pointer to a still-accessible project.
            if (latest.version === undefined && !isProjectRelative(path.relative(cwd, directory))) {
                const parts = path.normalize(directory).split(path.sep);
                const runRoot = parts.findLastIndex(
                    (part, index) => part === 'laya-pilot' && parts[index - 1] === 'runs',
                );
                if (runRoot >= 0) {
                    const copied = path.join(root, ...parts.slice(runRoot + 1), RUN_FILES.index);
                    if (await reportFile(copied)) return copied;
                }
            }
            const index = path.join(directory, RUN_FILES.index);
            if (await reportFile(index)) return index;
        } else if (isProjectRelative(path.normalize(directory))) {
            const index = path.resolve(cwd, directory, RUN_FILES.index);
            if (await reportFile(index)) return index;
        }
    }

    // Older or moved projects may have reports without a usable latest pointer.
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
    });
    let newest;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const index = path.join(root, entry.name, RUN_FILES.index);
        const stat = await reportFile(index);
        if (stat && (!newest || stat.mtimeMs > newest.mtime))
            newest = { index, mtime: stat.mtimeMs };
    }
    return newest?.index;
}

/** Write index.html and update runs/laya-pilot/latest.json for a finished run. */
export async function finalizeRun(out, cwd = process.cwd(), options) {
    const view = await readRun(out);
    const assessment = assess(view, options);
    // Every run gets a text report; Excel runners write a richer one themselves.
    if (!(await exists(path.join(out, RUN_FILES.summary))))
        await fs.writeFile(path.join(out, RUN_FILES.summary), renderSummary(view, assessment));
    const files = [];
    for (const [name, description] of DESCRIPTIONS)
        if (await exists(path.join(out, name))) files.push([name, description]);
    const hasTrace = await exists(path.join(out, RUN_FILES.trace));
    await fs.writeFile(
        path.join(out, RUN_FILES.index),
        renderIndex(view, assessment, files, hasTrace),
    );
    const latest = path.join(projectRunsDirectory(cwd), LATEST_RUN);
    const directory = path.resolve(out);
    const relative = path.relative(cwd, directory);
    const pointer = isProjectRelative(relative) ? relative || '.' : directory;
    try {
        writePrivateJson(latest, {
            version: 2,
            directory: pointer,
            index: path.join(pointer, RUN_FILES.index),
            verdict: assessment.verdict.text,
            passed: assessment.passed,
            failed: assessment.failed,
            blocked: assessment.blocked,
            total: assessment.total,
            flaky: assessment.flaky,
            skipped: assessment.skipped,
        });
    } catch (error) {
        console.warn(`Could not update latest report (${error.code || error.message}): ${latest}`);
    }
    console.log(`REPORT ${path.join(out, RUN_FILES.index)}`);
    return { view, assessment };
}

/** results.xlsx for ordinary Excel runs: one row per case and one per step/expectation. */
export async function writeCaseWorkbook(out, summary, python) {
    const view = fromOrdinary(summary);
    const sheets = [
        {
            title: '用例结果',
            header: [
                '工作表位置',
                '编号',
                '用例',
                '结果',
                '原因分类',
                '说明',
                '通过断言',
                '断言总数',
                '证据目录',
            ],
            link: 8,
            rows: view.cases.map((c) => [
                c.location,
                c.id,
                c.title,
                c.status,
                c.category || '',
                c.reason || '',
                count(c.assertions, (a) => outcome(a.status) === 'pass'),
                c.assertions.length,
                c.directory,
            ]),
        },
        {
            title: '步骤与预期',
            header: ['编号', '用例', '阶段', '原文', '状态', '时间', '截图'],
            link: 6,
            rows: view.cases.flatMap((c) =>
                c.timeline.map((t) => [
                    c.id,
                    c.title,
                    t.label,
                    t.text || '',
                    t.status || '',
                    t.at ? `${localDate(t.at)} ${clock(t.at)}` : '',
                    t.screenshot || t.error || '',
                ]),
            ),
        },
    ];
    const script = fileURLToPath(new URL('./run_report_excel.py', import.meta.url));
    await new Promise((resolve, reject) => {
        const child = spawn(python, [script, path.join(out, RUN_FILES.workbook)], {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let details = '';
        child.stderr.on('data', (chunk) => (details = (details + chunk).slice(-1500)));
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0 ? resolve() : reject(Error('结果表格导出失败：' + details)),
        );
        child.stdin.end(JSON.stringify({ sheets }));
    });
}
