import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerSecret } from './diagnostics.mjs';
import { writePrivateJson } from './run-state.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const invalid = () => Error('登录凭据信息不完整或与目标站点、账号不匹配。');

function siteAddress(address, origin) {
    if (typeof address !== 'string' || !URL.canParse(address)) throw invalid();
    const url = new URL(address);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (origin && url.origin !== origin)
    )
        throw invalid();
    return url;
}

function credentialLocation(root, url, account) {
    if (typeof root !== 'string' || !root || typeof account !== 'string' || !account.trim())
        throw invalid();
    const origin = siteAddress(url).origin;
    const auth = path.resolve(root, '.auth');
    const store = path.join(auth, 'credentials');
    const site = path.join(store, digest(origin));
    return {
        origin,
        auth,
        store,
        site,
        file: path.join(site, digest(account) + '.json'),
        key: path.join(auth, 'credentials.key'),
    };
}

async function privateDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) throw Error('登录凭据目录不是本地目录。');
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
        await fs.chmod(directory, 0o700);
}

async function readPrivateFile(file, key = false) {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || (key && stat.size !== 32)) throw Error('本地登录凭据文件损坏。');
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
            await handle.chmod(0o600);
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

async function masterKey(location, create) {
    try {
        return await readPrivateFile(location.key, true);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const hasExistingStore = await fs.readdir(location.store).then(
        (entries) => entries.length > 0,
        (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        },
    );
    if (!create || hasExistingStore) {
        // A concurrent writer may have published its key and then created the credentials directory.
        return readPrivateFile(location.key, true).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            throw Error('本地登录凭据缺少加密密钥。');
        });
    }
    const temporary = path.join(location.auth, '.credentials-key-' + randomUUID() + '.tmp');
    const key = randomBytes(32);
    try {
        await fs.writeFile(temporary, key, { flag: 'wx', mode: 0o600 });
        // Publish the complete key exclusively. A second process never sees a half-written key.
        await fs.link(temporary, location.key).catch((error) => {
            if (error.code !== 'EEXIST') throw error;
        });
    } finally {
        key.fill(0);
        await fs.rm(temporary, { force: true });
    }
    return readPrivateFile(location.key, true);
}

function credentialRoute(url) {
    return url.origin + url.pathname + (/^#!?\//.test(url.hash) ? url.hash.split('?')[0] : '');
}

function loginRecipe(value) {
    const recipe = {};
    for (const key of ['account', 'password', 'submit']) {
        const target = value[key];
        if (
            !target ||
            !['label', 'placeholder', 'role'].includes(target.kind) ||
            typeof target.name !== 'string' ||
            !target.name.trim()
        )
            throw invalid();
        recipe[key] = { kind: target.kind, name: target.name };
        if (target.kind === 'role') {
            if (typeof target.role !== 'string' || !target.role.trim()) throw invalid();
            recipe[key].role = target.role;
        }
    }
    return recipe;
}

function credentialPayload(origin, account, input, defaultLoginUrl) {
    if (!input || typeof input.password !== 'string' || !input.password.length) throw invalid();
    const password = registerSecret(input.password);
    const loginUrl = credentialRoute(siteAddress(input.loginUrl || defaultLoginUrl, origin));
    const payload = { origin, account, password, loginUrl };
    if (input.landingUrl)
        payload.landingUrl = credentialRoute(siteAddress(input.landingUrl, origin));
    if (input.check !== undefined) {
        if (typeof input.check !== 'string') throw invalid();
        payload.check = input.check;
    }
    if (input.recipe != null) {
        if (typeof input.recipe !== 'object') throw invalid();
        payload.recipe = loginRecipe(input.recipe);
    }
    return payload;
}

function associatedData(origin, account) {
    return Buffer.from(JSON.stringify(['laya-login-credentials', 1, origin, account]));
}

export async function saveLoginCredentials(root, url, account, input) {
    const location = credentialLocation(root, url, account);
    const payload = credentialPayload(location.origin, account, input, url);
    await privateDirectory(location.auth);
    const key = await masterKey(location, true);
    try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(associatedData(location.origin, account));
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(payload), 'utf8'),
            cipher.final(),
        ]);
        await privateDirectory(location.store);
        await privateDirectory(location.site);
        writePrivateJson(location.file, {
            version: 1,
            nonce: nonce.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        });
    } finally {
        key.fill(0);
    }
}

export async function loadLoginCredentials(root, url, account) {
    if (!root || !url || !account) return null;
    const location = credentialLocation(root, url, account);
    const encrypted = await readPrivateFile(location.file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
    });
    if (!encrypted) return null;
    const key = await masterKey(location, false);
    try {
        const envelope = JSON.parse(encrypted);
        const { nonce, tag, ciphertext } = envelope;
        if (
            envelope.version !== 1 ||
            typeof nonce !== 'string' ||
            typeof tag !== 'string' ||
            typeof ciphertext !== 'string'
        )
            throw invalid();
        const iv = Buffer.from(nonce, 'base64');
        if (iv.length !== 12) throw invalid();
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(associatedData(location.origin, account));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(ciphertext, 'base64')),
            decipher.final(),
        ]);
        try {
            const payload = JSON.parse(plaintext);
            if (payload.origin !== location.origin || payload.account !== account) throw invalid();
            return credentialPayload(location.origin, account, payload);
        } finally {
            plaintext.fill(0);
        }
    } catch {
        throw Error('本地登录凭据无法验证，请检查密钥或重新录入。');
    } finally {
        key.fill(0);
    }
}
