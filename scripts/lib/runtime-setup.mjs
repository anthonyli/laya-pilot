import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Finds or provides the runtime `setup` needs, so a first install works without
// the user choosing a Python or downloading a browser by hand.

const require = createRequire(import.meta.url);
const windows = process.platform === 'win32';

/** "3.12" when the interpreter is 3.10+ and can create a venv, otherwise a reason. */
export function probePython(command, prefix = []) {
    const result = spawnSync(
        command,
        [
            ...prefix,
            '-c',
            // ensurepip is missing on some distribution Pythons, which makes venv fail later.
            'import sys, venv, ensurepip; print("%s.%s.%s" % sys.version_info[:3])',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    if (result.error) return { ok: false, reason: '无法运行' };
    const version = result.stdout?.trim();
    if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version || '')) {
        const plain = spawnSync(command, [...prefix, '--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15000,
        });
        const found = (plain.stdout || plain.stderr || '').trim().replace(/^Python\s+/i, '');
        return {
            ok: false,
            version: found,
            reason: found ? `Python ${found} 缺少 venv/ensurepip` : '无法运行',
        };
    }
    const [major, minor] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 10))
        return { ok: false, version, reason: `Python ${version}，需要 3.10 或更高版本` };
    return { ok: true, version };
}

function candidateCommands() {
    const names = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
    const directories = windows
        ? []
        : [
              '/opt/homebrew/bin',
              '/usr/local/bin',
              path.join(os.homedir(), '.local', 'bin'),
              path.join(os.homedir(), '.pyenv', 'shims'),
          ];
    const candidates = names.map((name) => [name, []]);
    if (windows)
        candidates.push(['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3']]);
    for (const directory of directories)
        for (const name of names) {
            const file = path.join(directory, name);
            if (fs.existsSync(file)) candidates.push([file, []]);
        }
    // uv-managed interpreters, when uv is installed.
    const uv = spawnSync('uv', ['python', 'find', '>=3.10'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
    });
    if (uv.status === 0 && uv.stdout.trim()) candidates.push([uv.stdout.trim(), []]);
    return candidates;
}

/**
 * Pick a Python for the private venv. An explicit choice must work; otherwise the
 * first suitable interpreter wins. Returns null when none is installed.
 */
export function findPython(explicit, dataRoot) {
    if (explicit) {
        const probe = probePython(explicit);
        if (!probe.ok)
            throw Error(
                `--python ${explicit}：${probe.reason}。可以去掉 --python 让 setup 自动查找，或指定其他 Python，例如 --python python3.12。`,
            );
        return { command: explicit, prefix: [], version: probe.version };
    }
    const bundled = bundledPythonPath(dataRoot);
    const seen = new Set();
    const rejected = [];
    for (const [command, prefix] of [
        ...(fs.existsSync(bundled) ? [[bundled, []]] : []),
        ...candidateCommands(),
    ]) {
        const key = [command, ...prefix].join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const probe = probePython(command, prefix);
        if (probe.ok) return { command, prefix, version: probe.version, rejected };
        if (probe.version) rejected.push(`${key}：${probe.reason}`);
    }
    return { command: null, rejected };
}

// python-build-standalone 3.12 "install_only" builds, pinned with their SHA-256.
// Used only when no suitable Python is installed. Release: 20261110.
const STANDALONE_RELEASE = '20261110';
const STANDALONE_VERSION = '3.12.16';
const STANDALONE = {
    'darwin-arm64': [
        'aarch64-apple-darwin',
        'e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f',
    ],
    'darwin-x64': [
        'x86_64-apple-darwin',
        '83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc',
    ],
    'linux-x64': [
        'x86_64-unknown-linux-gnu',
        'c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99',
    ],
    'linux-arm64': [
        'aarch64-unknown-linux-gnu',
        '4792f81750282597fb2a3389fe18b945ed2ba6aad5e45ad406d122c58cb33081',
    ],
    'win32-x64': [
        'x86_64-pc-windows-msvc',
        'e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b',
    ],
};

export function bundledPythonPath(dataRoot) {
    return windows
        ? path.join(dataRoot, 'python', 'python.exe')
        : path.join(dataRoot, 'python', 'bin', 'python3');
}

