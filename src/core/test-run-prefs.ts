/**
 * A test run's preference writes land in its own copy, never in the user's files.
 *
 * 2026-10-31: the user's synced ui-prefs said the task panel was hidden (with the chat and
 * every other panel), and every fresh browser opened on an empty Home. Tasks and projects a
 * test run makes were already test objects (test-run.ts), but a browser under automation on
 * the user's own Walnut still wrote the user's layout, favorites, project order and mail switch for real:
 * the web app sends `x-walnut-test-run` from such a window, and these routes ignored it.
 *
 * Now each preference family a test run writes keeps the run's CHANGES in memory under the
 * run's label: what it set, added or removed, never a snapshot of the user's values. Its
 * reads are the user's live values with those changes on top, so the run reads its own
 * writes back while every other value stays the user's, and nothing reaches the user's
 * files, the other windows, the phone or git sync. An automated browser's label names its
 * browser context (`webdriver-<id>`, web/src/api/test-run.ts), so a fresh browser opens on the
 * user's own layout, not the last run's; a copy goes TEST_RUN_PREFS_IDLE_MS after its run's
 * last write (a read never keeps it), so a label many windows share (an older web app's
 * `webdriver`, an asked label, the CLI's) does not keep one run's layout for the next. At most
 * TEST_RUN_PREFS_MAX_RUNS runs are kept (the oldest goes first); a restart forgets them all.
 *
 * The routes that write a preference are listed in tests/core/test-run-prefs-gate.test.ts,
 * which fails on a new one that does not go through here.
 */
import { ambientTestRun } from './test-run.js';

/** One family per preference store a route writes. */
export type TestRunPrefsFamily = 'ui-prefs' | 'favorites' | 'ordering' | 'mail-grouped' | 'push-preferences';

export const TEST_RUN_PREFS_IDLE_MS = 30 * 60 * 1000;
export const TEST_RUN_PREFS_MAX_RUNS = 32;

interface RunCopies { at: number; families: Map<TestRunPrefsFamily, unknown> }

const runs = new Map<string, RunCopies>();

function sweep(now: number): void {
  for (const [label, run] of runs) if (now - run.at > TEST_RUN_PREFS_IDLE_MS) runs.delete(label);
  while (runs.size > TEST_RUN_PREFS_MAX_RUNS) {
    let oldest: string | undefined;
    let at = Infinity;
    for (const [label, run] of runs) if (run.at < at) { at = run.at; oldest = label; }
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
}

/**
 * The current test run's changes to `family`, to write into (made empty by `create` the first
 * time), or null when the request is no test run: the caller then writes the user's own store
 * as before. The object is kept by reference; the caller mutates it.
 */
export function testRunPrefsWrite<T>(family: TestRunPrefsFamily, create: () => T): T | null {
  const label = ambientTestRun();
  if (!label) return null;
  const now = Date.now();
  sweep(now);
  let run = runs.get(label);
  if (!run) {
    run = { at: now, families: new Map() };
    runs.set(label, run);
    sweep(now);
  }
  run.at = now;
  if (!run.families.has(family)) run.families.set(family, create());
  return run.families.get(family) as T;
}

/**
 * The current test run's changes to `family`, to lay over the user's values, or null when the
 * request is no test run or the run changed nothing there (it reads the user's values as is).
 */
export function testRunPrefsRead<T>(family: TestRunPrefsFamily): T | null {
  const label = ambientTestRun();
  if (!label) return null;
  sweep(Date.now());
  return (runs.get(label)?.families.get(family) as T | undefined) ?? null;
}

/** Tests: forget every copy. */
export function _resetTestRunPrefsForTest(): void {
  runs.clear();
}
