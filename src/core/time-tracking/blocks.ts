/**
 * Time tracking — PURE fold from a day's records to display BLOCKS. No fs, no
 * clock, no imports from the app, so the whole day-timeline contract is unit
 * testable.
 *
 * The rollup answers "how much"; this answers "when". A day file holds one
 * record per banked lease window (human) or per finished turn (agent), which is
 * far too granular to draw: a morning of work is ~40 back-to-back 60s windows.
 * So records of the SAME (taskId, kind) that sit within MERGE_GAP_MS of each
 * other become one block, and anything still shorter than MIN_BLOCK_MS is
 * dropped from the picture.
 *
 * TWO DURATIONS, on purpose. `ms` is the block's WALL SPAN (endTs - startTs) —
 * that is what its length on the timeline means. `trackedMs` is the recorded
 * time inside it, which is smaller whenever the merge bridged a gap. Publishing
 * only the span would make the timeline visibly disagree with the totals in the
 * other tabs, and "these numbers contradict each other" is exactly the reaction
 * this feature area has already been burned by.
 *
 * NOTHING IS SILENTLY LOST, and the two reasons are reported SEPARATELY because
 * they mean different things to a reader: `shortMs` is real work too short to
 * draw, `foldedMs` is time whose interval no longer exists at all (a compacted
 * day, a record outside the day). One number covering both produced a caption
 * ("too short or too folded to place here") that meant nothing to anyone.
 *
 * TWO FOLDS, because the two questions are different:
 *
 *   foldDayBlocks  — per (task, kind), merged over gaps up to MERGE_GAP_MS. Answers
 *                    "when was this TASK touched", so one task's blocks never
 *                    overlap each other, but two tasks' blocks freely do.
 *   foldDaySlices  — ONE serial ribbon of the whole day. Answers "what was I doing
 *                    at 14:07", which has exactly one answer, so the output is
 *                    non-overlapping by construction and only ADJACENT same-task
 *                    records join.
 *
 * The second exists because the first, drawn as a chart, manufactures overlap that
 * never happened: merging bridges a five-minute gap in task A, task B's real work
 * sits inside that gap, and a lane packer then draws them side by side as if the
 * user did two things at once. Human attention is serial; a view that implies
 * parallelism is lying about the data.
 *
 * Day keys are LOCAL dates, matching the rest of time-tracking.
 */

import type { TimeKind, TimeRecord } from './types.js';

/**
 * The four real lanes. A record with any other kind is a malformed line (a
 * hand-edited JSONL, an id that smuggled a separator past an older build), and
 * summarize() already drops it from the totals — so it is skipped SILENTLY here
 * rather than counted as unplaced, which would claim it is in a total it is not.
 */
const KINDS = new Set<string>(['session', 'triage', 'chat', 'agent']);

/** Records of one (task, kind) closer than this become a single block. */
export const MERGE_GAP_MS = 5 * 60 * 1000;
/**
 * Floor for a drawn block. Deliberately LOW: on a real 75-minute day, 23 minutes
 * of it arrived as sub-minute touches, and a 60s floor made a third of the day
 * invisible. Short work is real work — it draws, as a tick.
 */
export const MIN_BLOCK_MS = 30 * 1000;
/**
 * Serial mode: two slices join only if they are ADJACENT in time (nothing else in
 * between) and no further apart than this. Sized to bridge heartbeat jitter and one
 * missed beat, not a real pause: at 90s a genuine switch away and back still reads
 * as two segments, which is the whole point of the serial view.
 */
export const SLICE_JOIN_GAP_MS = 90 * 1000;

export interface TimeBlock {
  /** '' = no task (Inbox / taskless session / main-agent chat). */
  taskId: string;
  kind: TimeKind;
  startTs: string;
  endTs: string;
  /** Wall span: endTs - startTs. The block's LENGTH means this. */
  ms: number;
  /** Recorded time inside the span. Equals `ms` unless a gap was merged over. */
  trackedMs: number;
}

export interface TaskTotal {
  taskId: string;
  /** Every recorded ms of this task in the day, drawn or not. */
  ms: number;
}

export interface DayBlocks {
  date: string;
  /** Ascending by start. Never overlapping within one (taskId, kind). */
  blocks: TimeBlock[];
  /** Tracked ms dropped for being shorter than MIN_BLOCK_MS. */
  shortMs: number;
  /** Tracked ms with no drawable interval: a compacted day, or outside the day. */
  foldedMs: number;
  /**
   * Per-task HUMAN time for the day, descending — including work too short to
   * draw. A ranked "where it went" list must be complete, so it cannot be summed
   * from `blocks`; these numbers also match what the other tabs report.
   */
  totals: TaskTotal[];
  /** Agent runtime in the day, kept out of `totals` so it can never be summed in. */
  agentTotalMs: number;
  /**
   * Serial mode only: tracked ms fully swallowed by an earlier slice. Non-zero only
   * when two leases really did run at once (two windows, two devices).
   */
  overlapMs?: number;
}

