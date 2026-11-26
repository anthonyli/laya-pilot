import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { observe, target, discoverRowLabels } from '../../scripts/lib/dom.mjs';
import {
    configureControlBindings,
    validateControlBindings,
} from '../../scripts/lib/control-bindings.mjs';
const svg = '<svg width="20" height="20"><rect width="20" height="20"/></svg>';
const model = {
    choose: async (_, criteria) => {
        const choice = Object.keys(criteria).find((key) => !['停止', 'Stop'].includes(key));
        return { choice, probabilities: { [choice]: 1 }, margin: 1 };
    },
};
async function withPage(fn) {
    const browser = await chromium.launch({ headless: true });
    try {
        await fn(await browser.newPage());
    } finally {
        await browser.close();
    }
}

test('unknown controls retain row/frame context; reliable labels target their host and ignore decoration/background', async () => {
    await withPage(async (page) => {
        await page.setContent(`<table><tr data-row-key="a"><td>记录甲</td><td><button id="unknown">${svg}</button></td></tr></table>
          <button aria-label="导出">${svg}</button><button title="下载">${svg}</button>
          <span id="label">打印</span><button aria-labelledby="label">${svg}</button>
          <button><svg width="20" height="20"><title>归档</title></svg></button>
          <button><svg aria-hidden="true" width="20" height="20"><title>删除</title></svg>保存</button>
          <svg width="20" height="20"><title>独立装饰</title></svg>
          <button hidden id="hidden">${svg}</button><button id="hidden-child">${svg}<span style="display:none">错误名称</span></button><div inert><button id="inert">${svg}</button></div>
          <button id="hidden-svg"><svg style="display:none"><title>导出</title></svg></button>
          <button id="hidden-icon-ancestor"><span aria-hidden="true"><svg width="20" height="20" aria-label="删除"></svg></span></button>
          <button id="blank-label" aria-label="   ">${svg}</button>
          <iframe srcdoc='<button id="framed"><svg width="20" height="20"></svg></button>'></iframe>`);
        await page.locator('iframe').waitFor();
        const snap = await observe(page);
        assert.deepEqual(
            snap.controls.filter((c) => c.frame === 0).map((c) => c.name),
            ['导出', '下载', '打印', '归档', '保存'],
        );
        assert.ok(snap.controls.every((c) => c.tag === 'button'));
        const unknown = snap.unidentifiedControls.find((c) => c.elementId === 'unknown');
        assert.equal(unknown.rowKey, 'a');
        assert.match(unknown.context, /记录甲/);
        assert.ok(unknown.ref);
        assert.equal(snap.unidentifiedControls.find((c) => c.elementId === 'framed').frame, 1);
        assert.equal(snap.unidentifiedControls.length, 6);
        await page.evaluate(
            (svg) =>
                document.body.insertAdjacentHTML(
                    'beforeend',
                    `<dialog open><button id="dialog-unknown">${svg}</button></dialog>`,
                ),
            svg,
        );
        const modal = await observe(page);
        assert.deepEqual(
            modal.unidentifiedControls.filter((c) => c.frame === 0).map((c) => c.elementId),
            ['dialog-unknown'],
        );
        assert.equal(modal.controls.length, 0);
        assert.equal(modal.unidentifiedControls.length, 1);
    });
});

test('unlabelled hover requires an associated tooltip; missing semantics never reach the model or click', async () => {
    await withPage(async (page) => {
        await page.setContent(`<button id="unknown">${svg}</button><div role="tooltip" id="tip" hidden>导出</div>
            <script>unknown.onmouseenter=()=>{tip.hidden=false;unknown.setAttribute('aria-describedby','tip')}; unknown.onmouseleave=()=>tip.hidden=true;</script>`);
        let snap = await discoverRowLabels(page, '');
        assert.equal(snap.controls[0].name, '导出');
        assert.equal(snap.controls[0].tag, 'button');
        await page.setContent(`<button id="unknown">${svg}</button><div role="tooltip" id="tip" hidden>导出</div>
            <script>unknown.onmouseenter=()=>tip.hidden=false;unknown.onmouseleave=()=>tip.hidden=true;</script>`);
        snap = await discoverRowLabels(page, '');
        assert.equal(snap.unidentifiedControls.length, 1);
        let calls = 0;
        await assert.rejects(
            target(
                page,
                {
                    choose: () => {
                        calls++;
                        throw Error('must not choose');
                    },
                },
                '导出',
            ),
            (e) => e.category === '控件语义不明确',
        );
        assert.equal(calls, 0);
        await page.setContent('<p>没有控件</p>');
        await assert.rejects(target(page, model, '导出'), (e) => e.category === '页面控件不足');
        await page.setContent(
            `<button aria-label="导出">${svg}</button><button aria-label="导出">${svg}</button>`,
        );
        await assert.rejects(target(page, model, '导出'), (e) => e.category === '目标不唯一');
        // Cached hover labels are tied to the actual node, not copied attributes.
        await page.setContent(`<button id="icon" aria-label="图标: export">${svg}</button><div role="tooltip" id="tip" hidden>导出</div>
            <script>icon.onmouseenter=()=>tip.hidden=false;icon.onmouseleave=()=>tip.hidden=true;</script>`);
        assert.equal((await discoverRowLabels(page, '')).controls[0].name, '导出');
        await page.locator('#icon').evaluate((e) => e.replaceWith(e.cloneNode(true)));
        assert.equal((await observe(page)).controls[0].name, '图标: export');
    });
});

