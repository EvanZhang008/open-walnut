#!/usr/bin/env node
/**
 * Baseline-aware test gate — how a tier with pre-existing failures can still
 * catch REGRESSIONS.
 *
 * The problem: the quick tier has 118 failures on main (measured 2026-07-25 in a
 * clean clone: stale test imports of exports deleted in 2026-05, tests needing a
 * real `claude` CLI, contract drift). A pass/fail gate on that is useless — always
 * red. But "ignore the tier" throws away the signal that matters: did YOUR change
 * break something that used to pass?
 *
 * So compare against a recorded baseline instead of against zero:
 *
 *   node scripts/test-baseline.mjs record        # snapshot today's failures
 *   node scripts/test-baseline.mjs check         # fail ONLY on new failures
 *
 * `check` exits non-zero if a test that is NOT in the baseline fails. Tests that
 * were already failing stay quiet; tests that get FIXED are reported as progress
 * and should be re-recorded (a shrinking baseline is the point).
 *
 * The baseline file is committed, so it is reviewable: a PR that adds entries is
 * visibly making things worse, which is much harder to miss than a red X.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = process.env.WALNUT_BASELINE_CONFIG ?? 'vitest.quick.config.ts';
const BASELINE = process.env.WALNUT_BASELINE_FILE ?? 'tests/setup/known-failures.json';
const mode = process.argv[2] ?? 'check';

if (!['record', 'check'].includes(mode)) {
  console.error('usage: node scripts/test-baseline.mjs [record|check]');
  process.exit(2);
}

const reportFile = path.join(process.env.TMPDIR ?? '/tmp', `walnut-baseline-${process.pid}.json`);

console.log(`Running ${CONFIG} …`);
const run = spawnSync(
  'npx',
  ['vitest', 'run', '--config', CONFIG, '--reporter=json', `--outputFile=${reportFile}`],
  { stdio: ['inherit', 'ignore', 'inherit'], env: process.env },
);

if (!fs.existsSync(reportFile)) {
  console.error(`No JSON report produced (vitest exited ${run.status}) — cannot evaluate the baseline.`);
  process.exit(1);
}

/** Stable key for one test: file path + full test name. Survives reordering. */
const failures = new Set();
const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
for (const file of report.testResults ?? []) {
  const rel = file.name.replace(/^.*?(tests\/.*)$/, '$1');
  for (const a of file.assertionResults ?? []) {
    if (a.status === 'failed') failures.add(`${rel} :: ${a.fullName}`);
  }
}
const filesRun = (report.testResults ?? []).length;
const testsRun = report.numTotalTests ?? 0;
fs.rmSync(reportFile, { force: true });

// A config that matches nothing, a collection error, or a crashed worker pool all
// produce a valid-but-empty report — which would otherwise read as "no new
// failures" and pass the gate while testing NOTHING. Refuse that outcome.
const MIN_FILES = Number(process.env.WALNUT_BASELINE_MIN_FILES ?? 200);
if (filesRun < MIN_FILES) {
  console.error(
    `\nOnly ${filesRun} test file(s) ran (${testsRun} tests) — expected at least ${MIN_FILES}.\n` +
      'Refusing to report a verdict: an empty or truncated run must never look like a pass.\n' +
      `vitest exited ${run.status}. Check for a collection error above, or lower ` +
      'WALNUT_BASELINE_MIN_FILES if the tier legitimately shrank.',
  );
  process.exit(1);
}

if (mode === 'record') {
  const sorted = [...failures].sort();
  fs.writeFileSync(
    BASELINE,
    `${JSON.stringify({ config: CONFIG, count: sorted.length, failures: sorted }, null, 2)}\n`,
  );
  console.log(`\nRecorded ${sorted.length} known failures → ${BASELINE}`);
  console.log('Commit this file. Shrinking it over time is the goal.');
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`\nNo baseline at ${BASELINE}. Create one with:\n  node scripts/test-baseline.mjs record`);
  process.exit(1);
}

const known = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).failures ?? []);
const regressions = [...failures].filter((f) => !known.has(f)).sort();
const fixed = [...known].filter((f) => !failures.has(f)).sort();

console.log(`\n${'─'.repeat(60)}`);
console.log(`failing now: ${failures.size}   known baseline: ${known.size}`);

if (fixed.length) {
  console.log(`\n✓ ${fixed.length} test(s) in the baseline now PASS — re-record to lock the improvement in:`);
  fixed.slice(0, 15).forEach((f) => console.log(`    ${f}`));
  if (fixed.length > 15) console.log(`    … and ${fixed.length - 15} more`);
}

if (regressions.length === 0) {
  console.log('\n✓ No new failures. (Pre-existing baseline failures ignored by design.)');
  process.exit(0);
}

console.log(`\n✗ ${regressions.length} NEW failure(s) — not in the baseline, so this change caused them:\n`);
regressions.forEach((f) => console.log(`    ${f}`));
console.log('\nFix them, or if they are genuinely pre-existing, re-record the baseline and explain why.');
process.exit(1);
