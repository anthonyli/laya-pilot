import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { attachRecordedCases, exportRecording } from '../../scripts/lib/recorded-excel.mjs';
import { lines } from '../../scripts/lib/language.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';
import { Engine } from '../../scripts/lib/engine.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../scripts/run.mjs', import.meta.url));
const require = createRequire(import.meta.url);

test('recorded form steps target the open Ant drawer across legacy and role-based markup', async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`<textarea aria-label="Description">background</textarea>
        <div class="ant-drawer-open"><div class="ant-drawer-content">
            <textarea aria-label="Description"></textarea></div></div>`);
    const engine = new Engine(page, null, { delay: 0 });
    for (const version of ['legacy', 'semantic']) {
        if (version === 'semantic')
            await page
                .locator('.ant-drawer-open')
                .evaluate((el) => el.setAttribute('role', 'dialog'));
        await engine.step(`在弹窗的「Description」输入框中输入「${version}」`);
        assert.equal(await page.locator('.ant-drawer-content textarea').inputValue(), version);
    }
    assert.equal(await page.locator('body > textarea').inputValue(), 'background');
});

test('records a portal tooltip as a menu name and binds repeated action icons to the clicked row', async (t) => {
    const svg = '<svg width="24" height="24"><rect width="24" height="24"/></svg>';
    const html = `<style>nav div,td span{display:inline-block;cursor:pointer} [role=tooltip]{pointer-events:none}</style>
        <nav><div data-tip="Overview">${svg}</div><div data-tip="Indicator Center">${svg.replace('<svg ', '<svg class="menu-indicators" ')}</div>
        <a href="#list" hidden>Realtime Indicator</a></nav><button>Realtime</button>
        <table><thead><tr><th>ID</th><th>Actions</th></tr></thead><tbody>
        ${['First', 'Second'].map((id) => `<tr><td>${id}</td><td><span title="Delete">${svg}</span></td></tr>`).join('')}
        </tbody></table><script>
        for(const item of document.querySelectorAll('[data-tip]')){
          item.onpointerenter=()=>{const tip=document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent=item.dataset.tip;document.body.append(tip)};
          item.onpointerleave=()=>document.querySelector('[role=tooltip]')?.remove();
          if(item.dataset.tip==='Indicator Center'){
            const svg=item.querySelector('svg');
            item.addEventListener('pointerenter',()=>svg.setAttribute('class','highlighted'));
            item.addEventListener('pointerleave',()=>svg.setAttribute('class','menu-indicators'));
          }
          item.onclick=()=>{if(item.dataset.tip==='Indicator Center')document.querySelector('a').hidden=false};
        }
        for(const item of document.querySelectorAll('td span')) item.onclick=()=>{document.body.dataset.clicked=item.closest('tr').cells[0].textContent};
        </script>`;
    const server = http.createServer((_, response) =>
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(html),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const recording = await captureRecording({
        playwright: { chromium },
        url,
        headless: true,
        async onReady(page) {
            const item = page.locator('[data-tip="Indicator Center"]');
            await item.hover();
            await page.getByRole('tooltip').filter({ hasText: 'Indicator Center' }).waitFor();
            await item.click();
            await page.getByRole('link', { name: 'Realtime Indicator' }).click();
            await page
                .getByRole('row')
                .filter({ hasText: 'Second' })
                .locator('[title=Delete]')
                .click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    assert.deepEqual(recording.pages, [url, url + '#list']);
    assert.deepEqual(generateRecordedCases(recording, { splitCases: true }).pages, recording.pages);
    const steps = generateRecordedCases(recording).cases.flatMap((entry) => lines(entry.steps));
    const hintedMenu = '展开「Indicator Center」导航菜单（图标「menu-indicators」）';
    assert.ok(steps.includes(hintedMenu));
    const bind = '在「ID」列中定位值为「Second」的唯一记录';
    assert.deepEqual(steps.slice(-2), [bind, '点击操作图标「Delete」']);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-icon-recording-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'icons.spec.cjs'), renderRecordingSpec(recording));
    await exec(process.execPath, [cli, 'replay', 'icons.spec.cjs', '--out', 'report'], {
        cwd: dir,
        env: { ...process.env, LAYA_HOME: path.join(dir, 'runtime'), BROWSER_CHANNEL: '' },
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    const config = {
        url,
        origins: [new URL(url).origin],
        delay: 0,
        pageTimeout: 2500,
        assertTimeout: 300,
        allowWrite: false,
    };
    const engine = new Engine(page, null, config);
    await assert.rejects(engine.step('点击「Realtime Indicator」链接'), /无法唯一定位/);
    await page
        .locator('[data-tip="Overview"]')
        .evaluate((el) => el.addEventListener('pointerenter', () => (el.dataset.probed = 'yes')));
    await engine.step(hintedMenu);
    assert.equal(await page.locator('[data-tip="Overview"]').getAttribute('data-probed'), null);
    await page.reload();
    await page
        .locator('[data-tip="Overview"] svg')
        .evaluate((el) => el.setAttribute('class', 'moved-menu'));
    await engine.step('展开「Indicator Center」导航菜单（图标「moved-menu」）');
    await page.reload();
    await engine.step('展开「Indicator Center」导航菜单');
    await engine.step('点击「Realtime Indicator」链接');
    await engine.step(bind);
    await assert.rejects(engine.step('点击操作图标「Delete」'), /只读/);
    assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
    config.allowWrite = true;
    await engine.step('点击操作图标「Delete」');
    assert.equal(await page.locator('body').getAttribute('data-clicked'), 'Second');
    await assert.rejects(engine.step('点击操作图标「Delete」'), /无法唯一定位/);
});

test('records through login and reload, retains unresolved steps, and moves the toolbar off page controls', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-ordered-recording-'));
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
            request.url === '/login'
                ? '<form action="/index/realtime"><input aria-label="Account"><input type="password" aria-label="Password"><button>Login</button></form>'
                : `<button style="position:fixed;right:12px;bottom:12px;width:220px;height:44px">Edit Area</button>
               <button role="tab" style="position:fixed;right:12px;top:12px;width:220px;height:44px">Run Area</button>
               <div tabindex="0">Custom widget</div><button>Add</button><button>Cancel</button>`,
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}/login`;
    const recording = await captureRecording({
        playwright: { chromium },
        url,
        headless: true,
        async onReady(page) {
            await page.getByLabel('Account').fill('tester');
            await page.getByLabel('Password').pressSequentially('private-fixture');
            await page.getByRole('button', { name: 'Login' }).click();
            await page.waitForURL('**/index/realtime*');
            const clickButton = (name) => page.getByRole('button', { name, exact: true }).click();
            await clickButton('Edit Area');
            await page.getByRole('button', { name: '添加检查点' }).press('Tab');
            await page.getByRole('button', { name: '移至底部' }).press('Enter');
            await page.getByRole('tab', { name: 'Run Area' }).click();
            await page.getByText('Custom widget').click();
            await page.reload();
            await page.getByRole('button', { name: '移至顶部' }).waitFor();
            await clickButton('移至顶部');
            await clickButton('Edit Area');
            await clickButton('Add');
            for (let i = 0; i < 25; i++) await clickButton('Cancel');
            await clickButton('完成录制');
        },
    });
    const generated = generateRecordedCases(recording);
    assert.deepEqual(
        generated.cases.map((item) => item.title),
        ['登录', '区域切换', '新增配置'],
    );
    const steps = generated.cases.flatMap((item) => lines(item.steps));
    assert.deepEqual(steps, [
        `打开网址 ${url}`,
        '在「Account」输入框中输入「tester」',
        '待补录：敏感输入或文件操作需要独立的测试数据配置。',
        '点击「Login」按钮',
        '切换到「Edit Area」区域',
        '切换到「Run Area」区域',
        '待补录：可点击元素没有可识别的控件角色。',
        `打开网址 ${new URL('/index/realtime?', url).href}`,
        '切换到「Edit Area」区域',
        '点击「Add」按钮',
        ...Array(25).fill('点击「Cancel」按钮'),
    ]);
    const spec = attachRecordedCases(renderRecordingSpec(recording), generated);
    assert.doesNotMatch(JSON.stringify(recording) + spec, /private-fixture/);
    assert.match(
        spec,
        /throw new Error[\s\S]*Login[\s\S]*Edit Area[\s\S]*Run Area[\s\S]*throw new Error[\s\S]*page.goto[\s\S]*Edit Area[\s\S]*Cancel/,
    );
    const specFile = path.join(dir, 'sequence.spec.cjs');
    const workbook = path.join(dir, 'sequence.xlsx');
    await fs.writeFile(specFile, spec);
    const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
    assert.deepEqual(await exportRecording(specFile, workbook, python), generated);
    const { stdout: visits } = await exec(python, [
        '-c',
        "import sys,json; from openpyxl import load_workbook; w=load_workbook(sys.argv[1],read_only=True); print(json.dumps([row[1] for row in list(w['录制页面'].values)[1:]]))",
        workbook,
    ]);
    assert.deepEqual(JSON.parse(visits), recording.pages);
    const reader = fileURLToPath(new URL('../../scripts', import.meta.url));
    const { stdout } = await exec(
        python,
        [
            '-c',
            'import io, sys, json; sys.stdin = io.StringIO(""); from worker import read_excel; print(json.dumps([case["steps"] for case in read_excel(sys.argv[1])["cases"]]))',
            workbook,
        ],
        { env: { ...process.env, PYTHONPATH: reader } },
    );
    assert.deepEqual(
        JSON.parse(stdout),
        generated.cases.map((item) => item.steps),
    );
});

test('captures and replays native select options using their actual labels', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-select-recording-'));
    const server = http.createServer((_, response) =>
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
            <select aria-label="Region" size="3">
                <option value="default" selected>Choose a region</option>
                <option value="eu" label="Europe">Legacy copy</option>
                <option value="asia">Asia</option>
            </select>`),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(dir, { recursive: true, force: true });
    });

    const recording = await captureRecording({
        playwright: { chromium },
        url: `http://127.0.0.1:${server.address().port}/`,
        headless: true,
        async onReady(page) {
            // Click real options so the change events are trusted. Chromium exposes the
            // text node to its role locator even when the option has a label attribute.
            await page.locator('option[value="eu"]').click();
            await page.locator('option[value="asia"]').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
    assert.deepEqual(
        recording.actions
            .filter((action) => action.kind === 'select')
            .map((action) => action.value),
        ['Europe', 'Asia'],
    );
    const name = 'select.spec.cjs';
    await fs.writeFile(path.join(dir, name), renderRecordingSpec(recording));
    const env = { ...process.env, LAYA_HOME: path.join(dir, 'state'), BROWSER_CHANNEL: '' };
    await exec(process.execPath, [cli, 'replay', name, '--out', 'report'], { cwd: dir, env });
    const { stats } = JSON.parse(await fs.readFile(path.join(dir, 'report/results.json'), 'utf8'));
    assert.equal(stats.expected, 1);
});

test('replays one portable spec and keeps evidence when its assertion fails', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const name = 'filter [recorded].spec.cjs';
    const source = `const { test, expect } = require('playwright/test');
test('filter results', async ({ page }) => {
    await page.setContent('<input aria-label="Filter">');
    const filter = page.getByRole('textbox', { name: 'Filter' });
    await filter.fill('sample');
    await expect(filter).toHaveValue('sample', { timeout: 500 });
});`;
    const replay = (out) =>
        exec(process.execPath, [cli, 'replay', name, '--out', out], { cwd: dir });
    const results = async (out) =>
        JSON.parse(await fs.readFile(path.join(dir, out, 'results.json'), 'utf8'));
    await fs.writeFile(path.join(dir, name), source);
    await fs.writeFile(
        path.join(dir, 'unselected.spec.cjs'),
        "throw Error('Unselected spec ran');",
    );

    await replay('passed');
    assert.equal((await results('passed')).stats.expected, 1);
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), source);
    await fs.access(path.join(dir, 'passed', 'playwright-report', 'index.html'));
    await fs.access(path.join(dir, 'passed', 'index.html'));

    // A separate installed CLI and workspace may have two physical copies of Playwright.
    for (const name of ['playwright', 'playwright-core']) {
        await fs.cp(
            path.dirname(require.resolve(`${name}/package.json`)),
            path.join(dir, 'node_modules', name),
            { recursive: true },
        );
    }
    await fs.writeFile(
        path.join(dir, name),
        source.replace("toHaveValue('sample'", "toHaveValue('other'"),
    );
    await assert.rejects(replay('failed'), { code: 1, stdout: /未通过/ });
    const failure = await results('failed');
    assert.equal(failure.stats.unexpected, 1);
    const attachments = failure.suites[0].specs[0].tests[0].results[0].attachments;
    for (const name of ['screenshot', 'trace']) {
        const file = attachments.find((item) => item.name === name)?.path;
        assert.ok(file, `Missing ${name} attachment`);
        await fs.access(file);
    }
});

