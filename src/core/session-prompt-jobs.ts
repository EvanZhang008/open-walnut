/**
 * The prompt split's maintenance passes over the session store (session-prompts.ts says what the
 * split is): the strip (release B, once its gate opened, session-prompt-gate.ts: every old-shape
 * row's texts move into the prompt table, its payload keeps the stubs), the down migration
 * (`walnut sessions-prompts unsplit`: every text back in its payload, the shape every build reads),
 * and the sweep of prompt rows whose session is gone.
 *
 * A pass runs on the server's own connection under the session write lock, one small batch per
 * turn of the event loop (at most 25 rows or 15 ms each): a worker's commits would be foreign
 * commits that drop the cached snapshot. Each batch names its rows, so the snapshot is patched.
 * Idempotent and resumable: a moved row no longer matches, and a restart begins at rowid 0.
 */
import { log } from '../logging/index.js';
import {
  dbGeneration, fillTextRefsBatch, keepPromptTextsInPayload, letPromptTextsLeavePayload, setPromptSplitMarker, stripPromptBatch, sweepOrphanSessionPrompts, unsplitPromptBatch,
  type PromptBatch,
} from './session-db.js';
import { forgetServedVersions, noteServedVersion, ownVersion, promptStripGate, type PromptGate } from './session-prompt-gate.js';
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
  opts: {
    batchRows?: number; budgetMs?: number; onBatch?: (b: PromptBatch & { ms: number }) => void;
    /** Runs inside each batch's own transaction, after its rows: what must commit with them. */
    inBatch?: (handle: import('../lib/sqlite.js').Database, b: PromptBatch) => void;
  } = {},
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
    const b = await runLockedSessionRowJob((h) => {
      const done = batch(h, cursor, rows, budget);
      opts.inBatch?.(h, done);
      return done;
    });
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

export interface PromptJobResult { gate: PromptGate; strip?: PromptPassResult; swept?: number }

/**
 * The leader's maintenance once per store open: the column fill (only rows that lack it: all of them
 * once, after that the few a build before the split wrote), this release's mark in the store's list
 * of releases that served it, then the strip gate (session-prompt-gate.ts). Open: from now on writes
 * leave only the stubs, and the strip pass moves the rest. Closed: the orphan sweep alone, and the
 * writer keeps every text in its payload as release A did. Until it answers, a write keeps each
 * prompt where it is (session-db.ts promptPayloadMode).
 *
 * Rows the fill found say a build before the split wrote this store since the last open (a person
 * went back to it): that build is one this home goes back to, whatever was recorded before. The
 * gate stays closed for this open, and the list of releases starts again with this one, so it opens
 * only after a later release served the store once more.
 */
export async function runPromptJob(opts: {
  gate?: (handle: import('../lib/sqlite.js').Database) => Promise<PromptGate>;
  version?: string | null;
  /** The store's generation when the job was armed: a store reopened since is not this job's. */
  generation?: number;
} = {}): Promise<PromptJobResult> {
  const { runLockedSessionRowJob } = await import('./session-tracker.js');
  const generation = opts.generation ?? dbGeneration();
  // The first batch that fills a row forgets the list in its own transaction: a kill between
  // a fill and a separate forget would leave no row to fill and the old list, so the next open
  // would take the build that wrote those rows for none this home goes back to.
  let forgot = false;
  const fill = await runPromptPass('refs', {
    inBatch: (h, b) => {
      if (forgot || b.rows === 0) return;
      forgetServedVersions(h);
      forgot = true;
    },
  });
  const olderBuildWrote = fill.rows > 0;
  let handle: import('../lib/sqlite.js').Database | null = null;
  const version = opts.version === undefined ? ownVersion() : opts.version;
  await runLockedSessionRowJob((h) => {
    handle = h;
    if (version) noteServedVersion(h, version);
    return { ids: [] as string[] };
  });
  if (olderBuildWrote) {
    const gate: PromptGate = { open: false, reason: `${fill.rows} rows were written by a build before the prompt split since the last open: it is one this home goes back to` };
    log.session.info('session prompts: the strip gate is closed', { ...gate });
    if (dbGeneration() === generation) keepPromptTextsInPayload();
    return { gate, swept: await sweepSessionPrompts() };
  }
  // The gate's probes may take a while (two builds, 45 s each at worst). When it answers, this
  // process must still be the leader on the store the job was armed for.
  let gate = await (opts.gate ?? ((h) => promptStripGate(h, { version })))(handle!);
  const answered = gate;
  if (gate.open && (isFollower() || isHostReplica() || dbGeneration() !== generation)) {
    gate = { open: false, reason: 'the store was reopened or this server is not the leader any more' };
  }
  log.session.info(`session prompts: the strip gate is ${gate.open ? 'open' : 'closed'}`, { ...gate });
  // Closed by its own answer, on the store it was asked for: from now on every text in its payload
  // (session-db.ts promptPayloadMode). A store reopened since keeps its own open's shape.
  if (!answered.open && dbGeneration() === generation) keepPromptTextsInPayload();
  if (!gate.open) return { gate, swept: await sweepSessionPrompts() };
  letPromptTextsLeavePayload();
  return { gate, strip: await runPromptPass('strip') };
}

/** Once per store open on the leader, past the boot burst: runPromptJob. A failure is logged; the next open tries again. */
export function armPromptJob(delayMs = PROMPT_JOB_DELAY_MS): void {
  if (jobTimer || isFollower() || isHostReplica()) return;
  const generation = dbGeneration();
  jobTimer = setTimeout(() => {
    void runPromptJob({ generation }).catch((err) => log.session.warn('session prompts: the maintenance pass failed', { error: err instanceof Error ? err.message : String(err) }));
  }, delayMs);
  jobTimer.unref?.();
}

/** Tests and a store close: the pending pass does not run. */
export function disarmPromptJob(): void {
  if (jobTimer) clearTimeout(jobTimer);
  jobTimer = null;
}
