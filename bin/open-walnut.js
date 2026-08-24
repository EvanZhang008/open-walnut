#!/usr/bin/env node
// One interface, one rule: DATA commands (one HTTP request to the local
// server) run the slim dist/cli-fast.js entry (~0.1s boot); process-owning
// commands (web, mcp, chat, ...) run the full dist/cli.js (~0.5s boot is
// irrelevant when the process lives for seconds-to-forever). Humans and
// agents share the same path — the split is by what the command does.
//
// LITE list mirrors LITE_COMMANDS in src/cli-fast.ts — keep in sync.
// WALNUT_CLI_DIRECT=1 always takes the full CLI: the in-process legacy
// runners live only in that bundle (see src/commands/direct-registry.ts).
// `walnut guide | head` closes the pipe early: EPIPE on stdout is the reader
// saying "enough", not an error — exit clean instead of an uncaught stack.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });
const LITE = new Set(['tools', 'add', 'tasks', 'done', 'recall', 'projects', 'sessions', 'start', 'guide', 'peers']);
const args = process.argv.slice(2);
const sub = args.find((a) => !a.startsWith('-'));
const fast = process.env.WALNUT_CLI_DIRECT !== '1'
  && ((sub !== undefined && LITE.has(sub))
    || (!sub && (args.includes('--version') || args.includes('-V'))));
import(fast ? '../dist/cli-fast.js' : '../dist/cli.js');
