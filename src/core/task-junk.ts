/**
 * Junk / test-task detection — the single source of truth for "this task is
 * test debris, keep it out of ranked surfaces".
 *
 * Used by BOTH the QMD semantic index (qmd-task-sync.ts skips junk at insert
 * time and lets prune remove already-indexed junk) and the recent-task ledger
 * (task-ledger.ts). Evidence for why this exists: pure-title probe tasks from
 * E2E runs ("Burst message echo test", "V6 unread dot probe") and test
 * projects kept outranking real tasks in task_search (0.875 vs 0.4 on
 * 2026-08-12 "which task did X" queries).
 *
 * Deliberately conservative: project-level rules only for the search index
 * (an exact BM25 hit on a real task must never be filtered), plus a
 * title-level probe heuristic that ONLY the ledger applies (isLedgerJunk).
 */
import type { Task } from './types.js';

/** Exact junk project names that don't match the structural patterns. */
const JUNK_PROJECT_EXACT = new Set(['vc', 'vp', 'personal2', 'e2e-test']);

/**
 * A project is junk when it's test/verify debris:
 *  - `__`-prefixed (E2E fixtures: __TestCat, __dragtest__)
 *  - contains the word "test" or "verify" as a token or CamelCase segment
 *    (Test, Test2, TestCat, Test Category, VerifyCat, UITest-Claude, TestLocal,
 *     GroupTestCat, E2E-Test, `test`)
 *  - an explicit denylist for the rest (VC, VP, Personal2)
 */
export function isJunkProject(project: string | undefined | null): boolean {
  const p = (project ?? '').trim();
  if (!p) return false; // Inbox is not junk
  if (p.startsWith('__')) return true;
  const lower = p.toLowerCase();
  if (JUNK_PROJECT_EXACT.has(lower)) return true;
  // Word/segment match: "test"/"verify" bounded by non-letters OR a case
  // transition (CamelCase). Lowercasing first would merge "UITest" into
  // "uitest" and hide the boundary, so test the raw string.
  return /(^|[^a-zA-Z])(test|verify)/i.test(p) || /(Test|Verify)/.test(p);
}

/** Task-level junk check for ranked surfaces (search index, ledger base). */
export function isJunkTask(task: Pick<Task, 'project' | 'title'>): boolean {
  if (isJunkProject(task.project)) return true;
  return false;
}

/**
 * Stricter check applied ONLY to the ledger (never the search index): recent
 * E2E probe tasks land in Inbox with test-ish titles and, being the newest
 * tasks, would sit at the very top of a recency-sorted ledger.
 */
export function isLedgerJunk(task: Pick<Task, 'project' | 'title'>): boolean {
  if (isJunkTask(task)) return true;
  const title = (task.title ?? '').trim();
  // Probe-style titles: "Burst message echo test", "V6 unread dot probe",
  // "Response and command compliance tests". Word-bounded so a real task like
  // "Fix test:quick pipeline" (has a colon-qualified token) still passes — the
  // heuristic is only about bare trailing/leading probe words.
  return /\b(probe|echo test|e2e[- ]test|smoke test|compliance tests?)\b/i.test(title);
}