test('explicit binding requires exact page, unique current control, and unchanged decision target', async () => {
    await withPage(async (page) => {
        await page.route('http://binding.test/**', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: `<button id="unknown">${svg}</button>`,
            }),
        );
        await page.goto('http://binding.test/page');
        const binding = { url: page.url(), selector: '#unknown', name: '导出' };
        configureControlBindings(page, [binding]);
        let snap = await observe(page);
        assert.equal(snap.controls[0].name, '导出');
        assert.equal(snap.controls[0].bindingFingerprint, undefined);
        const first = snap.controls[0].ref;
        await page.locator('#unknown').evaluate((e) => e.replaceWith(e.cloneNode(true)));
        snap = await observe(page);
        assert.equal(snap.controls[0].name, '导出');
        assert.notEqual(snap.controls[0].ref, first);
        await assert.rejects(
            target(
                page,
                {
                    choose: async (...args) => {
                        await page
                            .locator('#unknown')
                            .evaluate((e) => e.setAttribute('aria-label', '删除'));
                        return model.choose(...args);
                    },
                },
                '导出报表',
            ),
            (e) => e.category === 'DOM已变化',
        );
        snap = await observe(page);
        assert.equal(snap.controls[0].name, '删除');
        assert.equal(snap.bindingDiagnostics[0].code, 'binding-label-conflict');
        await page.locator('#unknown').evaluate((e) => {
            e.removeAttribute('aria-label');
            e.after(e.cloneNode(true));
        });
        snap = await observe(page);
        assert.equal(snap.controls.length, 0);
        assert.equal(snap.unidentifiedControls.length, 2);
        assert.equal(snap.bindingDiagnostics[0].code, 'ambiguous-binding');
        await page.goto('http://binding.test/other');
        snap = await observe(page);
        assert.equal(snap.controls.length, 0);
        assert.equal(snap.bindingDiagnostics[0].code, 'binding-url-mismatch');
        assert.throws(
            () => validateControlBindings([{ ...binding, selector: 'button:nth-child(1)' }]),
            /位置/,
        );
        configureControlBindings(page, [{ ...binding, url: page.url(), selector: '[' }]);
        assert.equal((await observe(page)).bindingDiagnostics[0].code, 'invalid-selector');
        configureControlBindings(page, [
            { ...binding, url: page.url() },
            { ...binding, url: page.url(), name: '删除' },
        ]);
        snap = await observe(page);
        assert.equal(snap.controls.length, 0);
        assert.equal(snap.bindingDiagnostics[0].code, 'conflicting-bindings');
        await page.setContent(
            `<table><tr data-row-key="first"><td>记录甲</td><td><button id="unknown">${svg}</button></td></tr></table>`,
        );
        configureControlBindings(page, [{ ...binding, url: page.url() }]);
        await assert.rejects(
            target(
                page,
                {
                    choose: async (...args) => {
                        await page
                            .locator('tr')
                            .evaluate((e) => e.setAttribute('data-row-key', 'second'));
                        return model.choose(...args);
                    },
                },
                '导出报表',
            ),
            (e) => e.category === 'DOM已变化',
        );
    });
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || 'python3';
function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}
test(
    'public CLI reports unknown controls and validates explicit binding without changing workbook',
    { timeout: 120000 },
    async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-control-diagnostics-'));
        const server = http.createServer((req, res) =>
            res
                .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                .end(`<h1>列表</h1><button id="unknown">${svg}</button>`),
        );
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            const url = `http://127.0.0.1:${server.address().port}/`;
            const workbook = path.join(directory, 'cases.xlsx');
            const written = await run(python, [
                '-c',
                `import sys\nfrom openpyxl import Workbook\nb=Workbook();s=b.active;s.append(['用例编号','用例名称','测试步骤','预期结果']);s.append(['001','未识别控件','观察页面','页面显示“列表”']);b.save(sys.argv[1])`,
                workbook,
            ]);
            assert.equal(written.code, 0, written.stderr);
            const before = await fs.readFile(workbook);
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
            const bindings = path.join(directory, 'bindings.json');
            await fs.writeFile(
                bindings,
                JSON.stringify([{ url, selector: '#unknown', name: '导出' }]),
            );
            for (const bound of [false, true]) {
                const out = path.join(directory, bound ? 'bound' : 'unknown');
                const args = [
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
                    '--out',
                    out,
                ];
                if (bound) args.push('--control-bindings', bindings);
                const result = await run(process.execPath, args, { cwd: root, env });
                assert.equal(result.code, 0, result.stdout + result.stderr);
                const summary = JSON.parse(
                    await fs.readFile(path.join(out, 'results.json'), 'utf8'),
                );
                assert.equal(summary.metrics.model_calls, 0);
                assert.equal(summary.results[0].unidentified_controls.length, bound ? 0 : 1);
                const evidence = JSON.parse(
                    await fs.readFile(
                        path.join(out, summary.results[0].evidence_dir, 'controls.json'),
                        'utf8',
                    ),
                );
                if (bound) assert.equal(evidence.controls[0].name, '导出');
                else assert.equal(evidence.unidentifiedControls[0].elementId, 'unknown');
                // The section is written only when there is something to diagnose.
                const markdown = await fs.readFile(path.join(out, 'summary.md'), 'utf8');
                const diagnosed =
                    summary.results[0].unidentified_controls.length > 0 ||
                    summary.results[0].control_binding_diagnostics.length > 0;
                assert.equal(markdown.includes('未识别控件与绑定诊断'), diagnosed);
                await fs.access(path.join(out, 'results.xlsx'));
            }
            assert.deepEqual(await fs.readFile(workbook), before);
        } finally {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);
