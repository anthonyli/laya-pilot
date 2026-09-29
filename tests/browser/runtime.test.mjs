import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Workflow } from '../../lib/workflow.mjs';
import { observe } from '../../lib/dom.mjs';
import { inspectForm } from '../../lib/form.mjs';
import { executeDiscovery, discoveryCandidates } from '../../lib/discovery.mjs';
import { target } from '../../lib/dom.mjs';
import { openBrowser } from '../../lib/browser-provider.mjs';
import { ensureAuthentication, saveAuthState } from '../../lib/auth-state.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
let server,
    base,
    out,
    waitingWrite,
    failedWrites = 0,
    delayedWrites = 0;
const authPage = `<!doctype html><html><body><script>
function show() {
 if(document.cookie.includes('session=valid') && localStorage.getItem('account') === 'tester' && sessionStorage.getItem('proof') === 'yes') {
   document.body.innerHTML = '<button id="authenticated">Authenticated</button>'; return;
 }
 document.body.innerHTML = '<label>Username<input id="account"></label><label>Password<input id="password" type="password"></label><button>Login</button>';
 document.querySelector('button').onclick = () => {
   if(document.querySelector('#account').value !== 'tester' || document.querySelector('#password').value !== 'test-only') return;
   document.cookie = 'session=valid; path=/'; localStorage.setItem('account','tester'); sessionStorage.setItem('proof','yes'); show();
 };
} show();</script></body></html>`;

before(async () => {
    await fs.mkdir(path.join(root, 'runs'), { recursive: true });
    out = await fs.mkdtemp(path.join(root, 'runs', 'browser-regression-'));
    const demo = await fs.readFile(path.join(root, 'examples/demo.html'), 'utf8');
    server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }
        if (req.url === '/slow.js') {
            setTimeout(() => res.end('window.ready = true;'), 300);
            return;
        }
        if (req.url === '/slow-load') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<script defer src="/slow.js"></script><p>ready</p>');
            return;
        }
        if (req.url === '/api/save-fail') {
            failedWrites++;
            res.writeHead(500).end('{}');
            return;
        }
        if (req.url === '/api/wait') {
            delayedWrites++;
            waitingWrite?.();
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.url === '/forbidden') {
            res.end('<main><h1>暂无权限</h1></main><button>Logout</button>');
            return;
        }
        if (req.url === '/auth') {
            res.end(authPage);
            return;
        }
        if (req.url === '/boundaries') {
            res.end(`<!doctype html><button onclick="document.querySelector('dialog').showModal()">新增</button>
              <table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody><tr><td>原记录</td><td>正常</td></tr></tbody></table>
              <dialog><div class="ant-form-item"><label for="email">邮箱</label><input id="email" type="email"></div>
              <div class="ant-form-item"><label for="amount">数量</label><input id="amount" type="number" min="1" max="20"></div>
              <button onclick="document.querySelector('dialog').close()">取消</button></dialog>`);
            return;
        }
        let html = demo.replace('__SAVE_ERROR__', req.url?.includes('fail') ? 'true' : 'false');
        if (req.url?.includes('confirm-save'))
            html = html.replaceAll('<button>保存</button>', '<button>确定</button>');
        if (req.url?.includes('interrupt'))
            html = html.replace(
                "if (saveError) fetch('/api/save-fail', { method: 'POST' });",
                "fetch('/api/wait', { method: 'POST' });",
            );
        res.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log('Browser evidence: ' + out);
});

test('configured page timeout also applies to initial navigation', async () => {
    const opened = await openBrowser({
        browserProvider: 'playwright',
        headless: true,
        pageTimeout: 50,
    });
    try {
        await assert.rejects(
            opened.page.goto(base + '/slow-load', { waitUntil: 'domcontentloaded' }),
            /Timeout 50ms/,
        );
        await opened.page.goto(base + '/slow-load', {
            waitUntil: 'domcontentloaded',
            timeout: 3000,
        });
        assert.equal(await opened.page.evaluate(() => window.ready), true);
    } finally {
        await opened.browser.close();
    }
});

