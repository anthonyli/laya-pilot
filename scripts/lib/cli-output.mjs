import { cmd, isCli } from './entry.mjs';

const color = process.stdout.isTTY && process.stdout.hasColors?.() && !('NO_COLOR' in process.env);

function paint(code, value) {
    return color ? `\x1b[${code}m${value}\x1b[0m` : value;
}

export const accent = (value) => paint('1;36', value);
export const muted = (value) => paint('2', value);
export const resultLabel = (code, value) => paint(code === 0 ? '1;32' : '1;31', value);

export function printPanel(title, description, sections = []) {
    console.log(`\n  ${accent('LayaPilot')}  ${muted(title)}\n  ${description}`);
    for (const [heading, lines] of sections) {
        console.log(`\n  ${accent(heading)}`);
        for (const line of lines) console.log(`    ${line}`);
    }
    console.log();
}

/** Align "command  description" rows for the current entry's command spelling. */
function rows(entries, highlight = false) {
    const commands = entries.map(([command]) => cmd(command));
    const width = Math.max(...commands.map((command) => command.length)) + 2;
    return entries.map(([, description], index) => {
        const command = commands[index];
        return `${highlight ? accent(command) : command}${' '.repeat(width - command.length)}${description}`;
    });
}

const recordingRows = [
    ['setup --recording', 'Install the test browser'],
    ['record URL', 'Save your actions as a test'],
    ['replay FILE', 'Run a saved test'],
    ['report', 'Open the latest HTML report'],
];

export function printHome(version) {
    printPanel(`v${version}`, 'Record a browser flow, replay it, and read the result.', [
        ['GET STARTED', rows(recordingRows, true)],
        [
            'EXCEL & OPTIONS',
            rows([
                ['run --help', 'Excel and AI workflows'],
                ['help COMMAND', 'Options for a command'],
            ]),
        ],
    ]);
}

export function printRunHelp(version) {
    printPanel(
        version ? `v${version}` : 'Run',
        'Run Excel and AI workflows. API model by default.',
        [
            [
                'EXCEL',
                [
                    cmd('run --excel FILE --url URL --headless'),
                    cmd('run --excel FILE --inspect'),
                    cmd('run --mode generate --url URL --read-only'),
                    cmd('run --mode plan --plan-source CASES.json'),
                    cmd('run --mode reviewed --review-plan PLAN.json --approved-hash SHA256'),
                ],
            ],
            [
                'OPTIONS',
                [
                    '--out DIR               Save results to a new directory',
                    '--provider local        Use the installed local model',
                    '--manual-login         Sign in in a visible browser',
                    '--ui-adapter FILE      Load project UI selectors for Excel replay',
                    '--module-routes FILE   Load fallback menu URLs from moduleRoutes in JSON',
                    '--allow-write          Allow authorized write operations',
                    '--replay-menus         Verify menu clicks even when a business entry URL is available',
                ],
            ],
            ['RECORDING', rows(recordingRows)],
            [
                'SETUP & DOCS',
                [
                    `${cmd('setup')} · ${cmd('check')}`,
                    isCli
                        ? 'README: https://github.com/anthonyli/laya-pilot#readme'
                        : 'references/setup.md · references/workflows.md · references/recording.md',
                ],
            ],
        ],
    );
}
