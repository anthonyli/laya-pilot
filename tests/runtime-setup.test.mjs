import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findPython, probePython, rememberSetting } from '../scripts/lib/runtime-setup.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/laya.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));

test('python probe reports the version it rejected', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-python-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const old = path.join(directory, 'python-old');
    // A fake interpreter that only answers --version, like a Python 3.9 without the probe.
    await fs.writeFile(
        old,
        '#!/bin/sh\n[ "$1" = "--version" ] && echo "Python 3.9.6" && exit 0\nexit 1\n',
        {
            mode: 0o755,
        },
    );
    if (process.platform !== 'win32') {
        const probe = probePython(old);
        assert.equal(probe.ok, false);
        assert.match(probe.reason, /3\.9\.6/);
        assert.throws(() => findPython(old, directory), /--python .*3\.9\.6.*python3\.12/);
    }
    assert.equal(probePython(path.join(directory, 'missing')).ok, false);
    const current = probePython(process.env.LAYA_TEST_PYTHON || 'python3');
    if (current.ok) assert.match(current.version, /^3\.\d+\.\d+$/);
});

test('remembered settings fill empty keys and never override a choice', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-env-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, '.env.local');
    await fs.writeFile(file, 'LAYA_API_KEY=secret\nBROWSER_CHANNEL=\n');
    assert.equal(await rememberSetting(file, 'BROWSER_CHANNEL', 'chrome'), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'LAYA_API_KEY=secret\nBROWSER_CHANNEL=chrome\n');
    assert.equal(await rememberSetting(file, 'BROWSER_CHANNEL', 'msedge'), false);
    assert.match(await fs.readFile(file, 'utf8'), /BROWSER_CHANNEL=chrome/);
    assert.equal(await rememberSetting(file, 'TEST_URL', 'https://x.example'), true);
    assert.match(await fs.readFile(file, 'utf8'), /\nTEST_URL=https:\/\/x\.example\n$/);
});

test('recording setup and check agree on the effective browser channel', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-browser-setup-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const envPath = path.join(directory, '.env.local');
    const env = {
        ...process.env,
        LAYA_HOME: directory,
        PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'browsers'),
    };
    delete env.BROWSER_CHANNEL;
    // Stub the browser installation marker without changing host browsers or downloading.
    const { stdout } = await exec(
        process.execPath,
        ['-p', "require('playwright').chromium.executablePath()"],
        { cwd, env },
    );
    const executable = stdout.trim();
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, '');

    const run = (command, override = {}) =>
        exec(process.execPath, [cli, command, '--recording'], { env: { ...env, ...override } });
    const missing = 'BROWSER_CHANNEL=missing-channel\n';
    await fs.writeFile(envPath, missing);
    await assert.rejects(run('setup'), { code: 1, stderr: /BROWSER_CHANNEL=missing-channel/ });
    await assert.rejects(run('check'), { code: 1, stdout: /missing-channel is missing/ });
    assert.equal(await fs.readFile(envPath, 'utf8'), missing);

    const chromium = { BROWSER_CHANNEL: 'chromium' };
    assert.match((await run('setup', chromium)).stdout, /Recording is ready/);
    assert.match((await run('check', chromium)).stdout, /Recording is ready/);
    assert.equal(await fs.readFile(envPath, 'utf8'), missing);

    await fs.writeFile(envPath, 'BROWSER_CHANNEL=chromium\n');
    await assert.rejects(run('setup', { BROWSER_CHANNEL: 'missing-channel' }), { code: 1 });
    await fs.writeFile(envPath, 'BROWSER_CHANNEL=\n');
    assert.match((await run('setup')).stdout, /Recording is ready/);
    assert.match((await run('check')).stdout, /Recording is ready/);
});
