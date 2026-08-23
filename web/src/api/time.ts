import { apiGet } from './client';

export type TimeHumanKind = 'session' | 'triage' | 'chat';

export interface TaskDayTime {
  /** '' = no task (Inbox / taskless session / main-agent chat). */
  taskId: string;
  humanMs: number;
  byKind: Record<TimeHumanKind, number>;
  agentMs: number;
  focus: boolean;
}

export interface DayTime {
  date: string;
  humanMs: number;
  agentMs: number;
  tasks: TaskDayTime[];
}

export interface TimeSummary {
  days: DayTime[];
  today: string;
  focusTaskIds: string[];
  focusShare: number;
  totalHumanMs: number;
  totalAgentMs: number;
  degraded?: boolean;
}

/** One round trip for the whole /time page. */
export function fetchTimeSummary(days: number): Promise<TimeSummary> {
  return apiGet<TimeSummary>('/api/time/summary', { days: String(days) }, { timeoutMs: 10_000 });
}

export type TimeKind = TimeHumanKind | 'agent';

/**
 * One drawn interval on the day timeline. `ms` is the WALL SPAN (what the block's
 * length means); `trackedMs` is the recorded time inside it, which is smaller
 * whenever the server merged over a short gap. Totals must always cite
 * `trackedMs` so the timeline agrees with the other tabs.
 */
export interface TimeBlock {
  /** '' = no task (Inbox / taskless session / main-agent chat). */
  taskId: string;
  kind: TimeKind;
  startTs: string;
  endTs: string;
  ms: number;
  trackedMs: number;
}

export interface TaskTotal {
  taskId: string;
  /** Every recorded ms of this task in the day, including work too short to draw. */
  ms: number;
}

export interface DayBlocks {
  date: string;
  /**
   * In merged mode: one entry per (task, run-of-work), so two tasks' entries can
   * overlap in time. In `raw` mode: ONE serial ribbon, non-overlapping.
   */
  blocks: TimeBlock[];
  /** Tracked ms dropped for being shorter than the server's 30s draw floor. */
  shortMs: number;
  /** Tracked ms with no drawable interval at all (a compacted day). */
  foldedMs: number;
  /** Raw mode only: tracked ms swallowed by an earlier slice (concurrent leases). */
  overlapMs?: number;
  /** Per-task human time, descending, COMPLETE — the ranked list's only honest source. */
  totals: TaskTotal[];
  /** Agent runtime for the day, deliberately outside `totals`. */
  agentTotalMs: number;
  /** taskId → title, joined server-side. Missing = unknown or deleted task. */
  titles: Record<string, string>;
  degraded?: boolean;
  /** Echoed by the server: true when these blocks are the serial ribbon. */
  raw?: boolean;
}

/**
 * One day as intervals. `kinds` empty/omitted = every kind.
 *
 * `raw` asks for the SERIAL ribbon instead of per-task merged blocks. The two are
 * different answers, not two formats of one answer — see the module comment in
 * src/core/time-tracking/blocks.ts.
 */
export function fetchTimeBlocks(
  date: string,
  opts: { kinds?: readonly TimeKind[]; raw?: boolean } = {},
): Promise<DayBlocks> {
  const params: Record<string, string> = { date };
  if (opts.kinds && opts.kinds.length > 0) params.kinds = opts.kinds.join(',');
  if (opts.raw) params.raw = '1';
  return apiGet<DayBlocks>('/api/time/blocks', params, { timeoutMs: 10_000 });
}
