#!/usr/bin/env bun
/**
 * L3 — run only the test tiers your current change can actually break.
 *
 *   bun run test:changed      → each tier the diff touches, narrowed to the tests related to it
 *   bun run test:pre-commit   → the FULL tiers the diff touches (quick + slow + e2e as needed)
 *   bun scripts/test-changed.mjs --plan [--tiers]  → print what would run, run nothing
 *
 * Why a script and not just `vitest --changed`: vitest's module graph answers
 * "which test files import the code I edited", which is the right question for
 * src/ changes but useless for the ones that matter most here — a change to
 * web/src/ (frontend, only covered by Playwright + the web-rooted configs), to
 * ios-native/, or to a vitest config itself. This maps paths → tiers explicitly,
 * then hands the file-level narrowing inside a tier to vitest.
 *
 * Narrow mode (the default) narrows EVERY vitest tier, slow and e2e included: it
 * runs `vitest related` on the changed files plus the test-side files that name
 * one of them by path (scripts/test-changed-refs.mjs), so a test that starts the
 * changed code as a child process is kept too. Only `--tiers` runs whole tiers.
 * Each tier prints how many files it selected before it runs
 * (scripts/vitest-selection-reporter.mjs); a tier that selected none says so
 * and is never reported as passed.
 *
 * Machine safety: tiers run SEQUENTIALLY and inherit the worker budget from
 * tests/setup/worker-budget.ts. This script never widens either.
 */
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunExecutable, vitestCommand } from './bun-vitest.mjs';
import { pathReferenceSources } from './test-changed-refs.mjs';

