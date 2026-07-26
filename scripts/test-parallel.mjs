import { spawn } from 'node:child_process';
import os from 'node:os';

const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const runs = [
  {
    name: 'unit',
    args: ['vitest', 'run', '--config', 'vitest.unit.config.ts'],
  },
  {
    name: 'integration',
    args: ['vitest', 'run', '--config', 'vitest.integration.config.ts'],
  },
  {
    name: 'e2e',
    args: ['vitest', 'run', '--config', 'vitest.e2e.config.ts'],
  },
  {
    // FRONTEND diff pipeline (react-diff-view/diff) — deps live in web/node_modules,
    // so it runs under a web-rooted config. Guards the session "Changed" view's
    // createPatch→parseDiff→tokenize path (a parse throw here blanks the page).
    name: 'diff-view',
    args: ['vitest', 'run', '--config', 'vitest.diff-view.config.ts'],
  },
  {
    // FRONTEND WorkflowGraph layout logic (buildLayout/phaseCounts) — pure data
    // transforms behind the dynamic-workflow flow-graph panel. Runs under a
    // repo-root-rooted config that aliases @ → web/src (no DOM needed).
    name: 'workflow-graph',
    args: ['vitest', 'run', '--config', 'vitest.workflow-graph.config.ts'],
  },
  {
    // FRONTEND markdown utils (marked/dompurify in web/node_modules) — backs the
    // per-message copy-as-markdown / copy-as-rich-text buttons and message render.
    // linkedom-backed window so DOMPurify initializes.
    name: 'markdown',
    args: ['vitest', 'run', '--config', 'vitest.markdown.config.ts'],
  },
];

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
    const args = maxWorkers
      ? [...entry.args, '--maxWorkers', String(maxWorkers), ...extraArgs]
      : [...entry.args, ...extraArgs];

    console.log(`\n▶ [${entry.name}] npx ${args.join(' ')}\n`);

    const child = spawn(npm, args, {
      stdio: 'inherit',
      // WALNUT_TEST_RUN_ID: all 6 tiers of this invocation share ONE slot in
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
    ? ['vitest', 'run', '--maxWorkers', String(maxWorkers), ...passthroughArgs]
    : ['vitest', 'run', ...passthroughArgs];

  const code = await new Promise((resolve) => {
    const child = spawn(npm, args, {
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
