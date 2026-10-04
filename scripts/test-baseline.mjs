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
 *   node scripts/test-baseline.mjs record [vitest options]  # snapshot today's failures
 *   node scripts/test-baseline.mjs check [vitest options]   # fail ONLY on new failures
 *
 * `check` exits non-zero if a test that is NOT in the baseline fails. Tests that
 * were already failing stay quiet; tests that get FIXED are reported as progress
 * and should be re-recorded (a shrinking baseline is the point).
 *
 * The baseline file is committed, so it is reviewable: a PR that adds entries is
 * visibly making things worse, which is much harder to miss than a red X.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = process.env.WALNUT_BASELINE_CONFIG ?? 'vitest.quick.config.ts';
const BASELINE = process.env.WALNUT_BASELINE_FILE ?? 'tests/setup/known-failures.json';
const mode = process.argv[2] ?? 'check';
const vitestArgs = process.argv.slice(3);

if (!['record', 'check'].includes(mode)) {
  console.error('usage: node scripts/test-baseline.mjs [record|check] [vitest options]');
  process.exit(2);
}

const TMP = process.env.TMPDIR ?? '/tmp';
const reportFile = path.join(TMP, `walnut-baseline-${process.pid}.json`);
/** One key per test file, the same for a reported file and a listed one. */
const fileKey = (abs) => abs.replace(/^.*?(tests\/.*)$/, '$1');

/**
 * The files this run must report, so a file that silently never ran fails the
 * gate instead of passing it. `vitest list` names the config's files (the
 * caller's filters apply; it ignores --shard), and a --shard i/n run gets the
 * slice vitest's BaseSequencer.shard cuts: files ordered by the sha1 of their
 * root-relative path, in ceil(total / n) slices.
 */
function expectedFiles() {
  const out = path.join(TMP, `walnut-baseline-list-${process.pid}.json`);
  const listed = spawnSync('npx', ['vitest', 'list', '--config', CONFIG, '--filesOnly', `--json=${out}`, ...vitestArgs], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
  });
  if (!fs.existsSync(out)) {
    console.error(`vitest could not list ${CONFIG} (exited ${listed.status}): a tier that cannot be listed cannot be judged.`);
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(out, 'utf-8')).map((e) => e.file);
  fs.rmSync(out, { force: true });
  const shardArg = vitestArgs.map((a, i) => (a.startsWith('--shard=') ? a.slice(8) : a === '--shard' ? vitestArgs[i + 1] : null)).find(Boolean);
  if (!shardArg) return { total: all.length, files: all.map(fileKey) };
  const [index, count] = shardArg.split('/').map(Number);
  const size = Math.ceil(all.length / count);
  const sha1 = (file) => createHash('sha1').update(`/${path.relative(process.cwd(), file).split(path.sep).join('/')}`).digest('hex');
  const files = all
    .map((file) => ({ file, hash: sha1(file) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .slice(size * (index - 1), size * index)
    .map(({ file }) => fileKey(file));
  return { total: all.length, files };
}

const expected = expectedFiles();
// The floor is for the whole tier (before any --shard): an include glob that
// broke matches far fewer files and every run would still report all of them.
// Measured 2026-10-02: the quick tier lists 1529 files.
const MIN_FILES = Number(process.env.WALNUT_BASELINE_MIN_FILES ?? 1400);
if (expected.total < MIN_FILES) {
  console.error(
    `\n${CONFIG} lists only ${expected.total} test file(s), expected at least ${MIN_FILES}.\n` +
      'Refusing to report a verdict: a tier that lost its files must never look like a pass.\n' +
      'Lower WALNUT_BASELINE_MIN_FILES if the tier legitimately shrank.',
  );
  process.exit(1);
}

console.log(`Running ${CONFIG}: ${expected.files.length} of its ${expected.total} test files …`);
const run = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--config',
    CONFIG,
    // Callers may narrow tests or workers, but the JSON report remains owned by
    // this gate so its verdict cannot be accidentally bypassed.
    ...vitestArgs,
    '--reporter=json',
    `--outputFile=${reportFile}`,
  ],
  { stdio: ['inherit', 'ignore', 'inherit'], env: process.env },
);

if (!fs.existsSync(reportFile)) {
  console.error(`No JSON report produced (vitest exited ${run.status}) — cannot evaluate the baseline.`);
  process.exit(1);
}

