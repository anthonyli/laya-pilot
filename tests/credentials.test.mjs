import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadLoginCredentials, saveLoginCredentials } from '../scripts/lib/credentials.mjs';
import { safeText } from '../scripts/lib/diagnostics.mjs';

async function localRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-credential-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test('credential storage is private, encrypted, redacted and isolated by origin and account', async (t) => {
    const root = await localRoot(t);
    const url = 'https://alpha.example.test:8443';
    const account = 'user/测试';
    const password = randomBytes(24).toString('base64');
    const recipe = {
        account: { kind: 'placeholder', name: 'Login account' },
        password: { kind: 'label', name: 'Password' },
        submit: { kind: 'role', role: 'button', name: 'Sign in' },
    };
    assert.equal(await loadLoginCredentials(root, url, account), null);
    assert.deepEqual(await fs.readdir(root), []);
    await saveLoginCredentials(root, url, account, {
        password,
        loginUrl: url + '/login?next=dashboard',
        landingUrl: url + '/#/dashboard?tab=1',
        check: '#workspace',
        recipe,
    });
    const loaded = await loadLoginCredentials(root, url + '/other', account);
    assert.ok(loaded.password === password);
    assert.equal(loaded.account, account);
    assert.equal(loaded.origin, url);
    assert.equal(loaded.loginUrl, url + '/login');
    assert.equal(loaded.landingUrl, url + '/#/dashboard');
    assert.equal(loaded.check, '#workspace');
    assert.deepEqual(loaded.recipe, recipe);
    assert.equal(safeText(password), '[REDACTED]');
    assert.equal(await loadLoginCredentials(root, url, 'another'), null);
    assert.equal(await loadLoginCredentials(root, 'https://alpha.example.test', account), null);
    assert.equal(await loadLoginCredentials(root, 'http://alpha.example.test:8443', account), null);
    assert.equal(await loadLoginCredentials(root, url, ''), null);

    const auth = path.join(root, '.auth');
    const store = path.join(auth, 'credentials');
    const [site] = await fs.readdir(store);
    const [name] = await fs.readdir(path.join(store, site));
    const file = path.join(store, site, name);
    const packet = await fs.readFile(file, 'utf8');
    for (const text of [password, account, recipe.submit.name, url, 'dashboard', 'workspace'])
        assert.ok(!packet.includes(text));
    const key = path.join(auth, 'credentials.key');
    assert.equal((await fs.stat(key)).size, 32);
    if (process.platform !== 'win32') {
        for (const directory of [auth, store, path.dirname(file)])
            assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        for (const filename of [file, key])
            assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    }
    await assert.rejects(
        saveLoginCredentials(root, url, account, {
            password,
            loginUrl: 'https://other.example.test/login',
        }),
        /不匹配/,
    );
    await assert.rejects(
        saveLoginCredentials(root, url, account, {
            password,
            landingUrl: 'https://other.example.test/',
        }),
        /不匹配/,
    );
    await assert.rejects(
        saveLoginCredentials(root, 'https://user:secret@example.test/', account, { password }),
        /不匹配/,
    );
    await assert.rejects(
        saveLoginCredentials(root, url, account, {
            password,
            recipe: { ...recipe, password: { kind: 'css', name: 'input' } },
        }),
        /不匹配/,
    );
    await assert.rejects(
        saveLoginCredentials(root, url, account, {
            password,
            recipe: { ...recipe, submit: { kind: 'role', name: 'Sign in' } },
        }),
        /不匹配/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), packet);
    await saveLoginCredentials(root, url, account, loaded);
    assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).nonce, JSON.parse(packet).nonce);
});

test('parallel first saves share one fully published key and every record remains decryptable', async (t) => {
    const root = await localRoot(t);
    const url = 'http://parallel.example.test/';
    const logins = Array.from({ length: 20 }, (_, i) => ({
        account: 'account-' + i,
        password: randomBytes(16).toString('hex'),
    }));
    await Promise.all(
        logins.map(({ account, password }) =>
            saveLoginCredentials(root, url, account, { password }),
        ),
    );
    await Promise.all(
        logins.map(async ({ account, password }) => {
            assert.ok((await loadLoginCredentials(root, url, account)).password === password);
        }),
    );
    assert.deepEqual((await fs.readdir(path.join(root, '.auth'))).sort(), [
        'credentials',
        'credentials.key',
    ]);
    const replacements = [randomBytes(20).toString('hex'), randomBytes(20).toString('hex')];
    await Promise.all(
        replacements.map((password) =>
            saveLoginCredentials(root, url, logins[0].account, { password }),
        ),
    );
    assert.ok(
        replacements.includes((await loadLoginCredentials(root, url, logins[0].account)).password),
    );
});

test('rejects swapped and tampered credential packets and preserves the store when its key is lost', async (t) => {
    const root = await localRoot(t);
    const url = 'https://isolated.example.test';
    const password = randomBytes(24).toString('base64');
    for (const account of ['one', 'two'])
        await saveLoginCredentials(root, url, account, { password });
    const store = path.join(root, '.auth', 'credentials');
    const [site] = await fs.readdir(store);
    const [a, b] = (await fs.readdir(path.join(store, site))).map((file) =>
        path.join(store, site, file),
    );
    const original = await fs.readFile(a, 'utf8');
    const other = await fs.readFile(b, 'utf8');
    await fs.writeFile(a, other);
    await fs.writeFile(b, original);
    for (const account of ['one', 'two'])
        await assert.rejects(loadLoginCredentials(root, url, account), /无法验证/);
    const envelope = JSON.parse(original);
    const altered = Buffer.from(envelope.ciphertext, 'base64');
    altered[0] ^= 1;
    envelope.ciphertext = altered.toString('base64');
    await fs.writeFile(a, JSON.stringify(envelope));
    await fs.writeFile(b, '{}');
    for (const account of ['one', 'two'])
        await assert.rejects(loadLoginCredentials(root, url, account), /无法验证/);
    await fs.writeFile(a, original);
    await fs.writeFile(b, other);
    await fs.unlink(path.join(root, '.auth', 'credentials.key'));
    await assert.rejects(loadLoginCredentials(root, url, 'one'), /缺少加密密钥/);
    await assert.rejects(saveLoginCredentials(root, url, 'one', { password }), /缺少加密密钥/);
    assert.equal(await fs.readFile(a, 'utf8'), original);
    assert.equal(await fs.readFile(b, 'utf8'), other);
});
