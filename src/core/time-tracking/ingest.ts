/**
 * Heartbeat ingest — untrusted sample batch → banked time, with the idempotency
 * and durability the mobile client's retry loop depends on.
 *
 * WHO USES WHAT (the split is deliberate):
 *   - The phone's POST /api/v1/time/heartbeats (routes/time-v1.ts) and the
 *     primary's `server.time.heartbeats` relay handler (sessions/session-controls.ts)
 *     both call bankHeartbeatSamples. They promise the client "204 means banked",
 *     so they need the dedupe ledger and the append verdict.
 *   - The browser's POST /api/time/heartbeats (routes/time.ts) shares only
 *     attachTaskIdsBounded and stays fire-and-forget: it flushes every ~60s from a
 *     page that is already open, so a lost window costs a minute of telemetry and
 *     is not worth an ack round trip. It has no client-side queue to dedupe
 *     against and no retry, so an id ledger would carry no information for it.
 *
 * WHICH BOX VALIDATES MATTERS. A record's `date` is the LOCAL day of its `ts` on
 * the box that sanitizes it, and the store keys days by that. The replica runs
 * UTC while the user's Mac runs their own zone, so a replica that banked (or even
 * pre-validated) a batch would file the user's evening under tomorrow. The
 * replica therefore forwards the batch untouched apart from a size/shape narrow,
 * and the PRIMARY is the only box that ever turns a sample into a record.
 *
 * IDEMPOTENCY (why the ledger exists). Every ack can be lost: iOS suspends a
 * background flush mid-request, the client times out at 20s under load, or the
 * replica's 204 dies with the connection. The client MUST retry, so a batch will
 * arrive twice. Each sample may carry a client-minted `id`; a seen id is skipped,
 * which is what makes the retry safe. The id is an INGEST concern only and is
 * never written to the JSONL: the day files stay exactly the shape every older
 * build wrote.
 *
 * EXACTLY-ONCE IN MEMORY, AT-LEAST-ONCE ON DISK. A claimed id is never folded
 * twice, so the live rollup cannot double count. The disk is retried only when an
 * append is KNOWN to have failed (appendRecords, no fold), because a JSONL line
 * carries no id and could therefore never be deduped on the way back in. While an
 * append's outcome is still unknown a resend waits on the SAME attempt instead of
 * starting a second one.
 *
 * Two residual windows, documented rather than papered over:
 *   1. If an append writes every byte and then fails on close, the retry duplicates
 *      those lines on disk. The rollup is unaffected; a restart would over-count
 *      that day by the size of one batch.
 *   2. An id evicted from the ledger (more than MAX_DEDUPE_IDS ids later, or a
 *      server restart) is treated as new, so a retry that arrives after eviction
 *      banks a second time. The ledger holds hours of a phone's traffic and the
 *      client's retry horizon is minutes, so this needs a multi-hour outage
 *      followed by a delivery to happen at all.
 */

import { log } from '../../logging/index.js';
import { MAX_SAMPLES_PER_REQUEST, normalizeSource, sanitizeSample } from './rollup.js';
import { appendRecords, hydrate, recordTime } from './store.js';
import type { TimeRecord, TimeSource } from './types.js';

/** Session→task resolution is bounded: at most this many lookups per request. */
const MAX_TASK_LOOKUPS = 20;
/** The lookups are indexed sqlite reads, but never let them hold the response. */
const LOOKUP_DEADLINE_MS = 500;
/**
 * Budget for the JSONL append. On expiry the request answers "not banked" and the
 * client retries — the ledger makes that safe — rather than pinning a connection
 * behind a wedged disk or a whale day's compaction.
 */
const APPEND_DEADLINE_MS = 1_000;
/**
 * Budget for the one-time rollup rehydrate. It must finish BEFORE anything is
 * written, because the store parks records written during its read and a parked
 * batch cannot report its own append verdict.
 */
const HYDRATE_DEADLINE_MS = 2_000;