test('replay reports agree on skipped, expected and flaky Playwright outcomes', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-outcomes-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const spec = 'outcomes.spec.cjs';
    const env = { ...process.env, LAYA_HOME: path.join(dir, 'state'), BROWSER_CHANNEL: '' };
    const run = async (name, body, expected) => {
        await fs.writeFile(
            path.join(dir, spec),
            `const { test, expect } = require('playwright/test');\n${body}`,
        );
        const { stdout } = await exec(process.execPath, [cli, 'replay', spec, '--out', name], {
            cwd: dir,
            env,
        });
        const read = (...file) => fs.readFile(path.join(dir, ...file), 'utf8');
        const index = await read(name, 'index.html');
        const summary = await read(name, 'summary.md');
        const latest = JSON.parse(await read('runs', 'laya-pilot', 'latest.json'));
        assert.ok(stdout.includes(expected.verdict));
        assert.ok(index.includes(`<h2>${expected.verdict}</h2>`));
        assert.ok(summary.startsWith(`# ${expected.verdict}\n`));
        for (const [key, value] of Object.entries(expected)) assert.equal(latest[key], value, key);
        return { stdout, index, summary };
    };

    const skipped = await run('skipped', "test.skip('skipped', async () => {});", {
        verdict: '未执行',
        passed: 0,
        failed: 0,
        skipped: 1,
        flaky: 0,
    });
    assert.doesNotMatch(skipped.index, /全部用例通过|通过，证据完整/);
    assert.match(skipped.stdout, /0 passed · 0 failed · 1 skipped/);

    const mixed = await run(
        'mixed',
        `
        test('passes', async () => { expect(true).toBe(true); });
        test.skip('skipped', async () => {});
        test('expected failure', async () => {
            test.fail();
            expect('known issue').toBe('success');
        });`,
        {
            verdict: '通过，证据完整',
            passed: 2,
            failed: 0,
            skipped: 1,
            flaky: 0,
        },
    );
    assert.match(mixed.summary, /预期失败/);
    assert.match(mixed.stdout, /2 passed · 0 failed · 1 skipped/);

    const flaky = await run(
        'flaky',
        `
        test.describe.configure({ retries: 1 });
        test('flaky browser test', async ({ page }, info) => {
            await page.setContent('<button>Retry fixture</button>');
            expect(info.retry, 'first attempt evidence').toBe(1);
        });`,
        {
            verdict: '结果不稳定，需要复核',
            passed: 0,
            failed: 0,
            skipped: 0,
            flaky: 1,
        },
    );
    assert.match(flaky.stdout, /0 passed · 0 failed · 0 skipped · 1 flaky/);
    assert.match(flaky.index, /first attempt evidence/);
    assert.match(flaky.summary, /first attempt evidence/);
    for (const [name, attachment] of [
        ['test-failed-1.png', /class="image-link" data-shot="([^"]+)"/g],
        ['trace.zip', /href="([^"]+)"/g],
    ]) {
        const link = [...flaky.index.matchAll(attachment)].find(([, href]) => href.endsWith(name));
        assert.ok(link, `missing first attempt ${name} link`);
        await fs.access(path.join(dir, 'flaky', decodeURIComponent(link[1])));
    }
});

