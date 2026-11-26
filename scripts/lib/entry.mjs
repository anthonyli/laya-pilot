import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The same execution code is shipped as an AI skill (scripts/run.mjs) and as the
// `fa` npm command (bin/fa.mjs). The entry decides two things only: where
// user state lives and how commands are spelled in help and hints.
export const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const isCli = process.env.LAYA_ENTRY === 'cli';

// Skill: state stays beside SKILL.md. CLI: state survives npm upgrades in the home directory.
export const dataRoot = isCli
    ? path.resolve(process.env.LAYA_HOME || path.join(os.homedir(), '.falcon'))
    : codeRoot;

export const venvPython = path.join(
    dataRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
);

const skillCommands = {
    setup: 'node scripts/setup.mjs',
    check: 'node scripts/setup.mjs --check',
    run: 'node scripts/run.mjs',
};

/** Spell a subcommand for the current entry, e.g. cmd('record URL'). */
export function cmd(command = '') {
    if (isCli) return command ? `fa ${command}` : 'fa';
    const [name, ...rest] = command.split(' ');
    const base = skillCommands[name];
    if (base) return [base, ...rest].join(' ');
    return command ? `node scripts/run.mjs ${command}` : 'node scripts/run.mjs';
}