/**
 * Sample ids remembered for dedupe. The client's retry horizon is minutes, and
 * a phone banks a handful of windows a minute, so this covers hours of traffic;
 * process lifetime is enough (a restart loses the live rollup's provenance too,
 * and the disk lines are already written).
 */
const MAX_DEDUPE_IDS = 8192;

/** Longest plausible ISO timestamp / kind, for the relay shape narrow only. */
const MAX_TS_LEN = 64;
const MAX_KIND_LEN = 16;
const MAX_ID_LEN = 128;
/** `<installId>-<seq>`: printable, no separators that could confuse a log or a key. */
const MAX_SAMPLE_ID_LEN = 64;
const SAMPLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** A cancellable timeout — Promise.race never cancels its loser on its own. */
function deadline(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/** Race a promise against a deadline; `onTimeout` is the answer if it wins. */
async function within<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  const bail = deadline(ms);
  try {
    return await Promise.race([work.catch(() => onTimeout), bail.promise.then(() => onTimeout)]);
  } finally {
    bail.cancel();
  }
}

/**
 * Fill in taskId for session samples from the sessions table. Best-effort.
 *
 * The client sends sessionId for a session view and lets the server own the
 * session→task mapping: the client must not be the authority on it (the web
 * panel's DOM does not even carry a task id).
 */
export async function attachTaskIds(records: TimeRecord[]): Promise<void> {
  const needs = [...new Set(records.filter((r) => !r.taskId && r.sessionId).map((r) => r.sessionId!))];
  if (needs.length === 0) return;
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const map = new Map<string, string>();
    for (const sid of needs.slice(0, MAX_TASK_LOOKUPS)) {
      const rec = await getSessionByClaudeId(sid).catch(() => null);
      if (rec?.taskId) map.set(sid, rec.taskId);
    }
    for (const r of records) {
      if (r.taskId || !r.sessionId) continue;
      const taskId = map.get(r.sessionId);
      if (taskId) r.taskId = taskId;
    }
  } catch { /* unattributed session time still counts, just under '' */ }
}

/**
 * Run the session→task join under its own deadline. Never throws.
 *
 * The loser keeps running and can still assign a taskId after this resolves; see
 * the CONSTRAINT note on foldAndAppend in store.ts for why that is safe.
 */
export async function attachTaskIdsBounded(records: TimeRecord[]): Promise<void> {
  await within(attachTaskIds(records), LOOKUP_DEADLINE_MS, undefined);
}

// ─── Dedupe ledger ───────────────────────────────────────────────────────────

interface BankClaim {
  /** Resolves true once every append this claim covers landed on disk. */
  append: Promise<boolean>;
  /** The settled verdict, read by a later resend. Undefined while in flight. */
  appended?: boolean;
}

/** Insertion-ordered, so the first key is always the oldest claim (FIFO). */
const claims = new Map<string, BankClaim>();

function rememberClaim(id: string, claim: BankClaim): void {
  claims.delete(id); // re-point an id at the newest attempt AND refresh its age
  claims.set(id, claim);
  while (claims.size > MAX_DEDUPE_IDS) {
    const oldest = claims.keys().next().value;
    if (oldest === undefined) break;
    claims.delete(oldest);
  }
}

/** Tests and server teardown: forget every remembered sample id. */
export function resetHeartbeatDedupe(): void {
  claims.clear();
}

function sampleId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = (raw as Record<string, unknown>).id;
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (!id || id.length > MAX_SAMPLE_ID_LEN || !SAMPLE_ID_RE.test(id)) return undefined;
  return id;
}

/**
 * Resolve one sample's source against an endpoint default, BEFORE validation.
 *
 * It has to happen pre-validation: sanitizeSample collapses an explicit 'web' to
 * absent (one encoding for browser time), so a default applied afterwards would
 * rewrite exactly the client that was most explicit about being a browser. Rule:
 * a RECOGNIZED source wins; absent or unrecognized takes the default (on the
 * mobile endpoint an unparseable source is a client bug, and its own default is a
 * better guess than "browser").
 */