test('native icon buttons use live tooltips and keep text-labelled actions intact', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`<button id="export"><i aria-label="图标: export">↗</i></button>
          <button id="save"><i aria-label="图标: save"></i>保存</button>
          <div role="tooltip" style="display:none">导出</div>
          <script>
            const button = document.querySelector('#export');
            const tip = document.querySelector('[role=tooltip]');
            button.onmouseenter = () => tip.style.display = 'block';
            button.onmouseleave = () => tip.style.display = 'none';
            button.onclick = () => document.body.dataset.exported = 'yes';
          </script>`);
        // Real icon components have no rendered text, but do have dimensions.
        await page.locator('#export i').evaluate((el) => {
            el.textContent = '';
            el.style.cssText = 'display:inline-block;width:16px;height:16px';
        });
        const snapshot = await observe(page);
        assert.equal(snapshot.controls.filter((c) => c.name === '图标: export').length, 1);
        assert.equal(snapshot.controls.find((c) => c.name === '保存')?.tag, 'button');
        let modelCalls = 0;
        const laya = {
            choose: async (_, criteria) => {
                modelCalls++;
                assert.ok(Object.hasOwn(criteria, '导出'));
                return { choice: '导出', probabilities: { 导出: 1 }, margin: 1 };
            },
        };
        const found = await target(page, laya, '导出');
        assert.equal(found.control.tag, 'button');
        await found.locator.click();
        assert.equal(await page.locator('body').getAttribute('data-exported'), 'yes');
        assert.equal(modelCalls, 1);
    } finally {
        await browser.close();
    }
});

async function cli(name, args, interruptOnWrite = false) {
    const directory = path.join(out, name);
    const child = spawn(
        process.execPath,
        [
            'runner.mjs',
            '--headless',
            '--lazy-model',
            '--python',
            python,
            '--out',
            directory,
            ...args,
        ],
        {
            cwd: root,
            env: {
                ...process.env,
                PYTHONPATH: path.join(root, 'tests/fixtures/local-model'),
                TEST_URL: '',
                TEST_USER: '',
                TEST_AUTH_STATE: '',
                TEST_AUTH_CHECK: '',
                TEST_PASSWORD: '',
                LAYA_API_KEY: '',
                LAYA_PROVIDER: 'local',
                BROWSER_PROVIDER: 'playwright',
                BROWSER_CHANNEL: '',
                TEST_TEMPLATE_EXCEL: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    if (interruptOnWrite) waitingWrite = () => child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    let code, signal;
    try {
        [code, signal] = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (...args) => resolve(args));
        });
    } finally {
        clearTimeout(timer);
        waitingWrite = null;
    }
    assert.equal(signal, null, output);
    const summary = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    assert.equal(code, summary.exitCode, output);
    assert.equal(await fs.stat(path.join(directory, 'trace.zip')).then((x) => x.size > 0), true);
    assert.equal(
        await fs.access(path.join(directory, '.run.lock')).then(
            () => true,
            () => false,
        ),
        false,
    );
    return { code, summary, directory, output };
}