/** Stable key for one test: file path + full test name. Survives reordering. */
const failures = new Set();
// Why each one failed. The JSON reporter is the only output this gate keeps, so
// without this a CI regression is a bare test name and the cause has to be
// reproduced elsewhere (impossible for a Linux-only failure from a Mac).
const reasons = new Map();
// The message, then WHERE: the first stack frame in the repo's own code. A
// matcher's frames come first (node_modules/@vitest/expect), so the first lines
// alone read "expected [] to have a length of 1 | at Proxy.<anonymous>
// (…/node_modules/@vitest/expect/…)", and finding the failing line meant
// reproducing the run (2026-10-04, an e2e regression).
const REPO = `${process.cwd()}/`;
/** A stack line's location relative to the repo, or '' when it is not the repo's own code. */
const ownFrame = (line) => {
  const loc = /(?:\(|\s)(?:file:\/\/)?(\/[^()\s]+:\d+(?::\d+)?)\)?$/.exec(line)?.[1] ?? '';
  return loc.startsWith(REPO) && !loc.includes('/node_modules/') ? loc.slice(REPO.length) : '';
};
const firstLine = (msgs) => {
  const m = (Array.isArray(msgs) ? msgs : [msgs]).find((x) => typeof x === 'string' && x.trim());
  if (!m) return '';
  const lines = m.split('\n').map((l) => l.trim()).filter(Boolean);
  const isFrame = (l) => l.startsWith('at ');
  const own = lines.filter(isFrame).map(ownFrame).find(Boolean);
  if (!own) return lines.slice(0, 3).join(' | ').slice(0, 400);
  return `${lines.filter((l) => !isFrame(l)).slice(0, 2).join(' | ').slice(0, 340)} | at ${own}`;
};
const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
for (const file of report.testResults ?? []) {
  const rel = fileKey(file.name);
  const asserts = file.assertionResults ?? [];
  for (const a of asserts) {
    if (a.status !== 'failed') continue;
    const key = `${rel} :: ${a.fullName}`;
    failures.add(key);
    reasons.set(key, firstLine(a.failureMessages));
  }

  // A file that dies at IMPORT/COLLECTION time reports status:'failed' with an
  // EMPTY assertionResults array — verified: a bad import yields
  // numFailedTestSuites:1, numFailedTests:0, numTotalTests:0. Harvesting only
  // assertion results therefore made the single most likely regression class of
  // a refactor — a broken import, a top-level throw, a module-scope crash —
  // completely invisible: zero new keys, "no new failures", exit 0.
  //
  // Synthesize a per-file key so those DO surface and can be baselined.
  if (file.status === 'failed' && asserts.length === 0) {
    const key = `${rel} :: <file failed to load or collect>`;
    failures.add(key);
    reasons.set(key, firstLine(file.message));
  }
}
const filesInRun = new Set((report.testResults ?? []).map((file) => fileKey(file.name)));
const testsRun = report.numTotalTests ?? 0;
fs.rmSync(reportFile, { force: true });

// A collection error or a crashed worker pool can produce a valid report that
// is missing files, which would otherwise read as "no new failures" and pass
// while those files tested NOTHING. Every file this run covers must be in it.
// (A fixed floor did this job until it went stale: 290 against 1529 files on
// 2026-10-02, so four fifths of the tier could have vanished unnoticed.)
const expectedSet = new Set(expected.files);
const outside = [...filesInRun].filter((f) => !expectedSet.has(f));
// When this copy of vitest's shard cut disagrees with vitest (an upgrade
// changed it), the names are unknown and only the count can be checked.
const missing = outside.length ? [] : expected.files.filter((f) => !filesInRun.has(f));
const missingCount = outside.length ? Math.max(0, expected.files.length - filesInRun.size) : missing.length;
if (outside.length) {
  console.warn(`\n${outside.length} reported file(s) are outside the computed --shard slice; checking the count only.`);
}
if (missingCount) {
  console.error(
    `\n${missingCount} of the ${expected.files.length} test file(s) this run covers never reported (${testsRun} tests ran).\n` +
      'Refusing to report a verdict: an empty or truncated run must never look like a pass.\n' +
      `vitest exited ${run.status}. Check for a crashed worker or a collection error above.`,
  );
  missing.slice(0, 20).forEach((f) => console.error(`    ${f}`));
  if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`);
  process.exit(1);
}

/** This run's failures in the baseline format. The reasons ride along (check mode
 *  reads only `failures`): a recorded CI baseline is the one place a Linux-only
 *  failure's cause can be read from a Mac. */
function writeRun(file) {
  const sorted = [...failures].sort();
  const why = Object.fromEntries(sorted.map((k) => [k, reasons.get(k) ?? '']));
  fs.writeFileSync(
    file,
    `${JSON.stringify({ config: CONFIG, count: sorted.length, failures: sorted, reasons: why }, null, 2)}\n`,
  );
  return { sorted, why };
}

if (mode === 'record') {
  const { sorted, why } = writeRun(BASELINE);
  for (const k of sorted.slice(0, 300)) console.log(`  ✗ ${k}\n      ${why[k] || '(no message)'}`);
  console.log(`\nRecorded ${sorted.length} known failures → ${BASELINE}`);
  console.log('Commit this file. Shrinking it over time is the goal.');
  process.exit(0);
}

// A gate that judges a run can still keep it: CI uploads this file, so a new
// baseline can be read off any run without running the tier twice.
if (process.env.WALNUT_BASELINE_RUN_OUT) writeRun(process.env.WALNUT_BASELINE_RUN_OUT);

if (!fs.existsSync(BASELINE)) {
  console.error(`\nNo baseline at ${BASELINE}. Create one with:\n  node scripts/test-baseline.mjs record`);
  process.exit(1);
}

const known = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).failures ?? []);
const regressions = [...failures].filter((f) => !known.has(f)).sort();
// Only entries whose file ran here can have been fixed: a --shard run sees a
// quarter of the tier, and the rest of the baseline is simply not in it.
const fileOf = (key) => key.slice(0, key.indexOf(' :: '));
const fixed = [...known].filter((f) => filesInRun.has(fileOf(f)) && !failures.has(f)).sort();

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
regressions.forEach((f) => {
  console.log(`    ${f}`);
  if (reasons.get(f)) console.log(`        ↳ ${reasons.get(f)}`);
});
console.log('\nFix them, or if they are genuinely pre-existing, re-record the baseline and explain why.');
process.exit(1);
