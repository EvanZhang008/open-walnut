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

/** The three human contexts plus the derived agent lane. */
export type TimeKind = 'session' | 'triage' | 'chat' | 'agent';

export const HUMAN_KINDS = ['session', 'triage', 'chat'] as const;
export type HumanKind = (typeof HUMAN_KINDS)[number];

/** What the browser posts. `ts` is the START of the counted window. */
export interface HeartbeatSample {
  ts: string;
  durationMs: number;
  kind: HumanKind;
  taskId?: string;
  sessionId?: string;
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
}

/** Per (date, taskId, kind) accumulated milliseconds. Key via bucketKey(). */
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
  /** True when part of the answer could not be produced in time. */
  degraded?: boolean;
}
