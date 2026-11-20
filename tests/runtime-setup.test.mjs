import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPython, probePython, rememberSetting } from '../scripts/lib/runtime-setup.mjs';

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