test(
    'headless CLI uses model decisions for generation, discovery and replay target grounding',
    { timeout: 180000 },
    async () => {
        const caseFile = path.join(out, 'customers.xlsx');
        const generated = await cli('generate', [
            '--mode',
            'generate',
            '--url',
            base + '/customers',
            '--case-file',
            caseFile,
        ]);
        assert.equal(generated.code, 0, generated.output);
        assert.ok(generated.summary.metrics.modelCalls > 0);
        assert.equal(await fs.stat(generated.summary.resultFile).then((x) => x.size > 0), true);
        const decisions = await fs.readFile(
            path.join(generated.directory, 'decisions.ndjson'),
            'utf8',
        );
        assert.ok(decisions.includes('form-field'));
        assert.ok(decisions.includes('test-discovery'));
        assert.equal(generated.summary.retainedRecord, null);
        assert.equal(generated.summary.pendingWrite, null);
        assert.deepEqual(
            generated.summary.results.map((c) => [c.operation, c.status]),
            [
                ['table', '已验证'],
                ['filters', '已验证'],
                ['form-validation', '已验证'],
                ['form-invalid', '不适用'],
                ['create', '已验证'],
                ['search', '已验证'],
                ['view', '已验证'],
                ['edit', '已验证'],
                ['delete', '已验证'],
                ['discover', '已验证'],
                ['discover', '已验证'],
                ['discover', '已验证'],
            ],
        );
        const executed = await cli('execute', ['--mode', 'execute', '--case-file', caseFile]);
        assert.equal(executed.code, 0, executed.output);
        assert.equal(executed.summary.results.length, 11);
        assert.ok(executed.summary.results.every((c) => c.status === '通过'));
        assert.ok(executed.summary.metrics.modelCalls > 0);
        const replayDecisions = await fs.readFile(
            path.join(executed.directory, 'decisions.ndjson'),
            'utf8',
        );
        assert.ok(replayDecisions.includes('replay-target'));
        assert.equal(executed.summary.retainedRecord, null);
        assert.notEqual(executed.summary.runDataPrefix, generated.summary.runDataPrefix);
        console.log(
            JSON.stringify({
                generateMs: generated.summary.durationMs,
                executeMs: executed.summary.durationMs,
                generateModelCalls: generated.summary.metrics.modelCalls,
                replayModelCalls: executed.summary.metrics.modelCalls,
            }),
        );
    },
);

test('replay grounds form fields while binding saved choices exactly', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`<dialog open>
          <div class="ant-form-item"><label>名称</label><input id="name"></div>
          <div class="ant-form-item"><label>日期</label><input id="date" type="date"></div>
          <div class="ant-form-item"><label>角色</label><select id="role"><option value="">请选择</option><option value="test">测试角色</option><option value="normal">普通角色</option></select></div>
          <label>邮箱</label><input id="email" type="email" required>
        </dialog>`);
        const decisions = [];
        let rejectField = false;
        const laya = {
            choose: async (_, criteria, meta) => {
                decisions.push(meta);
                const choice = rejectField && meta.expected === '角色' ? '停止' : '目标1';
                assert.ok(criteria[choice]);
                return { choice, probabilities: { [choice]: 0.98 }, margin: 0.96 };
            },
        };
        const w = new Workflow(page, laya, { out, pageTimeout: 1000 }, 'execute', {
            begin: () => {},
            end: async () => [],
            setStep: () => {},
        });
        w.case = { id: 'form', operation: 'create', steps: [], attempts: [] };
        await w.formFill('名称', 0, '固定用例名称');
        await w.formDate('日期', '2027-01-02');
        await w.formFillRequired({ label: '邮箱', index: 0 }, 'fixed@example.test');
        await w.formSelect('角色', ['普通角色']);
        assert.equal(await page.locator('#name').inputValue(), '固定用例名称');
        assert.equal(await page.locator('#date').inputValue(), '2027-01-02');
        assert.equal(await page.locator('#email').inputValue(), 'fixed@example.test');
        assert.equal(await page.locator('#role').inputValue(), 'normal');
        assert.equal(decisions.length, 4);
        assert.ok(decisions.every((d) => d.phase === 'replay-target'));
        await assert.rejects(w.formSelect('角色', ['不存在']), /没有唯一可选项/);
        assert.equal(await page.locator('#role').inputValue(), 'normal');
        rejectField = true;
        await assert.rejects(w.formSelect('角色', ['测试角色']), /未改选其他值/);
        assert.equal(await page.locator('#role').inputValue(), 'normal');
    } finally {
        await browser.close();
    }
});

test('observed email and number bounds execute without submit and natural-language target matching still calls Laya', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(base + '/boundaries');
        let calls = 0;
        const model = {
            choose: async (_, criteria) => {
                calls++;
                assert.ok(criteria['新增']);
                return { choice: '新增', probabilities: { 新增: 0.98 }, margin: 0.96 };
            },
        };
        const found = await target(page, model, '新增');
        assert.equal(calls, 1);
        assert.equal(await found.locator.textContent(), '新增');
        const w = new Workflow(
            page,
            model,
            { data: {}, out, assertTimeout: 800, pageTimeout: 1500 },
            'generate',
            {},
        );
        await w.clickCreate();
        const candidates = discoveryCandidates({ controls: [] }, w.formEvidence);
        assert.deepEqual(
            candidates.map((c) => c.constraint),
            ['email', 'min', 'max'],
        );
        for (const spec of candidates)
            await executeDiscovery(w, { kind: 'assert-discovery', spec });
        assert.equal(await page.locator('dialog[open]').count(), 0);
        const changed = { ...candidates[1], bound: 2 };
        await assert.rejects(
            executeDiscovery(w, { kind: 'assert-discovery', spec: changed }),
            /约束已变化/,
        );
        assert.equal(w.pendingWrites.completed.length, 0);
    } finally {
        await browser.close();
    }
});

