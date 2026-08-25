/**
 * Time tracking — PURE rollup logic. No fs, no clock, no imports from the app.
 *
 * Everything the routes need to answer a summary lives here so it can be unit
 * tested without a server: validation of an untrusted heartbeat sample, the
 * (date, taskId, kind) fold, local-date arithmetic, and the human/agent join.
 */

import {
  HUMAN_KINDS,
  TIME_KINDS,
  type HeartbeatSample,
  type HumanKind,
  type RollupIndex,
  type TimeKind,
  type TimeRecord,
  type TimeSummary,
  type DayTime,
  type TaskDayTime,
} from './types.js';

/** A single lease window can never legitimately exceed this (client caps at 60s + a flush). */
export const MAX_SAMPLE_MS = 10 * 60 * 1000;
/** Samples older than this are stale client state, not history to be trusted. */
const MAX_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Small clock skew allowance for a client whose clock runs fast. */
const MAX_SAMPLE_FUTURE_MS = 5 * 60 * 1000;
/** Hard cap on samples accepted from one request. */
export const MAX_SAMPLES_PER_REQUEST = 200;
const MAX_ID_LEN = 128;

// NUL cannot appear in a task id, a date, or a kind, so the composite key never collides.
const SEP = '\u0000';

export function bucketKey(date: string, taskId: string, kind: TimeKind): string {
  return `${date}${SEP}${taskId}${SEP}${kind}`;
}

/**
 * Inverse of bucketKey. Only the taskId can ever carry an extra separator (an id
 * written by a build before cleanId rejected control characters), so the LAST
 * field is the kind and everything between is the id — reading the second field
 * as the kind is what let `t_real\u0000agent` land in the AGENT lane. A key with
 * fewer than three fields is malformed and gets an empty kind, which summarize
 * then skips rather than folding into a lane it guessed.
 */
export function parseBucketKey(key: string): { date: string; taskId: string; kind: TimeKind } {
  const parts = key.split(SEP);
  if (parts.length < 3) return { date: parts[0] ?? '', taskId: parts[1] ?? '', kind: '' as TimeKind };
  return {
    date: parts[0]!,
    taskId: parts.slice(1, -1).join(SEP),
    kind: parts[parts.length - 1] as TimeKind,
  };
}

/** Local YYYY-MM-DD for a Date (NOT UTC — the panel shows the user's own day). */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift a YYYY-MM-DD key by whole days, staying in the local calendar. */
export function shiftDateKey(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10));
  // Noon anchor: a DST transition can move midnight across the day boundary.
  const anchor = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + deltaDays);
  return localDateKey(anchor);
}

/** The `days` most recent date keys ending at `today`, ascending. */
export function recentDateKeys(today: string, days: number): string[] {
  const n = Math.max(1, Math.floor(days));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDateKey(today, -i));
  return out;
}

/**
 * Control characters in a client-supplied id are a key-injection vector, not a
 * typo: the bucket key is `date SEP taskId SEP kind`, so a taskId of
 * `t_real\u0000agent` parses back out as the AGENT lane — which types.ts says is
 * never client-supplied. Reject them at the door.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function cleanId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_ID_LEN) return undefined;
  if (CONTROL_CHARS_RE.test(t)) return undefined;
  return t;
}

function isHumanKind(raw: unknown): raw is HumanKind {
  return typeof raw === 'string' && (HUMAN_KINDS as readonly string[]).includes(raw);
}

/** A key whose kind is not one of the four lanes is malformed data. */
function isTimeKind(raw: unknown): raw is TimeKind {
  return typeof raw === 'string' && (TIME_KINDS as readonly string[]).includes(raw);
}

/**
 * Validate ONE untrusted heartbeat sample into a day-keyed record.
 * Returns null when the sample cannot be trusted (bad kind, absurd duration,
 * a timestamp far outside the accepted window). Durations are clamped, not
 * rejected, so a long uninterrupted lease still lands.
 */
export function sanitizeSample(raw: unknown, now: Date): TimeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<HeartbeatSample>;
  if (!isHumanKind(s.kind)) return null;

  const started = typeof s.ts === 'string' ? new Date(s.ts) : new Date(NaN);
  const startedMs = started.getTime();
  if (!Number.isFinite(startedMs)) return null;
  const age = now.getTime() - startedMs;
  if (age > MAX_SAMPLE_AGE_MS || age < -MAX_SAMPLE_FUTURE_MS) return null;

  const dur = typeof s.durationMs === 'number' && Number.isFinite(s.durationMs)
    ? Math.round(s.durationMs)
    : 0;
  if (dur <= 0) return null;

  const rec: TimeRecord = {
    date: localDateKey(started),
    ts: started.toISOString(),
    durationMs: Math.min(dur, MAX_SAMPLE_MS),
    kind: s.kind,
  };
  const taskId = cleanId(s.taskId);
  if (taskId) rec.taskId = taskId;
  const sessionId = cleanId(s.sessionId);
  if (sessionId) rec.sessionId = sessionId;
  return rec;
}