/**
 * Local midnight bounds of a YYYY-MM-DD, or null when it is not a real date.
 *
 * Whole-day arithmetic through Date fields, never `+ 86_400_000`: a DST day is
 * 23 or 25 hours long, and a fixed 24h window would clip an hour of a real
 * evening off one day a year.
 */
export function dayBoundsMs(date: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  // Date rolls 2026-02-31 forward to March; compare the fields back to reject it.
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  const end = new Date(y, mo - 1, d + 1, 0, 0, 0, 0);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

interface Span {
  startMs: number;
  endMs: number;
  trackedMs: number;
}

interface TaggedSpan extends Span {
  taskId: string;
  kind: TimeKind;
}

interface Collected {
  spans: TaggedSpan[];
  foldedMs: number;
  /** taskId → human ms. Insertion order is irrelevant; the caller sorts. */
  totals: Map<string, number>;
  agentTotalMs: number;
}

/**
 * Records → day-clipped spans, shared by both folds.
 *
 * Everything either becomes a span or is accounted for in `foldedMs`, except a
 * malformed KIND, which is skipped silently: summarize() already drops it from the
 * totals, so reporting it as unplaced would claim it is in a total it is not.
 */
function collectSpans(
  records: Iterable<TimeRecord>,
  opts: { date: string; kinds?: readonly TimeKind[] },
  bounds: { startMs: number; endMs: number },
): Collected {
  const wanted = opts.kinds && opts.kinds.length > 0 ? new Set<string>(opts.kinds) : null;
  /**
   * The line shape a compacted day collapses to (store.ts compactDay): one record
   * per (task, kind) carrying the day's TOTAL, stamped at UTC midnight of the date.
   * It has no interval left, so it can never become a block — its time is reported
   * as unplaced instead of being drawn at an invented hour.
   */
  const compactedTs = `${opts.date}T00:00:00.000Z`;
  const out: Collected = { spans: [], foldedMs: 0, totals: new Map(), agentTotalMs: 0 };

  for (const rec of records) {
    if (!(rec.durationMs > 0)) continue;
    if (!KINDS.has(rec.kind)) continue;
    if (wanted && !wanted.has(rec.kind)) continue;
    if (rec.ts === compactedTs) {
      out.foldedMs += rec.durationMs;
      continue;
    }
    const startedMs = Date.parse(rec.ts);
    if (!Number.isFinite(startedMs)) {
      out.foldedMs += rec.durationMs;
      continue;
    }
    // Clip to the day. A window that straddles midnight keeps only its share: the
    // other half belongs to the neighbouring day's timeline, not to this one.
    const startMs = Math.max(startedMs, bounds.startMs);
    const endMs = Math.min(startedMs + rec.durationMs, bounds.endMs);
    if (endMs <= startMs) {
      out.foldedMs += rec.durationMs;
      continue;
    }
    const taskId = rec.taskId ?? '';
    const trackedMs = endMs - startMs;
    // Totals count every clipped ms, drawn or not, so a ranked list is complete.
    if (rec.kind === 'agent') out.agentTotalMs += trackedMs;
    else out.totals.set(taskId, (out.totals.get(taskId) ?? 0) + trackedMs);
    out.spans.push({ taskId, kind: rec.kind, startMs, endMs, trackedMs });
  }
  return out;
}

/** Descending by time, then by id so equal totals never reorder between reads. */
function rankTotals(totals: Map<string, number>): TaskTotal[] {
  return [...totals].map(([taskId, ms]) => ({ taskId, ms }))
    .sort((a, b) => b.ms - a.ms || a.taskId.localeCompare(b.taskId));
}

function emptyDay(date: string): DayBlocks {
  return { date, blocks: [], shortMs: 0, foldedMs: 0, totals: [], agentTotalMs: 0 };
}

function toBlock(span: TaggedSpan): TimeBlock {
  const ms = span.endMs - span.startMs;
  return {
    taskId: span.taskId,
    kind: span.kind,
    startTs: new Date(span.startMs).toISOString(),
    endTs: new Date(span.endMs).toISOString(),
    ms,
    // Overlapping records of one (task, kind) would sum past the span they share;
    // capping keeps "tracked" from ever exceeding the block drawn.
    trackedMs: Math.min(span.trackedMs, ms),
  };
}

/**
 * Fold one day's records into PER-TASK blocks (the swimlane view's input).
 *
 * `kinds` (when given and non-empty) filters BEFORE the merge. Kinds never merge
 * with each other anyway — the grouping is per kind and then per task, which is
 * what keeps your own time and an agent's runtime from ever sharing a rectangle.
 */
export function foldDayBlocks(
  records: Iterable<TimeRecord>,
  opts: { date: string; kinds?: readonly TimeKind[] },
): DayBlocks {
  const bounds = dayBoundsMs(opts.date);
  if (!bounds) return emptyDay(opts.date);
  const collected = collectSpans(records, opts, bounds);

  // kind → taskId → spans. Nested rather than one composite key: a taskId written
  // by an older build can contain anything, and a joined key would need a separator
  // that such an id could smuggle (the bug parseBucketKey now guards).
  const groups = new Map<TimeKind, Map<string, TaggedSpan[]>>();
  for (const span of collected.spans) {
    let byTask = groups.get(span.kind);
    if (!byTask) {
      byTask = new Map();
      groups.set(span.kind, byTask);
    }
    const list = byTask.get(span.taskId);
    if (list) list.push(span);
    else byTask.set(span.taskId, [span]);
  }

  const blocks: TimeBlock[] = [];
  let shortMs = 0;
  for (const byTask of groups.values()) {
    for (const spans of byTask.values()) {
      spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

      const merged: TaggedSpan[] = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span.startMs - last.endMs <= MERGE_GAP_MS) {
          last.endMs = Math.max(last.endMs, span.endMs);
          last.trackedMs += span.trackedMs;
        } else {
          merged.push({ ...span });
        }
      }

      for (const span of merged) {
        if (span.endMs - span.startMs < MIN_BLOCK_MS) {
          shortMs += span.trackedMs;
          continue;
        }
        blocks.push(toBlock(span));
      }
    }
  }

  blocks.sort((a, b) =>
    a.startTs.localeCompare(b.startTs) || a.kind.localeCompare(b.kind) || a.taskId.localeCompare(b.taskId));
  return {
    date: opts.date,
    blocks,
    shortMs,
    foldedMs: collected.foldedMs,
    totals: rankTotals(collected.totals),
    agentTotalMs: collected.agentTotalMs,
  };
}

