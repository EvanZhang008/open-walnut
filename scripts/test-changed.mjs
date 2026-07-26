#!/usr/bin/env node
/**
 * L3 — run only the test tiers your current change can actually break.
 *
 *   npm run test:changed      → the quick tier, narrowed to tests related to the diff
 *   npm run test:pre-commit   → the FULL tiers the diff touches (quick + slow + e2e as needed)
 *
 * Why a script and not just `vitest --changed`: vitest's module graph answers
 * "which test files import the code I edited", which is the right question for
 * src/ changes but useless for the ones that matter most here — a change to
 * web/src/ (frontend, only covered by Playwright + the web-rooted configs), to
 * ios-native/, or to a vitest config itself. This maps paths → tiers explicitly,
 * then hands the file-level narrowing inside a tier to vitest.
 *
 * Machine safety: tiers run SEQUENTIALLY and inherit the 2-worker budget from
 * tests/setup/worker-budget.ts. This script never widens either.
 */
import { spawnSync, execSync } from 'node:child_process';

const args = process.argv.slice(2);
const FULL_TIERS = args.includes('--tiers');
const BASE = process.env.WALNUT_DIFF_BASE ?? 'HEAD';

/** Run a git command, returning '' rather than throwing (fresh clone, no commits, …). */
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedFiles() {
  // Uncommitted (staged + unstaged) plus untracked — the pre-commit question is
  // "what is about to be committed", not "what differs from origin".
  //
  // Each call is fault-tolerant: in a repo with no commits yet `git diff HEAD`
  // fails, and a detached HEAD or missing ref would otherwise abort the whole
  // script. Falling back to '' degrades to "fewer known changes", and the
  // no-changes branch below then explains itself rather than crashing.
  const tracked = git(`diff --name-only ${BASE}`);
  const staged = git('diff --cached --name-only');
  const untracked = git('ls-files --others --exclude-standard');
  return [...new Set(`${tracked}\n${staged}\n${untracked}`.split('\n').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Path → tier mapping. Order matters only for readability; every match is unioned.
 * `null` tiers mean "this path cannot affect any vitest tier" (docs, iOS, CI meta).
 */
const RULES = [
  { re: /^(src|tests)\//, tiers: ['quick', 'slow'], why: 'server/core code + its tests' },
  { re: /^vitest(\..*)?\.config\.ts$|^tests\/setup\//, tiers: ['quick', 'slow'], why: 'test infrastructure' },
  { re: /^playwright\.config\.ts$/, tiers: [], why: 'browser tier only — run `npx playwright test`' },
  { re: /^tsup\.config\.ts$|^tsconfig.*\.json$/, tiers: ['quick'], why: 'build/type config' },
  { re: /^web\/src\//, tiers: ['web'], why: 'frontend — covered by the web-rooted configs + Playwright' },
  { re: /^scripts\//, tiers: ['quick'], why: 'scripts are exercised by unit-level tests' },
  { re: /^package(-lock)?\.json$/, tiers: ['quick', 'slow'], why: 'dependency change — anything can break' },
  { re: /^(docs|site|ios-native|infra|\.github)\//, tiers: [], why: 'no vitest coverage' },
  { re: /\.(md|svg|png|jpg|gif|mp4|plist|yml|yaml)$/, tiers: [], why: 'non-code' },
];

const TIER_CMDS = {
  quick: ['vitest', 'run', '--config', 'vitest.quick.config.ts'],
  slow: ['vitest', 'run', '--config', 'vitest.slow.config.ts'],
  e2e: ['vitest', 'run', '--config', 'vitest.e2e.config.ts'],
  web: ['vitest', 'run', '--config', 'vitest.diff-view.config.ts'],
};

const files = changedFiles();
if (files.length === 0) {
  // Either genuinely nothing changed, or we're somewhere git can't answer from
  // (no commits yet, detached HEAD with a bad base). Say which is possible so a
  // silent "nothing to test" is never mistaken for "everything passed".
  console.log(`No changes detected vs ${BASE} — nothing to test.`);
  console.log(`  If that's unexpected, check \`git diff --name-only ${BASE}\` works here,`);
  console.log('  or set WALNUT_DIFF_BASE (e.g. origin/main) and re-run.');
  process.exit(0);
}

const tiers = new Set();
const unmatched = [];
for (const f of files) {
  const rule = RULES.find((r) => r.re.test(f));
  if (!rule) {
    // Unknown path → be conservative and run the fast tier rather than skip it.
    unmatched.push(f);
    tiers.add('quick');
    continue;
  }
  rule.tiers.forEach((t) => tiers.add(t));
}

console.log(`\n${files.length} changed file(s) vs ${BASE}`);
if (unmatched.length) {
  console.log(`  ${unmatched.length} unrecognised path(s) → running the quick tier to be safe:`);
  unmatched.slice(0, 5).forEach((f) => console.log(`    ${f}`));
  if (unmatched.length > 5) console.log(`    … and ${unmatched.length - 5} more`);
}

if (tiers.size === 0) {
  console.log('  → no tier can be affected (docs / iOS / assets only). Nothing to run.\n');
  process.exit(0);
}

const order = ['quick', 'slow', 'web', 'e2e'].filter((t) => tiers.has(t));
console.log(`  → tiers: ${order.join(', ')}${FULL_TIERS ? '' : ' (narrowed to related test files)'}\n`);

// One shared gate slot for every tier of this invocation — otherwise each tier
// registers as a separate concurrent run and self-deadlocks (see test-gate.ts).
const env = { ...process.env, WALNUT_TEST_RUN_ID: process.env.WALNUT_TEST_RUN_ID ?? `tc-${process.pid}` };

let failed = 0;
for (const tier of order) {
  // In narrow mode, let vitest intersect the tier with the diff's module graph.
  // The slow/e2e tiers are already small, so narrowing them adds no value.
  const narrow = !FULL_TIERS && tier === 'quick' ? ['--changed', BASE] : [];
  const argv = [...TIER_CMDS[tier], ...narrow];
  console.log(`▶ [${tier}] npx ${argv.join(' ')}\n`);
  const r = spawnSync('npx', argv, { stdio: 'inherit', env });
  const code = r.status ?? 1;
  console.log(code === 0 ? `\n✓ [${tier}] passed\n` : `\n✗ [${tier}] failed (exit ${code})\n`);
  if (code !== 0) failed = code;
}

process.exit(failed);
