/**
 * The prompt split's maintenance passes over the session store (session-prompts.ts says what the
 * split is): the strip (release B: every old-shape row's texts move into the prompt table, its
 * payload keeps the stubs), the down migration (`walnut sessions-prompts unsplit`: every text back
 * in its payload, the shape every build reads), and the sweep of prompt rows whose session is gone.
 *
 * A pass runs on the server's own connection under the session write lock, one small batch per
 * turn of the event loop (at most 25 rows or 15 ms each): a worker's commits would be foreign
 * commits that drop the cached snapshot. Each batch names its rows, so the snapshot is patched.
 * Idempotent and resumable: a moved row no longer matches, and a restart begins at rowid 0.
 */
import { log } from '../logging/index.js';
import {
  PROMPT_STRIP_ENABLED, fillTextRefsBatch, setPromptSplitMarker, stripPromptBatch, sweepOrphanSessionPrompts, unsplitPromptBatch,
  type PromptBatch,
} from './session-db.js';
import { isFollower, isHostReplica } from './server-role.js';

export const PROMPT_BATCH_ROWS = 25;
export const PROMPT_BATCH_BUDGET_MS = 15;
/** The leader's pass waits this long after the store opens, past the boot burst (as the late indexes do). */
export const PROMPT_JOB_DELAY_MS = 120_000;

export interface PromptPassResult { rows: number; batches: number; bytesMoved: number; ms: number; longestBatchMs: number; swept: number }

/**
 * One whole pass: `strip` (release B's job), `unsplit` (the down migration), or `refs` (the fill of
 * each row's prompt_text_refs column that rows written before release A, or by a build before it
 * since, lack: until it has run, the cache scan measures those rows' texts).
 */
export async function runPromptPass(
  kind: 'strip' | 'unsplit' | 'refs',
  opts: { batchRows?: number; budgetMs?: number; onBatch?: (b: PromptBatch & { ms: number }) => void } = {},
): Promise<PromptPassResult> {
  const { runLockedSessionRowJob } = await import('./session-tracker.js');
  const batch = kind === 'strip' ? stripPromptBatch : kind === 'unsplit' ? unsplitPromptBatch : fillTextRefsBatch;
  const rows = opts.batchRows ?? PROMPT_BATCH_ROWS;
  const budget = opts.budgetMs ?? PROMPT_BATCH_BUDGET_MS;
  const out: PromptPassResult = { rows: 0, batches: 0, bytesMoved: 0, ms: 0, longestBatchMs: 0, swept: 0 };
  const t0 = performance.now();
  let cursor = 0;
  for (;;) {
    const b0 = performance.now();
    const b = await runLockedSessionRowJob((h) => batch(h, cursor, rows, budget));
    const ms = performance.now() - b0;
    out.batches += 1;
    out.rows += b.rows;
    out.bytesMoved += b.bytesMoved;
    if (ms > out.longestBatchMs) out.longestBatchMs = ms;
    opts.onBatch?.({ ...b, ms });
    cursor = b.lastRowid;
    if (b.done) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // A host's own-row writer refuses a prompt row of no own session: the sweep is the leader's.
  const leader = !isHostReplica();
  if (kind === 'refs') {
    out.ms = performance.now() - t0;
    if (out.rows > 0) log.session.info('session prompts: refs pass done', { ...out, ms: Math.round(out.ms), longestBatchMs: Math.round(out.longestBatchMs) });
    return out;
  }
  const end = await runLockedSessionRowJob((h) => {
    const swept = kind === 'strip' && leader ? sweepOrphanSessionPrompts(h) : 0;
    if (leader) setPromptSplitMarker(h, kind === 'strip');
    return { ids: [] as string[], swept };
  });
  out.swept = end.swept;
  out.ms = performance.now() - t0;
  log.session.info(`session prompts: ${kind} pass done`, { ...out, ms: Math.round(out.ms), longestBatchMs: Math.round(out.longestBatchMs) });
  return out;
}

/** The orphan sweep alone, on the leader (release A runs it where release B runs the strip). */
export async function sweepSessionPrompts(): Promise<number> {
  if (isHostReplica()) return 0;
  const { runLockedSessionRowJob } = await import('./session-tracker.js');
  const { swept } = await runLockedSessionRowJob((h) => ({ ids: [] as string[], swept: sweepOrphanSessionPrompts(h) }));
  if (swept > 0) log.session.info('session prompts: prompt rows of deleted sessions removed', { swept });
  return swept;
}

let jobTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Once per store open on the leader, past the boot burst: the column fill (only rows that lack it:
 * all of them once, after that the few a build before the split wrote), then the strip pass when
 * release B turns it on, else the orphan sweep alone. A failure is logged; the next open tries again.
 */
export function armPromptJob(delayMs = PROMPT_JOB_DELAY_MS): void {
  if (jobTimer || isFollower() || isHostReplica()) return;
  jobTimer = setTimeout(() => {
    const run = runPromptPass('refs').then(async (): Promise<unknown> => (PROMPT_STRIP_ENABLED ? runPromptPass('strip') : sweepSessionPrompts()));
    void run.catch((err) => log.session.warn('session prompts: the maintenance pass failed', { error: err instanceof Error ? err.message : String(err) }));
  }, delayMs);
  jobTimer.unref?.();
}

/** Tests and a store close: the pending pass does not run. */
export function disarmPromptJob(): void {
  if (jobTimer) clearTimeout(jobTimer);
  jobTimer = null;
}
