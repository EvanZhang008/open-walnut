#!/usr/bin/env node
// Route the agent hot path (`walnut tools ...`, `walnut --version`) to the
// slim dist/cli-fast.js entry (~0.1s boot: op registry + fetch only). The full
// dist/cli.js is a single unsplit bundle that eagerly loads the web-server
// graph (~0.5s boot) — fine for human commands, waste for a tools call an
// agent runs in a loop. Fall back to the full CLI for everything else.
const args = process.argv.slice(2);
const nonFlag = args.find((a) => !a.startsWith('-'));
const fast = nonFlag === 'tools' || (!nonFlag && (args.includes('--version') || args.includes('-V')));
import(fast ? '../dist/cli-fast.js' : '../dist/cli.js');
