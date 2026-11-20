import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadLocalEnvironment } from './lib/project-config.mjs';
import { safeText, safeUrl } from './lib/diagnostics.mjs';

import { cmd, codeRoot, dataRoot, isCli, venvPython } from './lib/entry.mjs';

export { cmd, codeRoot, dataRoot, isCli, venvPython };
/** Directory holding the shipped code and assets (the skill root for skill installs). */
export const skillRoot = codeRoot;

export function skillVersion() {
    const file = path.join(skillRoot, 'manifest.json');
    return fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : {
              version: JSON.parse(fs.readFileSync(path.join(skillRoot, 'package.json'), 'utf8'))
                  .version,
              contentHash: null,
          };
}

export async function resolveSkillSettings(args, provider = option(args, '--provider') || 'api') {
    const loaded = await loadLocalEnvironment(dataRoot);
    if (args.includes('--config'))
        throw Error(
            `Use ${path.join(dataRoot, '.env.local')} for configuration; --config is no longer supported.`,
        );
    const sources = {};
    const value = (field, cli, env, fallback = '') => {
        const candidates = [
            [option(args, cli), 'cli'],
            [process.env[env], `${loaded.includes(env) ? '.env.local' : 'env'}:${env}`],
            [fallback, 'default'],
        ];
        const selected = candidates.find(([v]) => v !== undefined && v !== null && v !== '') || [
            '',
            'default',
        ];
        sources[field] = selected[1];
        return selected[0];
    };
    const settings = {
        provider,
        python: value(
            'python',
            '--python',
            'LAYA_PYTHON',
            fs.existsSync(venvPython) ? venvPython : '',
        ),
        model: value(
            'model',
            '--model',
            'LAYA_MODEL',
            path.join(dataRoot, 'models', 'laya-multilingual'),
        ),
        apiBase: value('apiBase', '--api-base', 'LAYA_API_BASE'),
        apiModel: value('apiModel', '--api-model', 'LAYA_API_MODEL', 'laya-decision'),
        url: value('url', '--url', 'TEST_URL'),
        authState: value('authState', '--auth-state', 'TEST_AUTH_STATE'),
    };
    const version = skillVersion();
    const summary = {
        skillRoot,
        dataRoot,
        version: version.version,
        contentHash: version.contentHash,
        cwd: process.cwd(),
        envPath: path.join(dataRoot, '.env.local'),
        provider,
        python: safeText(settings.python, 1000),
        ...(provider === 'api'
            ? {
                  apiBase: settings.apiBase ? safeUrl(settings.apiBase) : '',
                  apiModel: safeText(settings.apiModel),
                  apiKeyConfigured: Boolean(process.env.LAYA_API_KEY?.trim()),
              }
            : { model: safeText(settings.model, 1000) }),
        url: settings.url ? safeUrl(settings.url) : '',
        authState: settings.authState ? safeText(path.resolve(settings.authState), 1000) : null,
        authStateExists: Boolean(
            settings.authState && fs.existsSync(path.resolve(settings.authState)),
        ),
        sources,
    };
    return { settings, summary };
}

export function option(args, name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--'))
        throw Error(`${name} requires a value`);
    return args[index + 1];
}

export function requireNode() {
    if (Number(process.versions.node.split('.')[0]) < 20)
        throw Error('Node.js 20 or newer is required.');
}

export function initializeConfig() {
    const destination = path.join(dataRoot, '.env.local');
    fs.mkdirSync(dataRoot, { recursive: true });
    try {
        fs.copyFileSync(
            path.join(skillRoot, 'assets', '.env.example'),
            destination,
            fs.constants.COPYFILE_EXCL,
        );
        fs.chmodSync(destination, 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

export function pythonVersion(command, prefix = []) {
    const result = spawnSync(
        command,
        [...prefix, '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'],
        { encoding: 'utf8', windowsHide: true },
    );
    const match = result.stdout?.trim().match(/^(\d+)\.(\d+)$/);
    if (result.status !== 0 || !match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 3 || (major === 3 && minor >= 10) ? match[0] : null;
}

export function npmCommand() {
    if (process.platform !== 'win32') return ['npm', []];
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const located = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8' });
    for (const file of (located.stdout || '').trim().split(/\r?\n/)) {
        if (file)
            candidates.push(
                path.join(path.dirname(file), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            );
    }
    const cli = candidates.find((file) => file?.endsWith('.js') && fs.existsSync(file));
    if (!cli) throw Error('npm was not found; install Node.js with npm.');
    return [process.execPath, [cli]];
}

export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) reject(Error(`Process stopped by ${signal}`));
            else if (code !== 0) reject(Error(`Process exited with code ${code}`));
            else resolve();
        });
    });
}