function withDefaultSource(item: unknown, defaultSource?: TimeSource): unknown {
  if (!defaultSource || !item || typeof item !== 'object') return item;
  const s = item as Record<string, unknown>;
  if (s.source === 'web' || s.source === 'ios') return item;
  return { ...s, source: defaultSource };
}

/** Batch version of withDefaultSource. Returns the input when there is no default. */
export function resolveSampleSources(raw: unknown, defaultSource?: TimeSource): unknown {
  if (!defaultSource || !Array.isArray(raw)) return raw;
  return raw.map((item) => withDefaultSource(item, defaultSource));
}

/** A validated record plus the client id it must be deduped on (when it has one). */
interface Pair {
  id?: string;
  rec: TimeRecord;
}

function pairSamples(raw: unknown, defaultSource: TimeSource | undefined, now: Date): Pair[] {
  if (!Array.isArray(raw)) return [];
  const out: Pair[] = [];
  for (const item of raw.slice(0, MAX_SAMPLES_PER_REQUEST)) {
    const rec = sanitizeSample(withDefaultSource(item, defaultSource), now);
    if (!rec) continue; // junk sample: dropped, never an error
    const id = sampleId(item);
    out.push(id ? { id, rec } : { rec });
  }
  return out;
}

export interface BankOutcome {
  /** Records folded into the rollup by THIS call (junk and dupes excluded). */
  banked: number;
  /** Samples skipped because their id was already accepted. */
  deduped: number;
  /** Total duration of the records banked now. */
  totalMs: number;
  /**
   * True only when every append this request depends on reached the disk. False
   * means the caller must NOT tell the client "banked" — the client keeps the
   * batch queued and retries, which the ledger makes safe.
   */
  durable: boolean;
}

const NOTHING: BankOutcome = { banked: 0, deduped: 0, totalMs: 0, durable: true };

/**
 * Validate a batch and bank it on THIS box. Never throws: telemetry must never
 * surface as a user-visible failure, so a bad batch is `banked: 0`.
 *
 * `defaultSource` applies only to samples that named none — an explicit source
 * always wins, so one endpoint's default can never rewrite another client's
 * declared origin.
 */