/**
 * Fold one day's records into ONE SERIAL RIBBON — the attention tape's input.
 *
 * Three rules, and every one of them exists to keep the output honest about a
 * single-threaded human:
 *
 * 1. NON-OVERLAPPING BY CONSTRUCTION. Slices are laid down in time order behind a
 *    cursor; a later start is pulled forward to the cursor rather than drawn over
 *    what is already there. Concurrency is possible in the DATA (two windows, two
 *    devices) but not in the answer to "what was I doing at 14:07", so a fully
 *    swallowed record is reported in `overlapMs` instead of silently vanishing.
 * 2. ONLY ADJACENT SAME-TASK RECORDS JOIN. Not "same task within five minutes":
 *    if another task's work sits between two touches of this one, the switch really
 *    happened and the ribbon must show it.
 * 3. Sub-floor slices are dropped into `shortMs` AFTER joining, never before —
 *    dropping first would let two segments fuse across a real (if tiny) switch.
 */
export function foldDaySlices(
  records: Iterable<TimeRecord>,
  opts: { date: string; kinds?: readonly TimeKind[] },
): DayBlocks {
  const bounds = dayBoundsMs(opts.date);
  if (!bounds) return emptyDay(opts.date);
  const collected = collectSpans(records, opts, bounds);

  // Earliest first; a tie breaks toward the LONGER span so the dominant activity
  // owns the interval and the shorter one is what gets clipped.
  const spans = collected.spans.slice()
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs || a.taskId.localeCompare(b.taskId));

  const serial: TaggedSpan[] = [];
  let overlapMs = 0;
  let cursor = -Infinity;
  for (const span of spans) {
    const startMs = Math.max(span.startMs, cursor);
    if (startMs >= span.endMs) {
      overlapMs += span.trackedMs;
      continue;
    }
    const clipped: TaggedSpan = {
      ...span,
      startMs,
      // The clipped-away head was someone else's wall time, so it is no longer
      // this slice's tracked time either.
      trackedMs: Math.min(span.trackedMs, span.endMs - startMs),
    };
    const last = serial[serial.length - 1];
    if (last
      && last.taskId === clipped.taskId
      && last.kind === clipped.kind
      && clipped.startMs - last.endMs <= SLICE_JOIN_GAP_MS) {
      last.endMs = clipped.endMs;
      last.trackedMs += clipped.trackedMs;
    } else {
      serial.push(clipped);
    }
    cursor = clipped.endMs;
  }

  const blocks: TimeBlock[] = [];
  let shortMs = 0;
  for (const span of serial) {
    if (span.endMs - span.startMs < MIN_BLOCK_MS) {
      shortMs += span.trackedMs;
      continue;
    }
    blocks.push(toBlock(span));
  }

  return {
    date: opts.date,
    blocks,
    shortMs,
    foldedMs: collected.foldedMs,
    totals: rankTotals(collected.totals),
    agentTotalMs: collected.agentTotalMs,
    overlapMs,
  };
}
