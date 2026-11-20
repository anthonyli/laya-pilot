#!/usr/bin/env node
// npm entry for the `laya` command. Configuration, the Python environment and
// local models live in ~/.laya (or LAYA_HOME) instead of the installed package.
process.env.LAYA_ENTRY = 'cli';
await import('../scripts/run.mjs');