/** Accept a batch, dropping unusable entries. Caps the batch size. */
export function sanitizeSamples(raw: unknown, now: Date): TimeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: TimeRecord[] = [];
  for (const item of raw.slice(0, MAX_SAMPLES_PER_REQUEST)) {
    const rec = sanitizeSample(item, now);
    if (rec) out.push(rec);
  }
  return out;
}

/** Add one record into an index (mutates and returns it). */
export function addRecord(index: RollupIndex, rec: TimeRecord): RollupIndex {
  const key = bucketKey(rec.date, rec.taskId ?? '', rec.kind);
  index.set(key, (index.get(key) ?? 0) + rec.durationMs);
  return index;
}

export function foldRecords(records: Iterable<TimeRecord>): RollupIndex {
  const index: RollupIndex = new Map();
  for (const rec of records) addRecord(index, rec);
  return index;
}

/** Merge `from` into `into` (mutates `into`). Used to layer backfill under live data. */
export function mergeIndex(into: RollupIndex, from: RollupIndex): RollupIndex {
  for (const [key, ms] of from) into.set(key, (into.get(key) ?? 0) + ms);
  return into;
}

/** Days that already carry at least one agent bucket — a backfill must skip these. */
export function datesWithAgentTime(index: RollupIndex): Set<string> {
  const dates = new Set<string>();
  for (const [key, ms] of index) {
    if (ms <= 0) continue;
    const { date, kind } = parseBucketKey(key);
    if (kind === 'agent') dates.add(date);
  }
  return dates;
}

function emptyByKind(): Record<HumanKind, number> {
  return { session: 0, triage: 0, chat: 0 };
}

/**
 * Join the human and agent lanes into the per-day / per-task shape the panel
 * renders. `days` fixes the window (zeros included so the trend has no gaps).
 */
export function summarize(
  index: RollupIndex,
  opts: { days: string[]; today: string; focusTaskIds?: Iterable<string>; degraded?: boolean },
): TimeSummary {
  const focus = new Set(opts.focusTaskIds ?? []);
  const wanted = new Set(opts.days);
  // date → taskId → bucket
  const perDay = new Map<string, Map<string, TaskDayTime>>();
  for (const date of opts.days) perDay.set(date, new Map());

  for (const [key, ms] of index) {
    if (ms <= 0) continue;
    const { date, taskId, kind } = parseBucketKey(key);
    if (!wanted.has(date)) continue;
    // A kind that is not one of the four lanes means the key is malformed (a
    // hand-edited JSONL line, an id that smuggled a separator past an older
    // build). Drop it — never invent a bucket or a `byKind` field from it.
    if (!isTimeKind(kind)) continue;
    const byTask = perDay.get(date)!;
    let bucket = byTask.get(taskId);
    if (!bucket) {
      bucket = { taskId, humanMs: 0, byKind: emptyByKind(), agentMs: 0, focus: focus.has(taskId) };
      byTask.set(taskId, bucket);
    }
    if (kind === 'agent') {
      bucket.agentMs += ms;
    } else {
      bucket.humanMs += ms;
      bucket.byKind[kind] += ms;
    }
  }

  let totalHumanMs = 0;
  let totalAgentMs = 0;
  let focusHumanMs = 0;
  const days: DayTime[] = opts.days.map((date) => {
    const tasks = [...(perDay.get(date) ?? new Map<string, TaskDayTime>()).values()]
      // YOUR time first, agent time only as a tiebreaker. Ordering by the SUM put
      // a task the user barely touched at the top because an agent ran on it for
      // hours, and the panel reads top-down as "where my day went" — a reader who
      // takes the first row as their own biggest effort is then simply wrong.
      .sort((a, b) => (b.humanMs - a.humanMs) || (b.agentMs - a.agentMs) || a.taskId.localeCompare(b.taskId));
    let humanMs = 0;
    let agentMs = 0;
    for (const t of tasks) {
      humanMs += t.humanMs;
      agentMs += t.agentMs;
      if (t.focus) focusHumanMs += t.humanMs;
    }
    totalHumanMs += humanMs;
    totalAgentMs += agentMs;
    return { date, humanMs, agentMs, tasks };
  });

  return {
    days,
    today: opts.today,
    focusTaskIds: [...focus],
    focusShare: totalHumanMs > 0 ? focusHumanMs / totalHumanMs : 0,
    totalHumanMs,
    totalAgentMs,
    ...(opts.degraded ? { degraded: true } : {}),
  };
}
