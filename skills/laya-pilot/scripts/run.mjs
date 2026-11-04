import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeText } from '../runtime/lib/diagnostics.mjs';
import { option, requireNode, runtimeRoot, resolveSkillSettings, skillVersion } from './common.mjs';

async function main() {
    requireNode();
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
        const { version, contentHash } = skillVersion();
        console.log(JSON.stringify({ version, contentHash }));
        return;
    }
    if (args.includes('--help')) {
        console.log(`LayaPilot standalone skill — API model by default
Setup: node scripts/setup.mjs [--python PATH] [--skip-browser]
Check: node scripts/setup.mjs --check
Regression: node scripts/run.mjs --excel FILE.xlsx --url URL --headless
Inspect: node scripts/run.mjs --excel FILE.xlsx --inspect
Configured regression: node scripts/run.mjs --headless (excel and url in config.local.json)
Excel defaults to all imported cases, regardless of historical result or case type.
Optional generation: node scripts/run.mjs --mode generate --url URL [--case-file FILE.xlsx]
Excel auto-detects ordinary cases or generated structured plans; no extra execution mode is needed.
Legacy compatibility: --mode execute --case-file FILE.xlsx [--url URL]
Reports default to the current working directory under runs/laya-pilot/.
API settings: LAYA_API_BASE, LAYA_API_MODEL, LAYA_API_KEY in the environment or skill .env.local.
Configuration: skill config.local.json loads automatically; --config FILE overrides it.
--provider local explicitly opts into local inference; setup.mjs --local-model installs and downloads weights.
Options: --config FILE, --python PATH, --headless, --manual-login, --out DIR,
--auth-state FILE --auth-check CSS, --read-only, --operations LIST,
--data FILE, --template-excel FILE, --allow-write (authorized writes for either Excel format).
See references/setup.md and references/workflows.md for details.`);
        return;
    }
    const { configPath, fileConfig, settings, summary } = await resolveSkillSettings(args);
    if (!args.includes('--config') && configPath) args.push('--config', configPath);
    // A local model is an explicit per-run choice. Inherited environment/config cannot opt in.
    const provider = option(args, '--provider') || 'api';
    if (!['api', 'local'].includes(provider)) throw Error('--provider must be api or local');
    if (!args.includes('--provider')) args.push('--provider', provider);
    if (!args.includes('--python')) {
        const python = settings.python;
        if (python) args.push('--python', python);
        else throw Error('Run node scripts/setup.mjs first, or supply --python.');
    }
    if (provider === 'local' && !args.includes('--model')) args.push('--model', settings.model);
    if (provider === 'api') {
        if (settings.apiBase && !args.includes('--api-base'))
            args.push('--api-base', settings.apiBase);
        if (!args.includes('--api-model')) args.push('--api-model', settings.apiModel);
    }
    {
        const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
        if (!args.includes('--out') && !process.env.TEST_OUTPUT && !fileConfig.out)
            args.push('--out', path.join(process.cwd(), 'runs', 'laya-pilot', id));
        if (
            option(args, '--mode') === 'generate' &&
            !args.includes('--case-file') &&
            !process.env.TEST_CASE_FILE &&
            !fileConfig.caseFile
        )
            args.push(
                '--case-file',
                path.join(process.cwd(), 'generated-cases', `laya-pilot-${id}.xlsx`),
            );
    }
    console.log('CONFIG ' + JSON.stringify(summary));
    const child = spawn(process.execPath, [path.join(runtimeRoot, 'runner.mjs'), ...args], {
        stdio: 'inherit',
        env: process.env,
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