test(
    'replay reports an interrupted test separately from a voluntary skip',
    { skip: process.platform === 'win32' },
    async (t) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-replay-interrupt-'));
        t.after(() => fs.rm(dir, { recursive: true, force: true }));
        const spec = 'interrupt.spec.cjs';
        await fs.writeFile(
            path.join(dir, spec),
            `const { test, expect } = require('playwright/test');
test('passes', () => { expect(true).toBe(true); });
test.skip('voluntary skip', () => {});
test('interrupted case', async () => {
    console.log('interrupt fixture ready');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
});
test('queued case', () => {});`,
        );
        const env = { ...process.env, LAYA_HOME: path.join(dir, 'state'), BROWSER_CHANNEL: '' };
        const replay = exec(process.execPath, [cli, 'replay', spec, '--out', 'report'], {
            cwd: dir,
            env,
            timeout: 20_000,
        });
        let stdout = '';
        const interrupt = (chunk) => {
            stdout += chunk;
            if (stdout.includes('interrupt fixture ready')) {
                replay.child.stdout.off('data', interrupt);
                replay.child.kill('SIGINT');
            }
        };
        replay.child.stdout.on('data', interrupt);
        const verdict = '回放已中止，结果不完整';
        await assert.rejects(replay, {
            code: 130,
            stdout: /回放已中止，结果不完整[\s\S]*1 passed · 0 failed · 1 skipped · 2 incomplete/,
        });
        const index = await fs.readFile(path.join(dir, 'report', 'index.html'), 'utf8');
        const summary = await fs.readFile(path.join(dir, 'report', 'summary.md'), 'utf8');
        const latest = JSON.parse(
            await fs.readFile(path.join(dir, 'runs', 'laya-pilot', 'latest.json'), 'utf8'),
        );
        assert.match(index, new RegExp(`<h2>${verdict}</h2>`));
        assert.ok(summary.startsWith(`# ${verdict}\n`));
        assert.match(summary, /\|interrupted case\|中断\|/);
        assert.match(summary, /\|voluntary skip\|跳过\|/);
        assert.match(summary, /\|queued case\|未执行\|/);
        assert.equal(latest.verdict, verdict);
        assert.equal(latest.passed, 1);
        assert.equal(latest.skipped, 1);
        assert.equal(latest.blocked, 2);
    },
);