/** Download, verify and unpack a standalone Python into <dataRoot>/python. */
export async function installStandalonePython(dataRoot, log = console.log) {
    const entry = STANDALONE[`${process.platform}-${process.arch}`];
    if (!entry)
        throw Error(
            `没有找到 Python 3.10+，当前平台（${process.platform}-${process.arch}）也没有可自动下载的版本。请安装 Python 3.10+ 后重新运行 setup。`,
        );
    const [triple, sha256] = entry;
    const name = `cpython-${STANDALONE_VERSION}+${STANDALONE_RELEASE}-${triple}-install_only.tar.gz`;
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${STANDALONE_RELEASE}/${encodeURIComponent(name)}`;
    log(
        `没有找到 Python 3.10+，下载独立 Python ${STANDALONE_VERSION}（约 25–70 MB，只用于 falcon）…`,
    );
    let data;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        data = Buffer.from(await response.arrayBuffer());
    } catch (error) {
        throw Error(
            `下载 Python 失败（${error.cause?.code || error.message}）：${url}。请检查网络后重新运行 setup，或安装 Python 3.10+ 后用 --python 指定。`,
        );
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== sha256) throw Error('下载的 Python 校验失败（SHA-256 不一致），已放弃安装。');
    await fsp.mkdir(dataRoot, { recursive: true });
    const archive = path.join(dataRoot, name);
    const target = path.join(dataRoot, 'python');
    await fsp.writeFile(archive, data);
    try {
        await fsp.rm(target, { recursive: true, force: true });
        // tar ships with macOS, Linux and Windows 10+; the archive unpacks to python/.
        const unpacked = spawnSync('tar', ['-xzf', archive, '-C', dataRoot], { stdio: 'inherit' });
        if (unpacked.status !== 0) throw Error('解压 Python 失败。');
    } finally {
        await fsp.rm(archive, { force: true });
    }
    const python = bundledPythonPath(dataRoot);
    const probe = probePython(python);
    if (!probe.ok) throw Error(`下载的 Python 无法使用：${probe.reason}`);
    return { command: python, prefix: [], version: probe.version };
}

const SYSTEM_BROWSERS = {
    darwin: {
        chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    },
    linux: {
        chrome: [
            '/opt/google/chrome/chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
        ],
        msedge: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'],
    },
    win32: {
        chrome: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map((v) =>
            path.join(process.env[v] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ),
        msedge: ['PROGRAMFILES', 'PROGRAMFILES(X86)'].map((v) =>
            path.join(process.env[v] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ),
    },
};

const BROWSER_NAMES = {
    chromium: 'Playwright Chromium',
    chrome: 'Google Chrome',
    msedge: 'Microsoft Edge',
};
export const browserName = (channel) => BROWSER_NAMES[channel || 'chromium'] || channel;

export function playwrightChromiumInstalled() {
    try {
        return fs.existsSync(require('playwright').chromium.executablePath());
    } catch {
        return false;
    }
}

export function systemBrowserInstalled(channel) {
    return (SYSTEM_BROWSERS[process.platform]?.[channel] || []).some(
        (file) => file && fs.existsSync(file),
    );
}

/** Whether the browser a run will use is present: '' or 'chromium' means Playwright's. */
export function browserAvailable(channel) {
    return !channel || channel === 'chromium'
        ? playwrightChromiumInstalled()
        : systemBrowserInstalled(channel);
}

/**
 * Prefer a browser that is already on this computer: Playwright's Chromium, then
 * Chrome, then Edge. Returns the channel to configure, or null when one must be downloaded.
 */
export function chooseInstalledBrowser() {
    if (playwrightChromiumInstalled()) return 'chromium';
    for (const channel of ['chrome', 'msedge']) if (systemBrowserInstalled(channel)) return channel;
    return null;
}

/** Set KEY=value in .env.local only when the key has no value yet; never overrides a choice. */
export async function rememberSetting(file, key, value) {
    const current = await fsp.readFile(file, 'utf8').catch(() => '');
    if (new RegExp(`^[ \\t]*${key}=\\S`, 'm').test(current)) return false;
    const empty = new RegExp(`^[ \\t]*${key}=[ \\t]*$`, 'm');
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    const next = empty.test(current)
        ? current.replace(empty, `${key}=${value}`)
        : `${current}${separator}${key}=${value}\n`;
    await fsp.writeFile(file, next, { mode: 0o600 });
    return true;
}
