import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { attachRecordedCases, exportRecording } from '../../scripts/lib/recorded-excel.mjs';
import { findRecordingAuth } from '../../scripts/lib/recording-auth.mjs';
import { captureRecording } from '../../scripts/lib/recording-capture.mjs';
import { generateRecordedCases } from '../../scripts/lib/recording-cases.mjs';
import { renderRecordingSpec } from '../../scripts/lib/recording-spec.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.LAYA_TEST_PYTHON || process.env.LAYA_PYTHON || 'python3';
const loginForm = `<form method="post" action="/login">
    <input name="account" aria-label="Account" autocomplete="username">
    <input name="password" aria-label="Password" type="password" autocomplete="current-password">
    <button type="submit">Login</button></form>`;

async function startSite(t, accounts) {
    const sessions = new Map(),
        attempts = [],
        visits = [];
    const page = { heading: 'Dashboard' };
    const server = http.createServer(async (req, res) => {
        const session = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
        const user = sessions.get(session);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.method === 'POST' && req.url === '/login') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const submitted = new URLSearchParams(Buffer.concat(chunks).toString());
            const account = submitted.get('account');
            attempts.push(account);
            if (!accounts.has(account) || accounts.get(account) !== submitted.get('password')) {
                res.end(loginForm + '<output role="alert">Sign-in failed</output>');
                return;
            }
            const id = randomUUID();
            sessions.set(id, account);
            res.writeHead(303, {
                Location: '/app',
                'Set-Cookie': `sid=${id}; Path=/; HttpOnly; SameSite=Lax`,
            }).end();
        } else if (req.url === '/login') {
            res.end(loginForm);
        } else if (req.url === '/app' || req.url === '/area') {
            if (!user) {
                res.writeHead(302, { Location: '/login' }).end();
            } else if (req.url === '/app') {
                res.end(
                    `<h1>${page.heading}</h1><button role="tab" onclick="fetch('/area').then(r=>r.text()).then(t=>document.querySelector('output').textContent=t)">Run Area</button><output></output>`,
                );
            } else {
                visits.push(user);
                res.end('Area ready');
            }
        } else {
            res.writeHead(204).end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/login`,
        sessions,
        attempts,
        visits,
        page,
    };
}

async function recordLogin(site, authRoot, account, password) {
    return captureRecording({
        url: site.url,
        authRoot,
        authReset: true,
        headless: true,
        playwright: { chromium },
        async onReady(page) {
            await page.getByLabel('Account').fill(account);
            await page.getByLabel('Password').fill(password);
            await page.getByRole('button', { name: 'Login' }).click();
            await page.waitForURL('**/app');
            await page.getByRole('tab', { name: 'Run Area' }).click();
            await page.getByRole('button', { name: '添加检查点' }).click();
            await page.getByText('Area ready', { exact: true }).click();
            await page.getByRole('button', { name: '完成录制' }).click();
        },
    });
}

async function sessionCookie(authRoot, site, account) {
    const saved = await findRecordingAuth(authRoot, site.url, account);
    assert.ok(saved, 'Expected a verified per-account auth file');
    const state = JSON.parse(await fs.readFile(saved.authState, 'utf8'));
    return state.storageState.cookies.find((cookie) => cookie.name === 'sid')?.value;
}

async function checkArtifacts(directory, passwords) {
    const scan = exec(python, [
        '-c',
        `
import json, pathlib, sys, zipfile
secrets = [s.encode() for s in json.load(sys.stdin)]
def contains_secret(data):
    return any(s in data for s in secrets)
for file in pathlib.Path(sys.argv[1]).rglob('*'):
    if not file.is_file():
        continue
    if zipfile.is_zipfile(file):
        with zipfile.ZipFile(file) as archive:
            for name in archive.namelist():
                if contains_secret(archive.read(name)):
                    print(file.name, name)
    elif contains_secret(file.read_bytes()):
        print(file.name)
`,
        directory,
    ]);
    scan.child.stdin.end(JSON.stringify(passwords));
    assert.equal((await scan).stdout.trim(), '', 'Plaintext password found on disk');
}

async function workbookReplay(root, url, recorded, passwords) {
    const authRoot = path.join(root, 'private'),
        workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const spec = path.join(workspace, 'area.spec.cjs'),
        book = path.join(workspace, 'area.xlsx');
    const generated = generateRecordedCases(recorded);
    await fs.writeFile(spec, attachRecordedCases(renderRecordingSpec(recorded), generated));
    await exportRecording(spec, book, python);
    for (const password of passwords) assert.ok(!JSON.stringify(recorded).includes(password));
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(?:TEST_|LAYA_|BROWSER_)/.test(k)),
    );
    env.LAYA_HOME = authRoot;
    env.PYTHONPATH = path.join(project, 'tests/fixtures/local-model');
    const replay = (out, login) =>
        exec(
            process.execPath,
            [
                path.join(project, 'bin/fa.mjs'),
                'replay',
                book,
                '--url',
                url,
                '--headless',
                '--python',
                python,
                '--provider',
                'local',
                '--lazy-model',
                '--page-timeout',
                '3000',
                '--delay',
                '0',
                ...(login ? ['--user', login.account] : []),
                '--out',
                out,
            ],
            {
                cwd: workspace,
                env: login ? { ...env, TEST_PASSWORD: login.password } : env,
                timeout: 20000,
            },
        );
    const report = async (out) =>
        JSON.parse(await fs.readFile(path.join(workspace, out, 'results.json'), 'utf8'));
    const pass = async (out, login) => {
        const { stdout, stderr } = await replay(out, login);
        for (const password of passwords) assert.ok(!(stdout + stderr).includes(password));
        assert.deepEqual(
            (await report(out)).results.map(({ id, status }) => [id, status]),
            [
                ['REC-001', '不适用'],
                ['REC-002', '通过'],
            ],
        );
    };
    const fail = async (out) => {
        await assert.rejects(replay(out), (error) => {
            assert.equal(error.code, 1);
            for (const password of passwords)
                assert.ok(!(error.stderr + error.stdout).includes(password));
            return true;
        });
        assert.deepEqual((await report(out)).results, []);
    };
    return { pass, fail };
}

test(
    'expired recorded session logs in once for its origin and account, then reuses the refreshed session',
    { timeout: 90000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-auto-login-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const authRoot = path.join(root, 'private');
        const passwords = Array.from({ length: 3 }, () => 'local-fixture-' + randomUUID());
        const accounts = new Map([
            ['morgan', passwords[0]],
            ['taylor', passwords[1]],
        ]);
        const main = await startSite(t, accounts);
        const other = await startSite(t, new Map([['morgan', passwords[2]]]));
        const recorded = await recordLogin(main, authRoot, 'morgan', passwords[0]);
        await recordLogin(main, authRoot, 'taylor', passwords[1]);
        await recordLogin(other, authRoot, 'morgan', passwords[2]);
        assert.deepEqual(main.attempts, ['morgan', 'taylor']);
        assert.deepEqual(other.attempts, ['morgan']);
        const original = await sessionCookie(authRoot, main, 'morgan');
        const otherAccount = await sessionCookie(authRoot, main, 'taylor');
        const otherSite = await sessionCookie(authRoot, other, 'morgan');
        assert.ok(main.sessions.delete(original));

        const { pass, fail } = await workbookReplay(root, main.url, recorded, passwords);

        main.visits.length = 0;
        await pass('recovered');
        assert.deepEqual(main.attempts, ['morgan', 'taylor', 'morgan']);
        assert.deepEqual(main.visits, ['morgan']);
        const renewed = await sessionCookie(authRoot, main, 'morgan');
        assert.notEqual(renewed, original);
        assert.equal(main.sessions.get(renewed), 'morgan');
        await pass('reused');
        assert.deepEqual(main.attempts, ['morgan', 'taylor', 'morgan']);
        assert.deepEqual(main.visits, ['morgan', 'morgan']);

        main.sessions.delete(renewed);
        accounts.delete('morgan');
        await fail('denied');
        assert.deepEqual(main.attempts, ['morgan', 'taylor', 'morgan', 'morgan']);
        assert.deepEqual(main.visits, ['morgan', 'morgan']);
        assert.deepEqual(other.attempts, ['morgan']);
        assert.equal(await sessionCookie(authRoot, main, 'taylor'), otherAccount);
        assert.equal(await sessionCookie(authRoot, other, 'morgan'), otherSite);
        await checkArtifacts(root, passwords);
    },
);

test(
    'credentials rebuild missing auth only after the recorded landing check and support password rotation',
    { timeout: 90000 },
    async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-rebuild-auth-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const authRoot = path.join(root, 'private');
        const account = 'taylor';
        const original = 'old-fixture-' + randomUUID(),
            rotated = 'new-fixture-' + randomUUID();
        const accounts = new Map([[account, original]]);
        const site = await startSite(t, accounts);
        const recorded = await recordLogin(site, authRoot, account, original);
        const saved = await findRecordingAuth(authRoot, site.url, account);
        assert.match(saved.info.check, /Dashboard/);
        await fs.unlink(saved.authState);
        const { pass, fail } = await workbookReplay(root, site.url, recorded, [original, rotated]);

        // Successful password submission alone cannot authorize replay. The tab and the
        // landing route are available here, but the authenticated marker is missing.
        site.page.heading = 'Public landing';
        site.visits.length = 0;
        await fail('wrong-marker');
        assert.deepEqual(site.attempts, [account, account]);
        assert.deepEqual(site.visits, []);
        assert.equal(await findRecordingAuth(authRoot, site.url, account), null);

        site.page.heading = 'Dashboard';
        await pass('missing-auth');
        assert.deepEqual(site.attempts, [account, account, account]);
        assert.deepEqual(site.visits, [account]);
        const rebuilt = await findRecordingAuth(authRoot, site.url, account);
        assert.deepEqual(rebuilt.info, saved.info);
        assert.ok(site.sessions.delete(await sessionCookie(authRoot, site, account)));

        accounts.set(account, rotated);
        await pass('explicit-password', { account, password: rotated });
        assert.ok(site.sessions.delete(await sessionCookie(authRoot, site, account)));
        await pass('stored-new-password');
        assert.deepEqual(site.attempts, Array(5).fill(account));
        assert.deepEqual(site.visits, Array(3).fill(account));
        await checkArtifacts(root, [original, rotated]);
    },
);
