import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLocalEnvironment } from './lib/project-config.mjs';
import { safeText } from './lib/diagnostics.mjs';
import { accent, printPanel, resultLabel } from './lib/cli-output.mjs';
import {
    browserAvailable,
    browserName,
    chooseInstalledBrowser,
    findPython,
    installStandalonePython,
    probePython,
    rememberSetting,
} from './lib/runtime-setup.mjs';
import {
    cmd,
    dataRoot,
    isCli,
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
const envPath = path.join(dataRoot, '.env.local');

function playwrightRoot() {
    try {
        return path.dirname(require.resolve('playwright/package.json'));
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return null;
    }
}

const step = (text) => console.log(`\n  ${accent('›')} ${text}`);
const done = (text) => console.log(`    ${resultLabel(0, '✓')} ${text}`);

/** The browser runs will use, from BROWSER_CHANNEL; empty means Playwright's Chromium. */
const configuredChannel = () => process.env.BROWSER_CHANNEL?.trim() || '';

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
    checks.push([
        `Browser: ${browserName(configuredChannel())}`,
        installed && browserAvailable(configuredChannel()),
    ]);
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

/**
 * Use a browser already on this computer when there is one (Playwright's Chromium,
 * then Chrome, then Edge); download Chromium only when none is found.
 */
async function prepareBrowser() {
    const root = playwrightRoot();
    if (!root) throw Error('Playwright is missing. Reinstall LayaPilot with npm.');
    const configured = configuredChannel();
    if (configured && browserAvailable(configured)) return `${browserName(configured)}（已配置）`;
    if (configured) console.log(`    ${browserName(configured)} 未安装，改为查找本机其他浏览器。`);
    const found = chooseInstalledBrowser();
    if (found === 'chromium') return `${browserName(found)}（已安装）`;
    if (found) {
        // Stored in .env.local so Excel runs, recording and replay all use it.
        if (!configured) await rememberSetting(envPath, 'BROWSER_CHANNEL', found);
        return `${browserName(found)}（本机已安装，无需下载）`;
    }
    console.log('    本机没有可用的 Chrome、Edge 或 Chromium，下载 Playwright Chromium…');
    await run(process.execPath, [path.join(root, 'cli.js'), 'install', 'chromium']);
    return `${browserName('chromium')}（已下载）`;
}

async function setupRecording(checkOnly) {
    if (!playwrightRoot())
        throw Error('Playwright is missing. From the source directory, run npm ci --omit=dev.');
    await loadLocalEnvironment(dataRoot);
    if (checkOnly) {
        const ready = browserAvailable(configuredChannel());
        printPanel(
            'Check',
            resultLabel(
                ready ? 0 : 1,
                ready
                    ? `Recording is ready · ${browserName(configuredChannel())}`
                    : `${browserName(configuredChannel())} is missing`,
            ),
            [['NEXT', [cmd(ready ? 'record URL' : 'setup --recording')]]],
        );
        if (!ready) process.exitCode = 1;
        return;
    }
    initializeConfig();
    step('浏览器');
    done(await prepareBrowser());
    printPanel('Ready', resultLabel(0, 'Recording is ready'), [['NEXT', [cmd('record URL')]]]);
}

/** Reuse the private venv, or create it from the best Python available (downloading one if needed). */
async function preparePython(explicit) {
    if (fs.existsSync(venvPython) && !explicit) {
        const probe = probePython(venvPython);
        if (probe.ok) return `Python ${probe.version}（${path.join(dataRoot, '.venv')}）`;
    }
    let python = findPython(explicit, dataRoot);
    if (!python.command) {
        for (const reason of python.rejected || []) console.log(`    跳过 ${reason}`);
        python = await installStandalonePython(dataRoot, (text) => console.log(`    ${text}`));
    }
    if (fs.existsSync(venvPython)) fs.rmSync(path.join(dataRoot, '.venv'), { recursive: true });
    await run(python.command, [...python.prefix, '-m', 'venv', path.join(dataRoot, '.venv')]);
    if (!pythonVersion(venvPython)) throw Error(`The venv in ${dataRoot} requires Python 3.10+.`);
    return `Python ${python.version}（${python.command}）`;
}

async function setupRuntime(args) {
    const local = args.includes('--local-model');
    await loadLocalEnvironment(dataRoot);
    initializeConfig();
    console.log(`\n  ${accent('LayaPilot')}  setup · ${dataRoot}`);

    step('Python 运行环境（读写 Excel）');
    const python = await preparePython(option(args, '--python'));
    done(python);

    // npm already manages the CLI's dependencies; only the skill directory installs its own.
    if (!isCli && fs.existsSync(path.join(skillRoot, 'package-lock.json'))) {
        step('Node 依赖');
        const [npm, prefix] = npmCommand();
        await run(npm, [...prefix, 'ci', '--omit=dev'], { cwd: skillRoot });
        done('Playwright');
    } else if (!playwrightRoot())
        throw Error('Playwright is missing. Reinstall LayaPilot with npm.');

    step(local ? 'Python 依赖（含本地模型）' : 'Python 依赖');
    try {
        await run(venvPython, [
            '-m',
            'pip',
            'install',
            '--disable-pip-version-check',
            '--quiet',
            '--retries',
            '5',
            '--timeout',
            '60',
            '-r',
            path.join(skillRoot, local ? 'requirements-local.txt' : 'requirements.txt'),
        ]);
    } catch (error) {
        throw Error(
            `安装 Python 依赖失败（${error.message}）。多为网络问题：检查网络或 pip 镜像（PIP_INDEX_URL）后重新运行 ${cmd('setup')}，已完成的步骤会直接复用。`,
        );
    }
    done(local ? 'openpyxl、laya' : 'openpyxl');

    let browser = '已跳过';
    if (!args.includes('--skip-browser')) {
        step('浏览器');
        browser = await prepareBrowser();
        done(browser);
    }

    if (local) {
        step('本地模型权重');
        await run(venvPython, [
            '-c',
            'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id="convaiinnovations/laya-multilingual", local_dir=sys.argv[1])',
            path.join(dataRoot, 'models', 'laya-multilingual'),
        ]);
        done(path.join(dataRoot, 'models', 'laya-multilingual'));
    }

    const apiReady = Boolean(process.env.LAYA_API_BASE?.trim() && process.env.LAYA_API_KEY?.trim());
    printPanel('Ready', resultLabel(0, '运行环境已就绪'), [
        ['PYTHON', [python]],
        ['BROWSER', [browser]],
        ['CONFIG', [envPath]],
        [
            'NEXT',
            local
                ? [`${cmd('run')} --provider local --excel FILE --url URL`]
                : apiReady
                  ? [cmd('check'), cmd('run --excel FILE --url URL --headless')]
                  : [
                        `在 ${envPath} 填写 LAYA_API_BASE 和 LAYA_API_KEY`,
                        `然后运行 ${cmd('check')}`,
                    ],
        ],
    ]);
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
                    `${cmd('setup --recording')}  Use an installed browser, or download Chromium`,
                    `${cmd('check --recording')}  Check the browser`,
                ],
            ],
            [
                'EXCEL & AI',
                [
                    `${cmd('setup')}  Prepare Python, openpyxl and a browser`,
                    `${cmd('check')}  Check runtime and configuration`,
                    '--python PATH             Use this Python (found automatically otherwise)',
                    '--skip-browser            Skip the browser step',
                    '--local-model             Install the local model and weights',
                ],
            ],
            [
                'DEFAULTS',
                [
                    'Python: the newest 3.10+ found; a private copy is downloaded if none.',
                    'Browser: Playwright Chromium, Chrome or Edge if installed; else download.',
                ],
            ],
        ]);
    } else if (args.includes('--recording')) {
        if (args.some((arg) => arg !== '--recording' && arg !== '--check'))
            throw Error('Use --recording by itself for setup or check.');
        await setupRecording(args.includes('--check'));
    } else if (args.includes('--check')) {
        const local = args.includes('--local-model');
        check(local, await resolveSkillSettings(args, local ? 'local' : 'api'));
    } else {
        await setupRuntime(args);
    }
} catch (error) {
    console.error(safeText(error.message, 1200));
    process.exitCode = 1;
}