test(
    'operation policy runs create/delete without edit and read-only reports no writes',
    { timeout: 120000 },
    async () => {
        const pair = await cli('create-delete', [
            '--mode',
            'generate',
            '--url',
            base + '/customers',
            '--operations',
            'create,delete',
            '--case-file',
            path.join(out, 'pair.xlsx'),
        ]);
        assert.equal(pair.code, 0, pair.output);
        assert.deepEqual(
            pair.summary.results.map((c) => c.operation),
            ['create', 'delete'],
        );
        assert.equal(pair.summary.retainedRecord, null);
        const read = await cli('readonly', [
            '--mode',
            'generate',
            '--url',
            base + '/customers',
            '--read-only',
            '--case-file',
            path.join(out, 'read.xlsx'),
        ]);
        assert.equal(read.code, 0, read.output);
        assert.ok(read.summary.results.every((c) => ['table', 'filters'].includes(c.operation)));
        const progress = await fs.readFile(path.join(read.directory, 'progress.ndjson'), 'utf8');
        assert.ok(!progress.includes('write-intent'));
    },
);

test(
    'form confirmation label is generated and replayed only within the active form',
    { timeout: 45000 },
    async () => {
        const caseFile = path.join(out, 'confirm-save.xlsx');
        const generated = await cli('confirm-save', [
            '--mode',
            'generate',
            '--url',
            base + '/customers?confirm-save',
            '--operations',
            'form-validation',
            '--case-file',
            caseFile,
        ]);
        assert.equal(generated.code, 0, generated.output);
        assert.ok(
            generated.summary.results[0].steps.some(
                (s) =>
                    s.purpose === 'save' && s.target.name === '确定' && s.target.scope === 'form',
            ),
        );
        const replayed = await cli('confirm-replay', [
            '--mode',
            'execute',
            '--url',
            base + '/customers?confirm-save',
            '--case-file',
            caseFile,
        ]);
        assert.equal(replayed.code, 0, replayed.output);
    },
);

test(
    'HTTP 500 defeats optimistic UI success and leaves dependent delete blocked',
    { timeout: 90000 },
    async () => {
        const result = await cli('http500', [
            '--mode',
            'generate',
            '--url',
            base + '/customers?fail',
            '--operations',
            'create,delete',
            '--case-file',
            path.join(out, 'failure.xlsx'),
        ]);
        assert.equal(result.code, 1, result.output);
        assert.equal(failedWrites, 1);
        assert.equal(result.summary.results[0].status, '未生成');
        assert.ok(result.summary.results[0].browserEvents.some((e) => e.status === 500));
        assert.ok(result.summary.pendingWrite);
        assert.ok(result.summary.results[1].status.includes('依赖'));
    },
);

test(
    'permission-denied module fails explicitly before generating any business steps',
    { timeout: 30000 },
    async () => {
        const result = await cli('forbidden', [
            '--mode',
            'generate',
            '--url',
            base + '/forbidden',
            '--read-only',
            '--case-file',
            path.join(out, 'forbidden.xlsx'),
        ]);
        assert.equal(result.code, 1);
        assert.match(result.summary.error, /无访问权限/);
        assert.deepEqual(result.summary.results, []);
        assert.ok(result.summary.runEvidence);
    },
);

