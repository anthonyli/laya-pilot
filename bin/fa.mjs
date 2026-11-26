#!/usr/bin/env node
// npm entry for the `fa` command. Configuration, the Python environment and
// local models live in ~/.falcon (or LAYA_HOME) instead of the installed package.
process.env.LAYA_ENTRY = 'cli';
await import('../scripts/run.mjs');
