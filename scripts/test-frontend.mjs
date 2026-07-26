#!/usr/bin/env node
/**
 * The four FRONTEND-rooted vitest configs, run to completion.
 *
 * These suites can't run under a repo-root config: their deps (@tiptap/*,
 * dompurify, react-diff-view, marked) live in web/node_modules, and they need a
 * linkedom DOM shim. So each has its own web-rooted config, and this script is
 * the single entry point that runs all four — `npm run test:frontend:ci`.
 *
 * Runs them SEQUENTIALLY but does NOT stop at the first failure. This replaced an
 * `&&` chain in package.json: with `&&`, a break in the first config hid the state
 * of the other three, so the fix loop was one config per run. Since this leg is a
 * BLOCKING gate in CI, seeing every failure in one run matters.
 *
 * Sequential, not parallel: four concurrent vitest processes would each claim the
 * worker budget (tests/setup/worker-budget.ts). These suites total ~10s, so there
 * is nothing to gain and a machine to protect.
 */
import { spawnSync } from 'node:child_process';

const CONFIGS = [
  'vitest.diff-view.config.ts',
  'vitest.markdown.config.ts',
  'vitest.workflow-graph.config.ts',
  'vitest.notes-roundtrip.config.ts',
];

// One shared gate slot for all four (see tests/setup/test-gate.ts) — otherwise
// each registers as a separate concurrent run and they queue behind each other.
const env = { ...process.env, WALNUT_TEST_RUN_ID: process.env.WALNUT_TEST_RUN_ID ?? `tf-${process.pid}` };

const results = [];
for (const config of CONFIGS) {
  console.log(`\n▶ ${config}\n`);
  const r = spawnSync('npx', ['vitest', 'run', '--config', config], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  results.push({ config, code: r.status ?? 1 });
}

console.log(`\n${'─'.repeat(60)}`);
for (const { config, code } of results) {
  console.log(`${code === 0 ? '✓' : '✗'} ${config}${code === 0 ? '' : `  (exit ${code})`}`);
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.log(`\n${failed.length} of ${CONFIGS.length} frontend config(s) failed.`);
  process.exit(failed[0].code);
}
console.log(`\nAll ${CONFIGS.length} frontend configs passed.`);