test(
    'SIGTERM during an outstanding write saves partial results and never resends',
    { timeout: 90000 },
    async () => {
        const result = await cli(
            'interrupted',
            [
                '--mode',
                'generate',
                '--url',
                base + '/customers?interrupt',
                '--operations',
                'table,create,delete',
                '--case-file',
                path.join(out, 'interrupt.xlsx'),
            ],
            true,
        );
        assert.equal(result.code, 143, result.output);
        assert.equal(result.summary.runStatus, 'interrupted');
        assert.equal(delayedWrites, 1);
        assert.ok(
            result.summary.results.some((c) => c.operation === 'table' && c.status === '已验证'),
        );
        assert.ok(
            result.summary.results.some((c) => c.operation === 'create' && c.status === '中断'),
        );
        const checkpoint = JSON.parse(
            await fs.readFile(path.join(result.directory, 'checkpoint.json'), 'utf8'),
        );
        assert.equal(checkpoint.status, 'interrupted');
        assert.equal(checkpoint.pendingWrite.operation, 'create');
        assert.ok(checkpoint.runtime.variables.recordName.startsWith('LayaAuto_'));
    },
);

test(
    'login state restores cookie/local/session storage in a new browser; expiry fails closed',
    { timeout: 60000 },
    async () => {
        const config = {
            url: base + '/auth',
            user: 'tester',
            authState: path.join(out, 'auth.json'),
            authCheck: '#authenticated',
            authSessionStorage: true,
            headless: true,
            browserProvider: 'playwright',
            pageTimeout: 2000,
        };
        const chooseTarget = () => {
            throw Error('unambiguous login must not use a model');
        };
        let opened = await openBrowser(config);
        try {
            await opened.page.goto(config.url);
            await opened.page.evaluate(() => {
                document.querySelector('label').firstChild.textContent = '';
                document.querySelector('#account').placeholder = '请输入登录账号';
                document.querySelector('button').textContent = '登 录';
            });
            assert.equal(
                await ensureAuthentication(
                    opened.page,
                    config,
                    async () => 'test-only',
                    chooseTarget,
                    false,
                ),
                'logged-in',
            );
            await opened.page.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const request = indexedDB.open('auth-fixture', 1);
                        request.onupgradeneeded = () => request.result.createObjectStore('tokens');
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => {
                            const db = request.result,
                                tx = db.transaction('tokens', 'readwrite');
                            tx.objectStore('tokens').put('test-token', 'access');
                            tx.oncomplete = () => {
                                db.close();
                                resolve();
                            };
                            tx.onerror = () => reject(tx.error);
                        };
                    }),
            );
            await saveAuthState(opened.context, opened.page, config);
        } finally {
            await opened.browser.close();
        }
        opened = await openBrowser(config);
        try {
            await opened.page.goto(config.url);
            assert.equal(
                await ensureAuthentication(
                    opened.page,
                    config,
                    () => {
                        throw Error('must reuse');
                    },
                    chooseTarget,
                    opened.authRestored,
                ),
                'reused',
            );
            assert.equal(
                await opened.page.evaluate(
                    () =>
                        new Promise((resolve, reject) => {
                            const request = indexedDB.open('auth-fixture', 1);
                            request.onerror = () => reject(request.error);
                            request.onsuccess = () => {
                                const db = request.result,
                                    read = db
                                        .transaction('tokens')
                                        .objectStore('tokens')
                                        .get('access');
                                read.onsuccess = () => {
                                    db.close();
                                    resolve(read.result);
                                };
                                read.onerror = () => reject(read.error);
                            };
                        }),
                ),
                'test-token',
            );
            await opened.context.clearCookies();
            await opened.page.reload();
            await assert.rejects(
                ensureAuthentication(
                    opened.page,
                    { ...config, user: '' },
                    () => {},
                    chooseTarget,
                    true,
                ),
                /失效/,
            );
            await opened.page.evaluate(() => {
                document.querySelector('label').firstChild.textContent = 'Enter account';
                document.querySelector('button').textContent = 'Continue to Login';
            });
            let fallbacks = 0;
            const chooser = async (_, kind) => {
                fallbacks++;
                const snap = await observe(opened.page);
                const control = snap.controls.find(
                    (c) => c.role === (kind === 'fill' ? 'textbox' : 'button'),
                );
                return { locator: opened.page.locator(`[data-laya-live-ref="${control.ref}"]`) };
            };
            assert.equal(
                await ensureAuthentication(
                    opened.page,
                    config,
                    async () => 'test-only',
                    chooser,
                    false,
                ),
                'logged-in',
            );
            assert.equal(fallbacks, 2);
        } finally {
            await opened.browser.close();
        }
        if (process.platform !== 'win32')
            assert.equal((await fs.stat(config.authState)).mode & 0o777, 0o600);
    },
);

