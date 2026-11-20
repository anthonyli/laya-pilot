import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLocalEnvironment } from './lib/project-config.mjs';
import { safeText } from './lib/diagnostics.mjs';
import { printPanel, resultLabel } from './lib/cli-output.mjs';
import {
    cmd,
    dataRoot,
    isCli,
    findPython,
    initializeConfig,
    npmCommand,
    option,
    pythonVersion,
    requireNode,
    run,
    skillRoot,
    venvPython,
    resolveSkillSettings,
} from './common.mjs';

const require = createRequire(import.meta.url);

function playwrightRoot() {
    try {
        return path.dirname(require.resolve('playwright/package.json'));
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return null;
    }
}

function check(local, resolved) {
    const checks = [];
    const { settings, summary } = resolved;
    console.log('CONFIG ' + JSON.stringify(summary));
    const python = settings.python;
    checks.push(['Node.js 20+', true]);
    checks.push(['Python 3.10+', Boolean(python && pythonVersion(python))]);
    // A fresh install has no venv yet: report it as missing instead of spawning an empty command.
    const probe = (source) =>
        Boolean(python) && spawnSync(python, ['-c', source], { stdio: 'ignore' }).status === 0;
    checks.push(['Python openpyxl', probe('import openpyxl')]);
    const installed = Boolean(playwrightRoot());
    checks.push(['Playwright dependency', installed]);
    checks.push(['Playwright Chromium', installed && hasRecordingBrowser()]);
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

function hasRecordingBrowser() {
    return fs.existsSync(require('playwright').chromium.executablePath());
}

async function setupRecording(checkOnly) {
    const root = playwrightRoot();
    if (!root)
        throw Error('Playwright is missing. From the source directory, run npm ci --omit=dev.');
    if (checkOnly) {
        const ready = hasRecordingBrowser();
        printPanel(
            'Check',
            resultLabel(ready ? 0 : 1, ready ? 'Recording is ready' : 'Chromium is missing'),
            [['NEXT', [cmd(ready ? 'record URL' : 'setup --recording')]]],
        );
        if (!ready) process.exitCode = 1;
        return;
    }
    printPanel('Setup', 'Preparing Chromium for recording and replay.');
    await run(process.execPath, [path.join(root, 'cli.js'), 'install', 'chromium']);
    printPanel('Ready', resultLabel(0, 'Browser installed'), [['NEXT', [cmd('record URL')]]]);
}

try {
    requireNode();
    const args = process.argv.slice(2);
    const valueOptions = ['--python', '--model', '--api-base', '--api-model'];
    const allowed = new Set([
        '--check',
        '--skip-browser',
        '--local-model',
        '--recording',
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
        printPanel('Setup', 'Prepare the runtime for the way you test.', [
            [
                'RECORDING',
                [
                    `${cmd('setup --recording')}  Install Chromium`,
                    `${cmd('check --recording')}  Check Playwright and Chromium`,
                ],
            ],
            [
                'EXCEL & AI',
                [
                    `${cmd('setup')}  Prepare Excel and API runtime`,
                    `${cmd('check')}  Check runtime and configuration`,
                    '--python PATH             Choose the Python executable',
                    '--skip-browser            Skip Chromium installation',
                    '--local-model             Install the local model and weights',
                ],
            ],
        ]);
    } else if (args.includes('--recording')) {
        if (args.some((arg) => arg !== '--recording' && arg !== '--check'))
            throw Error('Use --recording by itself for setup or check.');
        await setupRecording(args.includes('--check'));
    } else {
        const local = args.includes('--local-model');
        if (args.includes('--check')) {
            check(local, await resolveSkillSettings(args, local ? 'local' : 'api'));
        } else {
            await loadLocalEnvironment(dataRoot);
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
                    path.join(dataRoot, '.venv'),
                ]);
            }
            if (!pythonVersion(venvPython))
                throw Error(`The venv in ${dataRoot} requires Python 3.10+.`);
            // npm already manages the CLI's dependencies; only the skill directory installs its own.
            if (!isCli && fs.existsSync(path.join(skillRoot, 'package-lock.json'))) {
                await run(npm, [...prefix, 'ci', '--omit=dev'], { cwd: skillRoot });
            } else if (!playwrightRoot()) {
                throw Error('Playwright is missing. Reinstall LayaPilot with npm.');
            }
            await run(venvPython, [
                '-m',
                'pip',
                'install',
                '-r',
                path.join(skillRoot, local ? 'requirements-local.txt' : 'requirements.txt'),
            ]);
            if (!args.includes('--skip-browser'))
                await run(process.execPath, [
                    path.join(playwrightRoot(), 'cli.js'),
                    'install',
                    'chromium',
                ]);
            if (local) {
                console.log('Explicit local-model setup: downloading multilingual model weights.');
                await run(venvPython, [
                    '-c',
                    'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id="convaiinnovations/laya-multilingual", local_dir=sys.argv[1])',
                    path.join(dataRoot, 'models', 'laya-multilingual'),
                ]);
            }
            initializeConfig();
            console.log(
                local
                    ? `Local model ready. Run ${cmd('run')} with --provider local to use it.`
                    : `API runtime ready. Fill API settings in ${path.join(dataRoot, '.env.local')}. No local model was installed or downloaded.`,
            );
        }
    }
} catch (error) {
    console.error(safeText(error.message, 1200));
    process.exitCode = 1;
}