test(
    'recorder and Excel replay verify separate sessions by origin and account',
    { timeout: 60000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-site-auth-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const { findRecordingAuth } = await import('../../scripts/lib/recording-auth.mjs');
        let expire = false;
        const start = async (site) => {
            const server = http.createServer((req, res) => {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                if (req.url === '/app') {
                    if (expire || !req.headers.cookie?.includes('session=' + site)) {
                        res.writeHead(302, { Location: '/login' }).end();
                        return;
                    }
                    res.end(
                        '<h1>Dashboard</h1><button role="tab" onclick="document.querySelector(\'output\').textContent=\'Area ready\'">Run Area</button><output></output>',
                    );
                } else {
                    res.end(`<form onsubmit="event.preventDefault();document.cookie='session=${site}; path=/';sessionStorage.setItem('site','${site}');location.href='/app'">
                <input aria-label="Account"><input type="password"><button>Login</button></form>`);
                }
            });
            await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
            t.after(async () => {
                server.closeAllConnections();
                await new Promise((ok) => server.close(ok));
            });
            return 'http://127.0.0.1:' + server.address().port + '/login';
        };
        const a = await start('first'),
            b = await start('second');
        const record = (url, options, onReady) =>
            captureRecording({
                url,
                playwright: { chromium },
                authRoot: root,
                headless: true,
                ...options,
                onReady,
            });
        const login = async (url, account, options = {}) =>
            record(url, options, async (page) => {
                assert.equal(await page.locator('input[type=password]').count(), 1);
                await page.getByLabel('Account').fill(account);
                await page.locator('input[type=password]').fill('fixture-only');
                await page.getByRole('button', { name: 'Login' }).click();
                await page.waitForURL('**/app');
                await page.getByRole('tab').click();
                await page.getByRole('button', { name: '添加检查点' }).click();
                await page.getByText('Area ready').click();
                await page.getByRole('button', { name: '完成录制' }).click();
            });
        const initial = await login(a, 'tester');
        const first = await findRecordingAuth(root, a, 'tester');
        assert.ok(first);
        assert.equal((await fs.stat(first.authState)).mode & 0o777, 0o600);
        assert.doesNotMatch(await fs.readFile(first.authState, 'utf8'), /fixture-only/);
        assert.equal(await findRecordingAuth(root, b), null);
        await login(b, 'tester');
        const second = await findRecordingAuth(root, b, 'tester');
        assert.notEqual(first.authState, second.authState);
        const reused = await record(a, {}, async (page) => {
            assert.equal(new URL(page.url()).pathname, '/app');
            assert.equal(await page.evaluate(() => sessionStorage.getItem('site')), 'first');
            await page.getByRole('tab').click();
            await page.getByRole('button', { name: '完成录制' }).click();
        });
        assert.equal(new URL(reused.url).pathname, '/app');
        assert.equal(
            JSON.parse(generateRecordedCases(reused).cases[0].data).recordedScene.account,
            'tester',
        );
        const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
        const project = fileURLToPath(new URL('../../', import.meta.url));
        const file = path.join(root, 'business.spec.cjs'),
            book = path.join(root, 'business.xlsx');
        await fs.writeFile(
            file,
            attachRecordedCases(renderRecordingSpec(initial), generateRecordedCases(initial)),
        );
        await exportRecording(file, book, python);
        const env = {
            ...process.env,
            LAYA_HOME: root,
            PYTHONPATH: path.join(project, 'tests/fixtures/local-model'),
        };
        const args = [
            path.join(project, 'bin/laya.mjs'),
            'replay',
            book,
            '--url',
            a,
            '--headless',
            '--provider',
            'local',
            '--lazy-model',
            '--python',
            python,
            '--delay',
            '0',
        ];
        await exec(process.execPath, [...args, '--out', path.join(root, 'run')], {
            cwd: root,
            env,
        });
        const report = JSON.parse(await fs.readFile(path.join(root, 'run/results.json'), 'utf8'));
        assert.deepEqual(
            report.results.map((r) => [r.id, r.status]),
            [
                ['REC-001', '不适用'],
                ['REC-002', '通过'],
            ],
        );
        await login(a, 'second-user', { authReset: true });
        await assert.rejects(findRecordingAuth(root, a), /多个账号/);
        assert.ok(await findRecordingAuth(root, a, 'second-user'));
        expire = true;
        await assert.rejects(
            exec(process.execPath, [...args, '--out', path.join(root, 'expired')], {
                cwd: root,
                env,
            }),
            (error) => error.code === 1 && /失效/.test(error.stderr),
        );
    },
);