test(
    'native select verifies selection; exact row identity rejects duplicates and prefixes',
    { timeout: 45000 },
    async () => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent(
                '<dialog open><div class="ant-form-item"><label for="tier">级别</label><select id="tier" required><option value="">请选择</option><option value="disabled" disabled>忽略</option><option value="standard">标准</option></select></div></dialog>',
            );
            const workflow = new Workflow(
                page,
                {
                    choose: async () => ({
                        choice: '其他可用选项',
                        probabilities: { 其他可用选项: 0.95 },
                        margin: 0.9,
                    }),
                },
                { data: {}, out, assertTimeout: 100 },
                'generate',
                {},
            );
            assert.equal((await inspectForm(page))[0].required, true);
            assert.deepEqual(await workflow.formSelect('级别'), ['标准']);
            assert.equal(await page.locator('select').inputValue(), 'standard');
            await page.setContent(
                '<dialog open><button aria-label="Close">×</button><button onclick="this.parentElement.remove()">取消</button></dialog>',
            );
            assert.equal((await workflow.action('close')).control.name, '取消');
            await workflow.click('close');
            assert.equal(await page.locator('dialog').count(), 0);
            await page.setContent(
                '<table><tbody><tr><td>LayaAuto_1_suffix</td><td><button>删除</button></td></tr><tr><td>LayaAuto_1</td><td><button>删除</button></td></tr></tbody></table>',
            );
            assert.equal(await workflow.ownedRows('LayaAuto_1').count(), 1);
            await workflow.row('LayaAuto_1');
            const action = await workflow.action('delete', { rowName: 'LayaAuto_1' });
            // Simulate a search replacing all rows after observation/trial.
            await action.locator.click({ trial: true });
            await page.locator('tbody').evaluate((e) => {
                e.innerHTML = e.innerHTML;
            });
            await page.evaluate(() => {
                window.clickedRows = [];
                document.addEventListener('click', (event) => {
                    if (event.target.tagName === 'BUTTON')
                        window.clickedRows.push(event.target.closest('tr').cells[0].textContent);
                });
            });
            await workflow.dispatchClick(action.locator, action.step);
            assert.deepEqual(await page.evaluate(() => window.clickedRows), ['LayaAuto_1']);
            await page
                .locator('tbody')
                .evaluate((e) => e.append(e.lastElementChild.cloneNode(true)));
            await assert.rejects(workflow.row('LayaAuto_1'), /数量不符合/);
            await assert.rejects(workflow.action('delete', { rowName: 'LayaAuto_1' }), /不唯一/);
            await page.setContent('<p>Loading</p>');
            await assert.rejects(workflow.row('LayaAuto_1', false), /尝试3次/);
        } finally {
            await browser.close();
        }
    },
);

