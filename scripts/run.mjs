import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeText } from './lib/diagnostics.mjs';
import { printHome, printRunHelp } from './lib/cli-output.mjs';
import { uniqueRunDirectory } from './lib/run-layout.mjs';
import {
    cmd,
    isCli,
    option,
    requireNode,
    skillRoot,
    resolveSkillSettings,
    skillVersion,
} from './common.mjs';

async function main() {
    requireNode();
    let args = process.argv.slice(2);
    if (args[0] === 'help') {
        if (args.length > 2) throw Error(`Usage: ${cmd('help [COMMAND]')}`);
        args = args.length === 2 ? [args[1], '--help'] : [];
    }
    if (args[0] === 'replay' && args[1]?.toLowerCase().endsWith('.xlsx')) {
        args = ['--excel', args[1], ...args.slice(2)];
    }
    if (['record', 'replay', 'report', 'export-excel'].includes(args[0])) {
        const { runRecordingCommand } = await import('./lib/recording.mjs');
        process.exitCode = await runRecordingCommand(args[0], args.slice(1));
        return;
    }
    if (args[0] === 'setup' || args[0] === 'check') {
        startScript(
            'setup.mjs',
            args[0] === 'check' ? ['--check', ...args.slice(1)] : args.slice(1),
        );
        return;
    }
    const explicitRun = args[0] === 'run';
    if (explicitRun) args.shift();
    if (args[0] === 'version' || args.includes('--version')) {
        const { version, contentHash } = skillVersion();
        console.log(JSON.stringify({ version, contentHash }));
        return;
    }
    if (args[0] && !args[0].startsWith('-'))
        throw Error(`Unknown command: ${args[0]}. See ${cmd('--help')}.`);
    if (!args.length || args.includes('--help') || args.includes('-h')) {
        // The skill's primary job is Excel regression, so its help opens with that workflow.
        const home = isCli && !explicitRun && args.every((arg) => arg === '--help' || arg === '-h');
        if (home) printHome(skillVersion().version);
        else printRunHelp(skillVersion().version);
        return;
    }
    if (option(args, '--mode') === 'plan') {
        const { createReviewPlan } = await import('./lib/review-plan.mjs');
        await createReviewPlan(args);
        return;
    }
    if (args.includes('--plan-source')) throw Error('--plan-source 需要 --mode plan');
    const { settings, summary } = await resolveSkillSettings(args);
    // A local model is an explicit per-run choice. Inherited environment/config cannot opt in.
    const provider = option(args, '--provider') || 'api';
    if (!['api', 'local'].includes(provider)) throw Error('--provider must be api or local');
    if (!args.includes('--provider')) args.push('--provider', provider);
    if (!args.includes('--python')) {
        const python = settings.python;
        if (python) args.push('--python', python);
        else throw Error(`Run ${cmd('setup')} first, or supply --python.`);
    }
    if (provider === 'local' && !args.includes('--model')) args.push('--model', settings.model);
    if (provider === 'api') {
        if (settings.apiBase && !args.includes('--api-base'))
            args.push('--api-base', settings.apiBase);
        if (!args.includes('--api-model')) args.push('--api-model', settings.apiModel);
    }
    {
        const out = uniqueRunDirectory(path.join(process.cwd(), 'runs', 'laya-pilot'));
        const id = path.basename(out);
        if (!args.includes('--out') && !process.env.TEST_OUTPUT) args.push('--out', out);
        if (
            option(args, '--mode') === 'generate' &&
            !args.includes('--case-file') &&
            !process.env.TEST_CASE_FILE
        )
            args.push(
                '--case-file',
                path.join(process.cwd(), 'generated-cases', `laya-pilot-${id}.xlsx`),
            );
    }
    console.log('CONFIG ' + JSON.stringify(summary));
    startScript('runner.mjs', args);
}

function startScript(script, args) {
    const child = spawn(process.execPath, [path.join(skillRoot, 'scripts', script), ...args], {
        stdio: 'inherit',
    });
    const signals = ['SIGINT', 'SIGTERM'];
    const handlers = signals.map((signal) => {
        const handler = () => child.kill(signal);
        process.on(signal, handler);
        return [signal, handler];
    });
    child.once('error', (error) => {
        console.error(safeText(error.message, 1200));
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        for (const [name, handler] of handlers) process.off(name, handler);
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
    });
}

main().catch((error) => {
    console.error(safeText(error.message, 1200));
    process.exitCode = 1;
});