export async function bankHeartbeatSamples(
  rawSamples: unknown,
  opts: { defaultSource?: TimeSource; now?: Date } = {},
): Promise<BankOutcome> {
  try {
    const pairs = pairSamples(rawSamples, opts.defaultSource, opts.now ?? new Date());
    if (pairs.length === 0) return NOTHING;

    // Hydration FIRST, and before anything is claimed: the store parks records
    // written during its read, and a parked batch cannot report its own append
    // verdict. A hydrate that will not settle is an honest "not banked" — with
    // nothing claimed, the client's retry is a clean first attempt.
    if (!await within(hydrate().then(() => true), HYDRATE_DEADLINE_MS, false)) {
      log.web.warn('time heartbeat ingest gave up waiting for the rollup rehydrate', {
        samples: pairs.length,
      });
      return { banked: 0, deduped: 0, totalMs: 0, durable: false };
    }

    // ── No `await` from here until the claims are published, so two concurrent
    // ── requests carrying the same id cannot both decide they are the first.
    let settleClaim: (ok: boolean) => void = () => {};
    const claim: BankClaim = { append: new Promise<boolean>((resolve) => { settleClaim = resolve; }) };
    void claim.append.then((ok) => { claim.appended = ok; }, () => { claim.appended = false; });

    const fresh: TimeRecord[] = [];
    const redo: TimeRecord[] = [];
    const waitOn: BankClaim[] = [];
    let deduped = 0;
    for (const { id, rec } of pairs) {
      if (!id) {
        fresh.push(rec); // no id: a legacy client, banked every time (unchanged)
        continue;
      }
      const seen = claims.get(id);
      if (seen === undefined) {
        fresh.push(rec);
        rememberClaim(id, claim);
      } else if (seen.appended === true) {
        deduped++; // already on disk: the retry is a no-op, and that is the point
      } else if (seen.appended === false) {
        // Folded here already, but its append failed. Retry the DISK only.
        redo.push(rec);
        rememberClaim(id, claim);
      } else {
        // Still in flight: wait for that attempt's verdict, start no second one.
        waitOn.push(seen);
        deduped++;
      }
    }

    if (fresh.length === 0 && redo.length === 0) {
      settleClaim(true); // nothing of ours to write
      const durable = await allLanded([], waitOn);
      return { banked: 0, deduped, totalMs: 0, durable };
    }

    try {
      await attachTaskIdsBounded([...fresh, ...redo]);
      const writes: Promise<boolean>[] = [];
      if (fresh.length > 0) writes.push(recordTime(fresh).then((out) => out.appended));
      if (redo.length > 0) writes.push(appendRecords(redo));
      const settled = Promise.all(writes).then((all) => all.every(Boolean));
      void settled.then(settleClaim, () => settleClaim(false));
      const durable = await allLanded([settled], waitOn);
      let totalMs = 0;
      for (const rec of fresh) totalMs += rec.durationMs;
      return { banked: fresh.length, deduped, totalMs, durable };
    } catch (err) {
      // Never leave a waiter hanging on a claim we abandoned.
      settleClaim(false);
      throw err;
    }
  } catch (err) {
    log.web.warn('time heartbeat ingest failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { banked: 0, deduped: 0, totalMs: 0, durable: false };
  }
}

/** Every write this request depends on, under ONE deadline. Never throws. */
function allLanded(writes: Promise<boolean>[], waitOn: BankClaim[]): Promise<boolean> {
  const all = [...writes, ...waitOn.map((c) => c.append)];
  if (all.length === 0) return Promise.resolve(true);
  return within(Promise.all(all).then((r) => r.every(Boolean)), APPEND_DEADLINE_MS, false);
}

/** One sample, narrowed to the known fields at their known sizes. */
export interface NarrowedSample {
  ts: string;
  durationMs: number;
  kind: string;
  taskId?: string;
  sessionId?: string;
  source?: TimeSource;
  id?: string;
}

/** Control characters in an id are a key-injection vector (see rollup.cleanId). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function narrowId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > MAX_ID_LEN || hasControlChar(t)) return undefined;
  return t;
}

/**
 * Bound a batch before it rides the bridge to the primary: at most
 * MAX_SAMPLES_PER_REQUEST entries, only the known fields, each at its known size.
 * The semantic verdict (age window, clamping, the day key) is deliberately NOT
 * made here — that belongs to the primary, in the user's own timezone.
 *
 * This exists because ONE oversized frame closes the shared bridge socket (1009)
 * and kills every in-flight request with it, so an unbounded client body must
 * never be forwarded verbatim.
 *
 * `defaultSource` is resolved HERE, on the edge that knows which client it serves,
 * so the primary banks the same source whether the phone reached it directly or
 * through the replica. The dedupe `id` rides along for the same reason: dedupe has
 * to happen where the records are written.
 */
export function narrowRelaySamples(raw: unknown, defaultSource?: TimeSource): NarrowedSample[] {
  const resolved = resolveSampleSources(raw, defaultSource);
  if (!Array.isArray(resolved)) return [];
  const out: NarrowedSample[] = [];
  for (const item of resolved.slice(0, MAX_SAMPLES_PER_REQUEST)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.ts !== 'string' || s.ts.length > MAX_TS_LEN) continue;
    if (typeof s.durationMs !== 'number' || !Number.isFinite(s.durationMs)) continue;
    if (typeof s.kind !== 'string' || s.kind.length > MAX_KIND_LEN) continue;
    const taskId = narrowId(s.taskId);
    const sessionId = narrowId(s.sessionId);
    const source = normalizeSource(s.source);
    const id = sampleId(s);
    out.push({
      ts: s.ts,
      durationMs: s.durationMs,
      kind: s.kind,
      ...(taskId ? { taskId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(source ? { source } : {}),
      ...(id ? { id } : {}),
    });
  }
  return out;
}
