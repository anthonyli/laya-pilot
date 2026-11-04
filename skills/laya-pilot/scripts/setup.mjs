import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLocalEnvironment } from '../runtime/lib/project-config.mjs';
import { safeText } from '../runtime/lib/diagnostics.mjs';
import {
    findPython,
    initializeConfig,
    npmCommand,
    option,
    pythonVersion,
    requireNode,
    run,
    runtimeRoot,
    skillRoot,
    venvPython,
    resolveSkillSettings,
} from './common.mjs';

function check(local, resolved) {
    const checks = [];
    const { settings, summary } = resolved;
    console.log('CONFIG ' + JSON.stringify(summary));
    const python = settings.python;
    checks.push(['Node.js 20+', true]);
    checks.push(['Python 3.10+', Boolean(pythonVersion(python))]);
    const probe = (source) => spawnSync(python, ['-c', source], { stdio: 'ignore' }).status === 0;
    checks.push(['Python openpyxl', probe('import openpyxl')]);
    const installed = fs.existsSync(path.join(runtimeRoot, 'node_modules', 'playwright'));
    checks.push(['Playwright dependency', installed]);
    let browser = false;
    if (installed) {
        const require = createRequire(path.join(runtimeRoot, 'package.json'));
        browser = fs.existsSync(require('playwright').chromium.executablePath());
    }
    checks.push(['Playwright Chromium', browser]);
    if (local) {
        checks.push([
            'Local Laya package',
            probe('import importlib.util; assert importlib.util.find_spec("laya")'),
        ]);
        checks.push(['Local model directory', fs.existsSync(settings.model)]);
    } else {
        for (const [name, value] of [
            ['LAYA_API_BASE', settings.apiBase],
            ['LAYA_API_MODEL', settings.apiModel],
            ['LAYA_API_KEY', process.env.LAYA_API_KEY],
        ])
            checks.push([name + ' set', Boolean(value?.trim())]);
        if (settings.apiBase) {
            let valid = false;
            try {
                const url = new URL(settings.apiBase);
                valid =
                    url.protocol === 'https:' &&
                    !url.username &&
                    !url.password &&
                    !url.search &&
                    !url.hash;
            } catch {}
            checks.push(['API HTTPS base URL', valid]);
        }
    }
    for (const [label, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'} ${label}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

try {
    requireNode();
    const args = process.argv.slice(2);
    const valueOptions = ['--python', '--config', '--model', '--api-base', '--api-model'];
    const allowed = new Set([
        '--check',
        '--skip-browser',
        '--local-model',
        '--help',
        ...valueOptions,
    ]);
    for (let i = 0; i < args.length; i++) {
        if (!allowed.has(args[i])) throw Error('Unknown setup option: ' + args[i]);
        if (valueOptions.includes(args[i])) {
            option(args, args[i]);
            i++;
        }
    }
    if (args.includes('--help')) {
        console.log(
            'node scripts/setup.mjs [--python PATH] [--skip-browser]\n  Installs API runtime: Playwright, Chromium, a Python venv and openpyxl.\n--check: inspect environment/configuration without installing.\n--local-model: explicitly install Laya AND download its multilingual weights.\n',
        );
    } else {
        const local = args.includes('--local-model');
        if (args.includes('--check')) {
            check(local, await resolveSkillSettings(args, local ? 'local' : 'api'));
        } else {
            await loadLocalEnvironment(skillRoot);
            const [npm, prefix] = npmCommand();
            const npmVersion = spawnSync(npm, [...prefix, '--version'], { stdio: 'ignore' });
            if (npmVersion.status !== 0) throw Error('npm is required; install Node.js with npm.');
            if (!fs.existsSync(venvPython)) {
                const python = findPython(option(args, '--python'));
                console.log('Creating private Python environment (' + python.version + ').');
                await run(python.command, [
                    ...python.prefix,
                    '-m',
                    'venv',
                    path.join(skillRoot, '.venv'),
                ]);
            }
            if (!pythonVersion(venvPython)) throw Error('The skill venv requires Python 3.10+.');
            await run(npm, [...prefix, 'ci', '--omit=dev'], { cwd: runtimeRoot });
            await run(venvPython, [
                '-m',
                'pip',
                'install',
                '-r',
                path.join(runtimeRoot, local ? 'requirements-local.txt' : 'requirements.txt'),
            ]);
            if (!args.includes('--skip-browser'))
                await run(process.execPath, [
                    path.join(runtimeRoot, 'node_modules', 'playwright', 'cli.js'),
                    'install',
                    'chromium',
                ]);
            if (local) {
                console.log('Explicit local-model setup: downloading multilingual model weights.');
                await run(venvPython, [
                    '-c',
                    'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id="convaiinnovations/laya-multilingual", local_dir=sys.argv[1])',
                    path.join(skillRoot, 'models', 'laya-multilingual'),
                ]);
            }
            initializeConfig();
            console.log(
                local
                    ? 'Local model ready. Run scripts/run.mjs with --provider local to use it.'
                    : 'API runtime ready. Fill API settings in the skill .env.local and the target URL in config.local.json. No local model was installed or downloaded.',
            );
        }
    }
} catch (error) {
    console.error(safeText(error.message, 1200));
    process.exitCode = 1;
}
