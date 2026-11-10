import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
    const temporary = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'laya-skill-launcher-')),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const skill = path.join(temporary, 'installed skill');
    const cwd = path.join(temporary, 'user workspace');
    await fs.mkdir(path.join(skill, 'scripts', 'lib'), { recursive: true });
    await fs.mkdir(cwd);
    await fs.cp(path.join(root, 'scripts'), path.join(skill, 'scripts'), {
        recursive: true,
    });
    await fs.cp(path.join(root, 'assets'), path.join(skill, 'assets'), {
        recursive: true,
    });
    await fs.copyFile(
        path.join(root, 'scripts', 'lib', 'project-config.mjs'),
        path.join(skill, 'scripts', 'lib', 'project-config.mjs'),
    );
    await fs.copyFile(
        path.join(root, 'scripts', 'lib', 'diagnostics.mjs'),
        path.join(skill, 'scripts/lib/diagnostics.mjs'),
    );
    await fs.copyFile(path.join(root, 'package.json'), path.join(skill, 'package.json'));
    // Record the launched command at the runtime boundary without installing or calling models.
    await fs.writeFile(
        path.join(skill, 'scripts/runner.mjs'),
        'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),excel:process.env.TEST_EXCEL,headless:process.env.BROWSER_HEADLESS}));\n',
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LAYA_|TEST_|BROWSER_)/.test(key)) delete env[key];
    const launch = (args, extraEnv = {}) => {
        const result = spawnSync(
            process.execPath,
            [path.join(skill, 'scripts', 'run.mjs'), ...args],
            {
                cwd,
                env: { ...env, ...extraEnv },
                encoding: 'utf8',
            },
        );
        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trim().split('\n');
        const command = JSON.parse(lines.at(-1));
        command.config = JSON.parse(lines.find((line) => line.startsWith('CONFIG ')).slice(7));
        command.value = (flag) => command.args[command.args.indexOf(flag) + 1];
        return command;
    };
    const initialize = () => {
        const moduleUrl = pathToFileURL(path.join(skill, 'scripts', 'common.mjs')).href;
        const result = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { initializeConfig } from ${JSON.stringify(moduleUrl)}; initializeConfig();`,
            ],
            { cwd, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
    };
    return { skill, cwd, launch, initialize, env };
}

test('standalone launcher defaults to API and ignores legacy JSON configurations', async (t) => {
    const { skill, cwd, launch } = await fixture(t);
    await fs.writeFile(path.join(skill, 'config.local.json'), 'obsolete invalid JSON');
    await fs.writeFile(path.join(cwd, 'config.local.json'), 'unrelated invalid JSON');
    await fs.writeFile(
        path.join(skill, '.env.local'),
        `LAYA_PYTHON=${process.execPath}\nLAYA_PROVIDER=local\n`,
    );
    const command = launch(['--mode', 'generate'], { LAYA_PROVIDER: 'local' });
    assert.equal(command.value('--provider'), 'api');
    assert.equal(command.value('--python'), process.execPath);
    assert.equal(command.args.includes('--config'), false);
    assert.equal(command.cwd, cwd);
    assert.ok(command.value('--out').startsWith(path.join(cwd, 'runs', 'laya-pilot') + path.sep));
    assert.ok(
        command.value('--case-file').startsWith(path.join(cwd, 'generated-cases') + path.sep),
    );
    assert.equal(command.args.includes('--model'), false);
});

test('setup creates only .env.local and preserves existing configuration', async (t) => {
    const { skill, cwd, initialize } = await fixture(t);
    initialize();
    assert.equal(
        await fs.readFile(path.join(skill, '.env.local'), 'utf8'),
        await fs.readFile(path.join(skill, 'assets', '.env.example'), 'utf8'),
    );
    await assert.rejects(fs.access(path.join(skill, 'config.local.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(cwd, '.env.local')), { code: 'ENOENT' });
    const customEnv =
        'LAYA_API_KEY=test-value-to-preserve\nTEST_URL=https://configured.example/customers\n';
    await fs.writeFile(path.join(skill, '.env.local'), customEnv);
    initialize();
    assert.equal(await fs.readFile(path.join(skill, '.env.local'), 'utf8'), customEnv);
});

test('skill environment is loaded from its own directory and preserves configured inputs and outputs', async (t) => {
    const { skill, cwd, launch } = await fixture(t);
    await fs.writeFile(
        path.join(skill, '.env.local'),
        `LAYA_PYTHON=${process.execPath}\nTEST_EXCEL=/cases/my cases.xlsx\nBROWSER_HEADLESS=true\nTEST_OUTPUT=/reports/chosen\nTEST_CASE_FILE=/cases/generated.xlsx\n`,
    );
    await fs.writeFile(path.join(cwd, '.env.local'), 'invalid unrelated environment');
    const command = launch(['--mode', 'generate']);
    assert.equal(command.excel, '/cases/my cases.xlsx');
    assert.equal(command.headless, 'true');
    assert.equal(command.args.includes('--out'), false);
    assert.equal(command.args.includes('--case-file'), false);
    assert.equal(command.value('--python'), process.execPath);
    assert.equal(command.config.envPath, path.join(skill, '.env.local'));
    assert.equal(command.cwd, cwd);
    assert.equal(command.value('--provider'), 'api');
});

test('local inference requires an explicit CLI choice and keeps the selected model', async (t) => {
    const { launch } = await fixture(t);
    const command = launch([
        '--provider',
        'local',
        '--model',
        '/models/my model',
        '--python',
        process.execPath,
        '--mode',
        'generate',
    ]);
    assert.equal(command.value('--provider'), 'local');
    assert.equal(command.args.filter((value) => value === '--provider').length, 1);
    assert.equal(command.value('--model'), '/models/my model');
});

test('inspection supplies no credentials and explicit output locations are preserved', async (t) => {
    const { cwd, launch } = await fixture(t);
    const output = path.join(cwd, 'chosen output');
    const command = launch([
        '--excel',
        'cases.xlsx',
        '--inspect',
        '--python',
        process.execPath,
        '--out',
        output,
    ]);
    assert.equal(command.value('--provider'), 'api');
    assert.equal(command.args.includes('--api-base'), false);
    assert.equal(command.value('--api-model'), 'laya-decision');
    assert.equal(command.value('--out'), output);
    assert.equal(command.args.filter((value) => value === '--out').length, 1);
    assert.equal(command.args.includes('--case-file'), false);
});

test('setup check and launcher resolve the same environment and redact secrets in diagnostics', async (t) => {
    const { skill, cwd, launch, env } = await fixture(t);
    const config = {
        python: process.execPath,
        apiBase: 'https://decision.example/v1',
        apiModel: 'chosen-decision-model',
    };
    const key = 'fixture-private-api-credential';
    await fs.writeFile(
        path.join(skill, '.env.local'),
        `LAYA_PYTHON=${config.python}\nLAYA_API_BASE=${config.apiBase}\nLAYA_API_MODEL=${config.apiModel}\nLAYA_API_KEY=${key}\n`,
    );
    const run = launch(['--mode', 'generate']);
    assert.equal(run.value('--api-base'), config.apiBase);
    assert.equal(run.value('--api-model'), config.apiModel);
    assert.equal(run.config.sources.apiBase, '.env.local:LAYA_API_BASE');
    assert.equal(run.config.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(run).includes(key));
    const check = spawnSync(process.execPath, [path.join(skill, 'scripts/setup.mjs'), '--check'], {
        cwd,
        env,
        encoding: 'utf8',
    });
    // The fixture has no Python/Playwright; API resolution must still agree with run.
    const summary = JSON.parse(
        check.stdout
            .split('\n')
            .find((line) => line.startsWith('CONFIG '))
            .slice(7),
    );
    for (const field of ['python', 'apiBase', 'apiModel', 'envPath'])
        assert.equal(summary[field], run.config[field]);
    assert.match(check.stdout, /OK LAYA_API_BASE set/);
    assert.match(check.stdout, /OK LAYA_API_MODEL set/);
    assert.ok(!check.stdout.includes(key));
    const override = launch(['--mode', 'generate', '--api-model', 'explicit-model'], {
        LAYA_API_MODEL: 'env-model',
    });
    assert.equal(override.value('--api-model'), 'explicit-model');
    assert.equal(override.config.sources.apiModel, 'cli');
});

test('standalone help works before setup and names only bundled entry points', async (t) => {
    const { skill, cwd } = await fixture(t);
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts', 'run.mjs'), '--help'], {
        cwd,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /API model by default/);
    assert.match(result.stdout, /node scripts\/run\.mjs --mode generate/);
    assert.doesNotMatch(result.stdout, /run\.sh/);
});

test('source skill reports package version without a generated manifest', async (t) => {
    const { skill, cwd } = await fixture(t);
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts/run.mjs'), '--version'], {
        cwd,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(await fs.readFile(path.join(skill, 'package.json'), 'utf8'));
    assert.deepEqual(JSON.parse(result.stdout), { version: pkg.version, contentHash: null });
    await assert.rejects(fs.access(path.join(skill, 'manifest.json')), { code: 'ENOENT' });
});

test('installed content version is available before configuration or dependencies', async (t) => {
    const { skill, cwd } = await fixture(t);
    const version = {
        version: '0.1.0',
        contentHash: 'fixture-content-digest',
        files: { 'SKILL.md': 'hash' },
    };
    await fs.writeFile(path.join(skill, 'manifest.json'), JSON.stringify(version));
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts/run.mjs'), '--version'], {
        cwd,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        version: version.version,
        contentHash: version.contentHash,
    });
});

test('skill entrypoints reject obsolete --config rather than silently ignoring it', async (t) => {
    const { skill, cwd, env } = await fixture(t);
    for (const entry of ['run', 'setup']) {
        const result = spawnSync(
            process.execPath,
            [path.join(skill, 'scripts', entry + '.mjs'), '--config', 'old.json'],
            { cwd, env, encoding: 'utf8' },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /--config/);
    }
});
