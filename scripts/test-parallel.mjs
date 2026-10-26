import { spawn } from 'node:child_process';
import { bunExecutable, vitestCommand, vitestCommandLine } from './bun-vitest.mjs';

// `bun run test`: the same set CI runs, one tier after another. quick + slow are
// the whole non-e2e suite (tests/setup/quick-tier.test.ts asserts every test file
// lands in exactly one tier); the frontend entry is the script that runs all four
// web-rooted configs, so this list cannot drift from CI's.
// Until 2026-10-24 this ran unit + integration + e2e + three of the four frontend
// configs, which missed 201 files CI runs (tests/scripts, lib, replica, setup,
// integration and more) and vitest.notes-roundtrip.config.ts.
const runs = [
  { name: 'quick', args: ['run', '--config', 'vitest.quick.config.ts'] },
  { name: 'slow', args: ['run', '--config', 'vitest.slow.config.ts'] },
  { name: 'e2e', args: ['run', '--config', 'vitest.e2e.config.ts'] },
  // diff-view, markdown, workflow-graph and notes-roundtrip, run to completion.
  { name: 'frontend', script: 'scripts/test-frontend.mjs' },
];

// --list prints the tiers as JSON and runs nothing (tests/scripts/test-parallel.test.ts).
if (process.argv[2] === '--list') {
  console.log(JSON.stringify(runs));
  process.exit(0);
}

const children = new Set();
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const passthroughArgs = process.argv.slice(2);
// One id per invocation of this script — all child tiers share a single slot
// in the machine-wide vitest gate (tests/setup/test-gate.ts).
const testRunId = process.env.WALNUT_TEST_RUN_ID ?? `tp-${process.pid}`;
// Worker count comes from the single machine-wide budget (tests/setup/worker-budget.ts)
// via each tier's vitest config — we deliberately pass NO --maxWorkers flag, so
// there is exactly one place that decides it. CI keeps the config default too.
const maxWorkers = null;

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    const args = entry.script ? [entry.script] : maxWorkers
      ? [...entry.args, '--maxWorkers', String(maxWorkers), ...extraArgs]
      : [...entry.args, ...extraArgs];

    console.log(`\n▶ [${entry.name}] ${entry.script ? `bun ${entry.script}` : vitestCommandLine(args)}\n`);

    const vitest = entry.script ? { cmd: bunExecutable(), args } : vitestCommand(args);
    const child = spawn(vitest.cmd, vitest.args, {
      stdio: 'inherit',
      // WALNUT_TEST_RUN_ID: all tiers of this invocation share ONE slot in
      // the machine-wide vitest gate (tests/setup/test-gate.ts) — without it,
      // each tier would count as a separate concurrent run and self-deadlock.
      env: { ...process.env, VITEST_GROUP: entry.name, WALNUT_TEST_RUN_ID: testRunId },
      shell: process.platform === 'win32',
    });
    children.add(child);
    child.on('exit', (code, signal) => {
      children.delete(child);
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode === 0) {
        console.log(`\n✓ [${entry.name}] passed\n`);
      } else {
        console.log(`\n✗ [${entry.name}] failed (exit ${exitCode})\n`);
      }
      resolve(exitCode);
    });
  });

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If passthrough args given, run a single vitest with those args
if (passthroughArgs.length > 0) {
  const args = maxWorkers
    ? ['run', '--maxWorkers', String(maxWorkers), ...passthroughArgs]
    : ['run', ...passthroughArgs];

  const code = await new Promise((resolve) => {
    const vitest = vitestCommand(args);
    const child = spawn(vitest.cmd, vitest.args, {
      stdio: 'inherit',
      env: { ...process.env, WALNUT_TEST_RUN_ID: testRunId },
      shell: process.platform === 'win32',
    });
    children.add(child);
    child.on('exit', (exitCode, signal) => {
      children.delete(child);
      resolve(exitCode ?? (signal ? 1 : 0));
    });
  });
  process.exit(Number(code) || 0);
}

// Run tiers SEQUENTIALLY, one at a time.
//
// This used to be `Promise.all(...)` — 6 tiers at once, each with its own worker
// pool. That multiplied the per-tier worker cap by 6 and is what hard-crashed the
// Mac on 2026-07-25 (screen flashing → reboot): a `maxWorkers: 4` config actually
// permitted 24 fork workers, each allowed a 2GB heap, on top of ~3GB of security
// agents, the prod server, simulators and browsers. Sequential means the machine
// only ever sees ONE tier's workers — the budget in tests/setup/worker-budget.ts
// becomes an absolute bound instead of a per-tier hint.
//
// Cost: wall-clock. Benefit: the suite can never take the machine down. Keep it.
// (CI is exempt from the low budget, not from sequencing — isolated runners have
// the RAM, and sequential output is far easier to read in a log.)
const codes = [];
for (const entry of runs) {
  codes.push(await runOnce(entry));
}
const failed = codes.find((code) => code !== 0);

if (failed !== undefined) {
  process.exit(failed);
}

process.exit(0);
