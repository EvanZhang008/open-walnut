/**
 * Time tracking — shared shapes for the two clocks kept per task per day.
 *
 * HUMAN time comes from the browser: a real interaction signal grants a lease
 * on exactly one context, and the client banks closed lease windows as samples.
 * AGENT time is derived server-side from session turn results — never from
 * browser instrumentation.
 *
 * Day keys are LOCAL dates (the user means "my Tuesday"), unlike the usage
 * ledger whose `date` column is UTC. Anything joined from that ledger is
 * therefore approximate at day edges; see agent-time.ts.
 */

export const HUMAN_KINDS = ['session', 'triage', 'chat'] as const;
export type HumanKind = (typeof HUMAN_KINDS)[number];

/**
 * The three human contexts plus the derived agent lane — the ONE list of lanes.
 * Everything that has to enumerate them (the sample validator, the block fold's
 * "is this a real kind", the route's `kinds=` parser) reads it from here, so a
 * fifth lane cannot be half-added.
 */
export const TIME_KINDS = [...HUMAN_KINDS, 'agent'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

/**
 * WHICH CLIENT banked a human sample. ABSENT MEANS 'web' everywhere — that is
 * what keeps every day file written before this field existed (and every sample
 * the browser posts today) parsing and folding byte-identically. 'web' is
 * therefore normalized back to absent on the way in, so there is exactly one
 * on-disk encoding for browser time.
 *
 * Never applies to the `agent` lane: agent time is derived server-side.
 */
export const TIME_SOURCES = ['web', 'ios'] as const;
export type TimeSource = (typeof TIME_SOURCES)[number];

/** What a client posts. `ts` is the START of the counted window. */
export interface HeartbeatSample {
  /**
   * Optional client-minted dedupe key (`<installId>-<seq>`, ≤64 chars). Every ack
   * can be lost (a suspended background flush, a client timeout, a dropped
   * connection), so the client retries and the server skips ids it has already
   * accepted. INGEST-ONLY: it is never copied into TimeRecord and never written to
   * a day file, which keeps the JSONL exactly the shape older builds wrote.
   */
  id?: string;
  ts: string;
  durationMs: number;
  kind: HumanKind;
  taskId?: string;
  sessionId?: string;
  /** Absent = 'web' (the browser). */
  source?: TimeSource;
}

/** A validated, day-keyed record — the JSONL line shape and the fold input. */
export interface TimeRecord {
  /**
   * Local YYYY-MM-DD. Assigned server-side from `ts` for human samples; for an
   * agent turn it is the day the result ARRIVED, which can differ from `ts` by
   * the length of a turn that straddled midnight.
   */
  date: string;
  /**
   * START of the counted window, for every kind — an agent turn is therefore
   * stamped `durationMs` before the result arrived. `[ts, ts + durationMs)` is
   * the interval the day timeline draws (blocks.ts).
   */
  ts: string;
  durationMs: number;
  kind: TimeKind;
  taskId?: string;
  sessionId?: string;
  /** Absent = 'web'. Only ever set on a human record (see TIME_SOURCES). */
  source?: TimeSource;
}

/** Per (date, taskId, kind[, source]) accumulated milliseconds. Key via bucketKey(). */
export type RollupIndex = Map<string, number>;

export interface TaskDayTime {
  /** '' = no task (Inbox / taskless session / main-agent chat). */
  taskId: string;
  humanMs: number;
  byKind: Record<HumanKind, number>;
  agentMs: number;
  /** True when the task is currently pinned to the focus tier. */
  focus: boolean;
}

export interface DayTime {
  date: string;
  humanMs: number;
  agentMs: number;
  /**
   * The part of `humanMs` banked from the iOS app. Present only when > 0, so a
   * day with no phone time serializes exactly as it did before this field.
   * Deliberately day-level only: per-task rows aggregate ACROSS sources (see
   * TaskDayTime) because "how long did I spend on this task" must not depend on
   * which screen the user held.
   */
  iosMs?: number;
  tasks: TaskDayTime[];
}

export interface TimeSummary {
  /** Ascending by date, one entry per requested day (zeros included). */
  days: DayTime[];
  /** Local date key the server considers "today". */
  today: string;
  focusTaskIds: string[];
  /** Human ms on focus-tier tasks / total human ms in the window. 0 when empty. */
  focusShare: number;
  totalHumanMs: number;
  totalAgentMs: number;
  /** Sum of the days' `iosMs`. Present only when > 0 (same rule as DayTime). */
  totalIosMs?: number;
  /** True when part of the answer could not be produced in time. */
  degraded?: boolean;
}