test(
    'user forms keep account stable, select a relative expiry and scope fixed-column actions',
    { timeout: 45000 },
    async () => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const workflow = new Workflow(
                page,
                {
                    choose: async (state) => {
                        const choice = state.includes('登录账号')
                            ? '账号'
                            : state.includes('过期')
                              ? '日期'
                              : '名称';
                        return { choice, probabilities: { [choice]: 0.95 }, margin: 0.9 };
                    },
                },
                { data: {}, out, assertTimeout: 1000, pageTimeout: 1500 },
                'generate',
                {},
            );
            workflow.case = { id: 'create', operation: 'create', steps: [] };
            const date = workflow.variables.expiryDate;
            const [year, month, day] = date.split('-').map(Number);
            await page.setContent(`<dialog open>
          <div class="ant-form-item"><label class="ant-form-item-required">登录账号</label><input></div>
          <div class="ant-form-item"><label class="ant-form-item-required">用户名</label><input></div>
          <div class="ant-form-item"><label class="ant-form-item-required">过期时间</label><input id="expiry" readonly onclick="document.querySelector('.ant-calendar').hidden=false"></div>
          <div class="ant-calendar" hidden><table><tr><td title="${year}年${month}月${day}日" onclick="document.querySelector('#expiry').value='${date}';this.closest('.ant-calendar').hidden=true">${day}</td></tr></table></div>
        </dialog>`);
            const label = await workflow.fillRecordName('${recordName}');
            await workflow.populateForm(label);
            const form = await inspectForm(page);
            assert.equal(
                form.find((x) => x.label === '登录账号').inputs[0].value,
                workflow.variables.recordAccount,
            );
            assert.equal(
                form.find((x) => x.label === '用户名').inputs[0].value,
                workflow.variables.recordName,
            );
            assert.equal(form.find((x) => x.label === '过期时间').inputs[0].value, date);
            assert.equal(
                workflow.case.steps.find((x) => x.kind === 'form-date').value,
                '${expiryDate}',
            );
            const name = workflow.variables.recordName;
            await page.setContent(
                `<input placeholder="输入登录账号搜索"><div class="ant-table"><table><tbody><tr data-row-key="own"><td>${name}</td></tr><tr data-row-key="other"><td>Someone else</td></tr></tbody></table><div class="ant-table-fixed-right"><table><tbody><tr data-row-key="own"><td><button onclick="window.clicked='own'">删除</button></td></tr><tr data-row-key="other"><td><button onclick="window.clicked='other'">删除</button></td></tr></tbody></table></div></div>`,
            );
            await workflow.query('${recordName}');
            assert.equal(
                await page.locator('input').inputValue(),
                workflow.variables.recordAccount,
            );
            workflow.case = { id: 'delete', operation: 'delete', steps: [] };
            const action = await workflow.action('delete', { rowName: name });
            await workflow.dispatchClick(action.locator, action.step);
            assert.equal(await page.evaluate(() => window.clicked), 'own');
            await page.locator('.ant-table-fixed-right tr[data-row-key="own"] td').evaluate((e) => {
                const icon = document.createElement('i');
                icon.setAttribute('aria-label', '图标: form');
                icon.style.cssText = 'display:inline-block;width:20px;height:20px;cursor:pointer';
                e.append(icon);
            });
            const snapshot = await observe(page);
            assert.equal(
                snapshot.controls.filter((c) => c.name === '图标: form' && c.rowKey === 'own')
                    .length,
                1,
            );
            await page.evaluate(() => {
                const popup = document.createElement('div');
                popup.className = 'ant-popover';
                popup.innerHTML = '<button>取消</button><button>确定</button>';
                document.body.append(popup);
            });
            assert.equal((await workflow.action('confirm')).control.name, '确定');
        } finally {
            await browser.close();
        }
    },
);

test('Ant multiple select stops after the model-selected value is visibly committed', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`<dialog open><h2>新增</h2><div class="ant-form-item"><label>角色</label>
          <div class="ant-select"><div role="combobox" onclick="document.querySelector('[role=listbox]').hidden=false">请选择</div></div></div>
          <div role="listbox" hidden><div role="option" onclick="window.clicked=(window.clicked||0)+1;document.querySelector('.ant-select').insertAdjacentHTML('beforeend','<span class=ant-select-selection__choice__content>test3</span>')">test3</div>
          <div role="option">test4</div></div></dialog>`);
        let calls = 0;
        const w = new Workflow(
            page,
            {
                choose: async () => {
                    calls++;
                    return {
                        choice: '测试用途选项',
                        probabilities: { 测试用途选项: 0.95 },
                        margin: 0.9,
                    };
                },
            },
            { data: {}, out, pageTimeout: 500 },
            'generate',
            {},
        );
        assert.deepEqual(await w.formSelect('角色'), ['test3']);
        assert.equal(calls, 1);
        assert.equal(await page.evaluate(() => window.clicked), 1);
        assert.equal((await inspectForm(page))[0].chosen, 'test3');
    } finally {
        await browser.close();
    }
});
