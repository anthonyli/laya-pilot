import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { printPanel, resultLabel } from './cli-output.mjs';
import { cmd } from './entry.mjs';
import { RUN_FILES, runDirectoryName, uniqueRunDirectory } from './run-layout.mjs';
import { finalizeRun } from './run-index.mjs';
import { safeText, safeUrl } from './diagnostics.mjs';

const require = createRequire(import.meta.url);
const importLine = "import { test, expect } from '@playwright/test';";
const channels = ['chromium', 'chrome', 'msedge'];

function runPlaywright(root, args, cwd, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, 'cli.js'), ...args], {
            cwd,
            env,
            stdio: 'inherit',
        });
        const interrupt = () => child.kill('SIGINT');
        const terminate = () => child.kill('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', reject);
        child.once('close', (code, signal) => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
        });
    });
}

async function withTempDirectory(work) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-recording-'));
    try {
        return await work(directory);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

async function record(root, input, options) {
    const invalidUrl = '录制需要一个不含账号密码的 HTTP(S) 地址';
    let url;
    try {
        url = new URL(input);
    } catch {
        throw Error(invalidUrl);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw Error(invalidUrl);
    const output = path.resolve(options.out ?? `recorded-cases/${runDirectoryName()}.spec.cjs`);
    if (!output.endsWith('.spec.cjs')) throw Error('录制用例文件名必须以 .spec.cjs 结尾');
    if (options['excel-out'] && !options['excel-out'].toLowerCase().endsWith('.xlsx'))
        throw Error('Excel 输出文件须以 .xlsx 结尾。');
    try {
        await fs.lstat(output);
        throw Error('目标用例文件已存在，请换一个文件名');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const channel = options['browser-channel'];
    if (channel && !channels.includes(channel))
        throw Error(`浏览器通道可选 ${channels.join('、')}`);
    const storage = options['storage-state'] && path.resolve(options['storage-state']);
    if (storage) await fs.access(storage);

    return withTempDirectory(async (directory) => {
        const draft = path.join(directory, 'recording.spec.js');
        const args = ['codegen', '--target', 'playwright-test', '--output', draft];
        if (channel) args.push('--channel', channel);
        if (storage) args.push('--load-storage', storage);
        args.push(url.href);
        printPanel('Record', 'A browser is opening. Use test data in the recording.', [
            [
                'IN THE BROWSER',
                [
                    'Perform the workflow.',
                    'Use the recorder toolbar to mark what should appear.',
                    'Close the recording browser to save the case.',
                ],
            ],
        ]);
        const code = await runPlaywright(root, args, directory);
        if (code) return code;
        const source = await fs.readFile(draft, 'utf8').catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            throw Error(
                `The recording ended before any case was saved. Run ${cmd('record')} again.`,
            );
        });
        const header = "const { test, expect } = require('playwright/test');";
        if (!source.trimStart().startsWith(importLine)) throw Error('无法识别 Playwright 录制文件');
        const spec = source.replace(
            importLine,
            channel ? `${header}\ntest.use({ channel: ${JSON.stringify(channel)} });` : header,
        );
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, spec, { flag: 'wx', mode: 0o600 });
        if (!options['code-only']) {
            const excel = path.resolve(
                options['excel-out'] ?? output.replace(/\.spec\.cjs$/, '.xlsx'),
            );
            try {
                const { exportRecording } = await import('./recorded-excel.mjs');
                const converted = await exportRecording(output, excel, options.python);
                printPanel('Record', resultLabel(0, 'Excel case saved'), [
                    ['EXCEL', [excel]],
                    ['PLAYWRIGHT SOURCE', [output]],
                    ['NEXT', [cmd(`replay FILE.xlsx --url ${safeUrl(converted.url)} --headless`)]],
                ]);
                return 0;
            } catch (error) {
                printPanel(
                    'Record',
                    resultLabel(1, 'Playwright case saved. Excel export did not complete.'),
                    [
                        ['CASE', [output]],
                        ['DETAIL', [safeText(error.message, 500)]],
                        ['RETRY', [cmd('export-excel FILE.spec.cjs')]],
                    ],
                );
                return 1;
            }
        }
        const hasAssertion = /^\s*await expect\(/m.test(spec);
        printPanel('Record', resultLabel(0, 'Case saved'), [
            ['CASE', [output]],
            [
                'NEXT',
                [
                    hasAssertion
                        ? `Run the saved case with ${cmd('replay FILE')}.`
                        : `Add an assertion to validate the result, then run ${cmd('replay FILE')}.`,
                ],
            ],
        ]);
        return 0;
    });
}

async function replay(root, input, options) {
    if (!input.endsWith('.spec.cjs')) throw Error('请选择录制生成的 .spec.cjs 用例');
    const spec = await fs.realpath(input);
    if (!(await fs.stat(spec)).isFile()) throw Error('用例必须是文件');
    // Match the runner with the Playwright instance that the saved CommonJS spec will load.
    try {
        root = path.dirname(createRequire(spec).resolve('playwright/package.json'));
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    if (options.headed && options.headless) throw Error('--headed 和 --headless 不能同时使用');
    const out = path.resolve(
        options.out ?? uniqueRunDirectory(path.join(process.cwd(), 'runs', 'laya-pilot')),
    );
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.mkdir(out);
    return withTempDirectory(async (directory) => {
        const config = path.join(directory, 'playwright.config.cjs');
        const settings = {
            testDir: path.dirname(spec),
            respectGitIgnore: false,
            // Same layout as Excel runs: per-test evidence under cases/.
            outputDir: path.join(out, 'cases'),
            workers: 1,
            retries: 0,
            updateSnapshots: 'none',
            use: {
                headless: !options.headed,
                screenshot: 'only-on-failure',
                trace: 'retain-on-failure',
            },
            reporter: [
                ['list'],
                ['html', { open: 'never', outputFolder: path.join(out, 'playwright-report') }],
                ['json', { outputFile: path.join(out, RUN_FILES.results) }],
            ],
        };
        const match = `^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
        await fs.writeFile(
            config,
            `module.exports = ${JSON.stringify(settings)};\nmodule.exports.testMatch = new RegExp(${JSON.stringify(match)});\n`,
        );
        const env = {
            ...process.env,
            NODE_PATH: [path.dirname(root), process.env.NODE_PATH]
                .filter(Boolean)
                .join(path.delimiter),
        };
        printPanel(
            'Replay',
            `Running ${path.basename(spec)} in ${options.headed ? 'a visible browser' : 'headless mode'}.`,
        );
        const code = await runPlaywright(root, ['test', '--config', config], process.cwd(), env);
        const result = await fs
            .readFile(path.join(out, RUN_FILES.results), 'utf8')
            .catch((error) => {
                if (error.code !== 'ENOENT') throw error;
                return null;
            });
        const stats = result ? JSON.parse(result).stats : null;
        if (result) await finalizeRun(out).catch(() => {});
        const hasResults =
            stats && stats.expected + stats.unexpected + stats.skipped + stats.flaky > 0;
        const summary =
            hasResults &&
            `${stats.expected} passed · ${stats.unexpected} failed · ${stats.skipped} skipped${stats.flaky ? ` · ${stats.flaky} flaky` : ''}`;
        printPanel('Replay', resultLabel(code, code === 0 ? 'Run complete' : 'Run did not pass'), [
            ...(summary ? [['RESULT', [summary]]] : []),
            ['RUN DIRECTORY', [out]],
            ...(stats
                ? [['REPORT', [path.join(out, RUN_FILES.index), cmd('report RUN_DIR')]]]
                : []),
        ]);
        return code;
    });
}

async function openReport(input) {
    const index = path.resolve(input, RUN_FILES.index);
    try {
        await fs.access(index);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw Error(`No report found. Pass a run directory that contains ${RUN_FILES.index}.`);
    }
    printPanel('Report', 'Opening the report.', [['FILE', [index]]]);
    const opener =
        process.platform === 'darwin'
            ? ['open', [index]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', '', index]]
              : ['xdg-open', [index]];
    return new Promise((resolve) => {
        const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
        child.once('error', () => resolve(0)); // No desktop opener: the path above is enough.
        child.once('spawn', () => {
            child.unref();
            resolve(0);
        });
    });
}

export async function runRecordingCommand(command, args) {
    const recording = command === 'record';
    const reporting = command === 'report';
    const exporting = command === 'export-excel';
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            ...(!reporting && { out: { type: 'string' } }),
            ...(recording && {
                'browser-channel': { type: 'string' },
                'storage-state': { type: 'string' },
                'code-only': { type: 'boolean' },
                'excel-out': { type: 'string' },
            }),
            ...((recording || exporting) && { python: { type: 'string' } }),
            ...(command === 'replay' && {
                headed: { type: 'boolean' },
                headless: { type: 'boolean' },
            }),
        },
    });
    const [usage, description, options] = recording
        ? [
              cmd('record URL'),
              'Turn browser actions and assertions into a test.',
              [
                  '--out FILE                Save to a new .spec.cjs file',
                  '--excel-out FILE          Choose the companion .xlsx output',
                  '--code-only               Save the Playwright file only',
                  '--browser-channel NAME   Use chrome, msedge or chromium',
                  '--storage-state FILE     Use a saved Playwright login',
              ],
          ]
        : reporting
          ? [cmd('report RUN_DIR'), 'Open index.html of a completed run.', []]
          : exporting
            ? [
                  cmd('export-excel CASE.spec.cjs'),
                  'Convert a saved recording to the Excel case template.',
                  [
                      '--out FILE      Save to a new .xlsx file',
                      '--python PATH   Use a Python environment with openpyxl',
                  ],
              ]
            : [
                  cmd('replay CASE.spec.cjs'),
                  'Run one case and save its report.',
                  [
                      '--headed     Show the browser while replaying',
                      '--headless   Run without a browser window (default)',
                      '--out DIR    Save to a new run directory',
                      `For Excel and Laya, use ${cmd('replay FILE.xlsx --url URL')}.`,
                  ],
              ];
    if (values.help) {
        printPanel(command[0].toUpperCase() + command.slice(1), description, [
            ['USAGE', [usage]],
            ...(options.length ? [['OPTIONS', options]] : []),
        ]);
        return 0;
    }
    if (positionals.length !== 1) throw Error(`用法：${usage}`);
    if (exporting) {
        const source = path.resolve(positionals[0]);
        if (!source.endsWith('.spec.cjs')) throw Error('请选择录制生成的 .spec.cjs 用例。');
        const output = path.resolve(values.out ?? source.replace(/\.spec\.cjs$/, '.xlsx'));
        if (!output.toLowerCase().endsWith('.xlsx')) throw Error('Excel 输出文件须以 .xlsx 结尾。');
        const { exportRecording } = await import('./recorded-excel.mjs');
        const testCase = await exportRecording(source, output, values.python);
        printPanel('Export', resultLabel(0, 'Excel case saved'), [
            ['EXCEL', [output]],
            ['NEXT', [cmd(`replay FILE.xlsx --url ${safeUrl(testCase.url)} --headless`)]],
        ]);
        return 0;
    }
    const root = path.dirname(require.resolve('playwright/package.json'));
    if (recording) return record(root, positionals[0], values);
    if (reporting) return openReport(positionals[0]);
    return replay(root, positionals[0], values);
}
