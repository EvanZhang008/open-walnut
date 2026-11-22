/**
 * The real-use monitor (server: src/core/usage-watch/, route src/web/routes/usage-watch-v1.ts),
 * read by Settings > Real Use: every tool, request and page error kind with its totals, its line
 * per day and its alarm; the watches of shipped changes; the notes sent to tasks. Only names,
 * sizes, times and error codes, never what was sent or answered.
 */
import { apiGet } from './client';

export type UsageRange = '24h' | '7d';
export type UsageKind = 'op' | 'http' | 'page';
export type UsageAlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

/** The worst Walnut Health alarm on one row, and the last thing Walnut did about it. */
export interface UsageRowAlarm { id: string; state: UsageAlarmState; since: number; did?: string }

export interface UsageRow {
  kind: UsageKind;
  name: string;
  calls: number;
  fails: number;
  refused: number;
  badArgs: number;
  errors: number;
  timeouts: number;
  unreachable: number;
  cut: number;
  overLimit: number;
  spilled: number;
  over10k: number;
  sizeP50: number | null;
  sizeP95: number | null;
  largest: number;
  slow: number;
  serverErrors: number;
  msP95: number | null;
  codes: Record<string, number>;
  /** One point per day (7 days) or per 4 hours (24 hours): uses, and the problems that count for the kind. */
  series: Array<{ at: number; uses: number; bad: number }>;
  alarm: UsageRowAlarm | null;
}

export interface UsageWatchChecks {
  max_answer_chars?: number;
  max_fail_pct?: number;
  no_new_codes?: boolean;
  max_p95_ms?: number;
  min_uses?: number;
}

export type UsageWatchState = 'watching' | 'passed' | 'failed' | 'too_little_use' | 'unknown' | 'dropped' | 'exempt' | 'unwatched';

export interface UsageTargetResult {
  target: string;
  uses: number;
  ok: boolean;
  notes: string[];
  largest?: number;
  failPct?: number;
  p95Ms?: number;
  newCodes?: string[];
  cut?: number;
}

export interface UsageWatch {
  id: string;
  taskId: string;
  taskTitle: string | null;
  targets: string[];
  checks: UsageWatchChecks;
  /** `this task`, or the id of another open task that watches it. */
  who: string;
  triggerId?: string;
  createdAt: number;
  shipAt?: number;
  checkAt: number;
  extended: boolean;
  state: UsageWatchState;
  checkedAt?: number;
  result?: UsageTargetResult[];
  told?: string;
  by?: string;
  exempt?: { kind: string; reason: string };
}

/** One note to a task (alarms of one day, batched). */
export interface UsageNote {
  id: string;
  recipient: string;
  /** The recipient task's title, when it still exists. */
  recipientTitle?: string | null;
  day: string;
  seq: number;
  dueAt: number;
  items: number;
  titles: string[];
  state: 'pending' | 'sent' | 'failed';
  tries: number;
  sentAt?: number;
  detail?: string;
}

export interface UsageWatchView {
  range: UsageRange;
  from: number;
  to: number;
  /** Share of the range's minutes this server recorded, 0 to 1. */
  recorded: number;
  firstHour: number | null;
  rows: UsageRow[];
  watches: UsageWatch[];
  notes: UsageNote[];
  /** The Real-use watch experiment: off means recording only (no alarms, notes or completion check). */
  alarmsOn: boolean;
  now: number;
}

export function fetchUsageWatch(range: UsageRange): Promise<UsageWatchView> {
  return apiGet<UsageWatchView>('/api/v1/usage-watch', { range });
}
