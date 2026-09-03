#!/usr/bin/env node
import fs from 'node:fs';
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
// Exit 0 ONLY when the pipe closed before we wrote anything; once bytes are out,
// a broken pipe means the reader got a TRUNCATED answer, and reporting that as
// success is how a half-written JSON reply passes for a complete one. 141 is the
// shell's SIGPIPE convention.
// Node version: npm only WARNS about an unmet `engines`, so an old Node installs the
// package happily and then dies inside the bundle with a syntax error that says nothing
// about versions. Answer the real question here, once, with the command that fixes it.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
  process.stderr.write(
    `Walnut needs Node.js 22 or newer, and this is Node ${process.versions.node}.\n\n` +
    `  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n` +
    `  nvm install 22\n\n` +
    `Then run the same command again.\n`,
    () => process.exit(1),
  );
}

let wroteStdout = false;
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(wroteStdout ? 141 : 0);
});
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (...writeArgs) => { wroteStdout = true; return originalWrite(...writeArgs); };
const LITE = new Set(['tools', 'add', 'tasks', 'done', 'recall', 'projects', 'sessions', 'start', 'guide', 'peers']);
const args = process.argv.slice(2);
const sub = args.find((a) => !a.startsWith('-'));
const fast = process.env.WALNUT_CLI_DIRECT !== '1'
  && ((sub !== undefined && LITE.has(sub))
    || (!sub && (args.includes('--version') || args.includes('-V'))));
// The import is the whole program, so its failure must be LOUD. Unhandled, a
// bundle that is momentarily empty (dist rewritten by a concurrent build) made
// the CLI exit 0 having printed nothing at all — a caller in a loop reads that as
// "the command answered, with nothing", which is the worst possible answer.
// A zero-byte bundle is the mid-build window: it imports FINE (an empty module is
// valid JS) and simply does nothing, so it must be caught before the import. A
// half-written bundle throws instead and lands in the rejection handler. Export
// count is deliberately NOT the test — dist/cli.js legitimately exports nothing.
const entry = fast ? '../dist/cli-fast.js' : '../dist/cli.js';
const entryPath = new URL(entry, import.meta.url);
try {
  const { size } = fs.statSync(entryPath);
  if (size === 0) {
    process.stderr.write(`walnut: ${entry} is empty (build in progress?) — retry\n`);
    process.exit(70);
  }
} catch (err) {
  process.stderr.write(`walnut: cannot read ${entry}: ${err && err.message ? err.message : err}\n`);
  process.exit(70);
}
import(entryPath.href).catch((err) => {
  process.stderr.write(`walnut: cannot load ${entry}: ${err && err.message ? err.message : err}\n`);
  process.exit(70);
});