/** Run a git command, returning '' rather than throwing (fresh clone, no commits, …). */
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedFiles(base) {
  // Uncommitted (staged + unstaged) plus untracked — the pre-commit question is
  // "what is about to be committed", not "what differs from origin".
  //
  // Each call is fault-tolerant: in a repo with no commits yet `git diff HEAD`
  // fails, and a detached HEAD or missing ref would otherwise abort the whole
  // script. Falling back to '' degrades to "fewer known changes", and the
  // no-changes branch below then explains itself rather than crashing.
  const tracked = git(`diff --name-only ${base}`);
  const staged = git('diff --cached --name-only');
  const untracked = git('ls-files --others --exclude-standard');
  return [...new Set(`${tracked}\n${staged}\n${untracked}`.split('\n').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Path → tier mapping. Order matters only for readability; every match is unioned.
 * `null` tiers mean "this path cannot affect any vitest tier" (docs, iOS, CI meta).
 */
export const RULES = [
  // tests/e2e/** owns the e2e tier; a change there (or to the session/daemon
  // transport it exercises) is the only thing that warrants paying for it.
  { re: /^tests\/e2e\//, tiers: ['e2e'], why: 'e2e specs' },
  { re: /^src\/providers\/|^src\/web\/(server|ws)/, tiers: ['quick', 'slow', 'e2e'], why: 'session transport — e2e covers it' },
  { re: /^(src|tests)\//, tiers: ['quick', 'slow'], why: 'server/core code + its tests' },
  { re: /^vitest(\..*)?\.config\.ts$|^tests\/setup\//, tiers: ['quick', 'slow'], why: 'test infrastructure' },
  { re: /^playwright\.config\.ts$/, tiers: [], why: 'browser tier only: run `bun x playwright test`' },
  { re: /^tsup\.config\.ts$|^tsconfig.*\.json$/, tiers: ['quick'], why: 'build/type config' },
  { re: /^web\/src\//, tiers: ['web'], why: 'frontend — covered by the web-rooted configs + Playwright' },
  { re: /^scripts\//, tiers: ['quick'], why: 'scripts are exercised by unit-level tests' },
  { re: /^package(-lock)?\.json$|^bun\.lock$|^bunfig\.toml$|^patches\//, tiers: ['quick', 'slow', 'web'], why: 'dependency change: anything can break' },
  { re: /^(docs|site|ios-native|infra|\.github)\//, tiers: [], why: 'no vitest coverage' },
  { re: /\.(md|svg|png|jpg|gif|mp4|plist|yml|yaml)$/, tiers: [], why: 'non-code' },
];

/** The vitest config of each vitest tier. */
export const TIER_CONFIGS = {
  quick: 'vitest.quick.config.ts',
  slow: 'vitest.slow.config.ts',
  e2e: 'vitest.e2e.config.ts',
};
// ALL FOUR frontend-rooted configs, via the package script. Pointing this at
// vitest.diff-view.config.ts alone silently skipped markdown, workflow-graph
// and notes-roundtrip (three quarters of the frontend coverage) while
// reporting the 'web' tier as run.
const WEB_SCRIPT = ['run', 'test:frontend:ci'];
const TIER_ORDER = ['quick', 'slow', 'web', 'e2e'];
export const SELECTION_REPORTER = './scripts/vitest-selection-reporter.mjs';

/** The tiers a set of changed paths can break (in run order), and the paths no rule knows. */
export function tiersFor(files) {
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
  return { tiers: TIER_ORDER.filter((t) => tiers.has(t)), unmatched };
}

/**
 * How one tier runs. Full: the tier's whole config. Narrow: `vitest related` over
 * `related` (the changed files plus the path-reference files), which keeps only
 * the tier's tests whose import graph reaches one of them; vitest still runs the
 * whole tier when a forceRerunTriggers file (package.json, a vitest config, a
 * setup file) is among them. The web tier is a package script and is never narrowed.
 */
export function tierCommand(tier, { full, related = [] }) {
  if (tier === 'web') return { cmd: bunExecutable(), args: WEB_SCRIPT, narrowed: false };
  const head = full ? ['run'] : ['related', '--run'];
  const reporters = ['--reporter=default', `--reporter=${SELECTION_REPORTER}`];
  return { ...vitestCommand([...head, '--config', TIER_CONFIGS[tier], ...reporters, ...(full ? [] : related)]), narrowed: !full };
}

/**
 * What a tier's run proved. Only a run that selected files and exited 0 passed;
 * one that selected none ran nothing ('none'), and an exit 0 with no count from
 * the selection reporter proves nothing ('unconfirmed', counted as a failure).
 */
export function tierVerdict(code, selected) {
  if (code !== 0) return 'failed';
  if (selected == null) return 'unconfirmed';
  return selected > 0 ? 'passed' : 'none';
}

function main() {
  const args = process.argv.slice(2);
  const FULL_TIERS = args.includes('--tiers');
  // --plan prints what would run, as JSON, and runs nothing.
  const PLAN = args.includes('--plan');
  const BASE = process.env.WALNUT_DIFF_BASE ?? 'HEAD';

  // This script is a LOCAL developer convenience, not a CI gate. Its "no changes →
  // exit 0" path is correct for a working tree and catastrophic for CI: a clean PR
  // checkout has no uncommitted changes, so it would run nothing and report green.
  // Refuse to be a gate rather than silently be a broken one.
  if (process.env.CI && !process.env.WALNUT_DIFF_BASE) {
    console.error(
      'test-changed.mjs is a local tool and must not gate CI: on a clean checkout it\n' +
        'would find no uncommitted changes, run nothing, and exit 0 (a green no-op).\n' +
        'Run the tiers explicitly in CI, or set WALNUT_DIFF_BASE=origin/main to compare\n' +
        'against the base branch deliberately.',
    );
    process.exit(2);
  }

  const files = changedFiles(BASE);
  if (files.length === 0) {
    // Either genuinely nothing changed, or we're somewhere git can't answer from
    // (no commits yet, detached HEAD with a bad base). Say which is possible so a
    // silent "nothing to test" is never mistaken for "everything passed".
    console.log(`No changes detected vs ${BASE}: nothing to test.`);
    console.log(`  If that's unexpected, check \`git diff --name-only ${BASE}\` works here,`);
    console.log('  or set WALNUT_DIFF_BASE (e.g. origin/main) and re-run.');
    process.exit(0);
  }

  const { tiers: order, unmatched } = tiersFor(files);

  console.log(`\n${files.length} changed file(s) vs ${BASE}`);
  if (unmatched.length) {
    console.log(`  ${unmatched.length} unrecognised path(s) → running the quick tier to be safe:`);
    unmatched.slice(0, 5).forEach((f) => console.log(`    ${f}`));
    if (unmatched.length > 5) console.log(`    … and ${unmatched.length - 5} more`);
  }

  if (order.length === 0) {
    console.log('  → no tier can be affected (docs / iOS / assets only). Nothing to run.\n');
    process.exit(0);
  }

  let related = [];
  if (!FULL_TIERS && order.some((t) => t !== 'web')) {
    const refs = pathReferenceSources(process.cwd(), files);
    related = [...files, ...refs];
    console.log(`  ${refs.length} test-side file(s) name a changed module by path, added to the narrowing`);
  }
  console.log(`  → tiers: ${order.join(', ')}${FULL_TIERS ? ' (whole tiers)' : ' (each narrowed to the related test files)'}\n`);
  if (PLAN) {
    const commands = order.map((tier) => ({ tier, ...tierCommand(tier, { full: FULL_TIERS, related }) }));
    console.log(JSON.stringify({ base: BASE, files, related, commands }, null, 2));
    process.exit(0);
  }

  // One shared gate slot for every tier of this invocation, otherwise each tier
  // registers as a separate concurrent run and self-deadlocks (see test-gate.ts).
  const env = { ...process.env, WALNUT_TEST_RUN_ID: process.env.WALNUT_TEST_RUN_ID ?? `tc-${process.pid}` };
  const countDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-test-changed-'));

  let failed = 0;
  try {
    for (const tier of order) {
      const { cmd, args: argv, narrowed } = tierCommand(tier, { full: FULL_TIERS, related });
      const shown = narrowed ? [...argv.slice(0, argv.length - related.length), `<${related.length} related paths>`] : argv;
      console.log(`▶ [${tier}] bun ${shown.join(' ')}\n`);
      const countFile = path.join(countDir, `${tier}.count`);
      const r = spawnSync(cmd, argv, {
        stdio: 'inherit',
        env: { ...env, WALNUT_SELECTION_LABEL: tier, WALNUT_SELECTION_FILE: countFile },
        shell: process.platform === 'win32',
      });
      const code = r.status ?? 1;
      if (tier === 'web') {
        console.log(code === 0 ? `\n✓ [web] passed\n` : `\n✗ [web] failed (exit ${code})\n`);
        if (code !== 0) failed = code;
        continue;
      }
      const raw = fs.existsSync(countFile) ? Number.parseInt(fs.readFileSync(countFile, 'utf-8'), 10) : NaN;
      const selected = Number.isFinite(raw) ? raw : null;
      const verdict = tierVerdict(code, selected);
      if (verdict === 'passed') console.log(`\n✓ [${tier}] passed (${selected} file${selected === 1 ? '' : 's'})\n`);
      else if (verdict === 'none') console.log(`\n· [${tier}] no test file in this tier is related to the change: nothing ran\n`);
      else if (verdict === 'unconfirmed') {
        console.log(`\n✗ [${tier}] exited 0 without reporting what it ran: not counted as passed\n`);
        failed = 1;
      } else {
        console.log(`\n✗ [${tier}] failed (exit ${code})\n`);
        failed = code;
      }
    }
  } finally {
    fs.rmSync(countDir, { recursive: true, force: true });
  }
  process.exit(failed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
