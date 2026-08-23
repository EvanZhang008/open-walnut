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

export interface DayBlocks {
  date: string;
  blocks: TimeBlock[];
  /** Tracked ms this day that no block could carry (compacted / out of range). */
  unplacedMs: number;
  /** taskId → title, joined server-side. Missing = unknown or deleted task. */
  titles: Record<string, string>;
  degraded?: boolean;
}

/** One day as intervals. `kinds` empty/omitted = every kind. */
export function fetchTimeBlocks(date: string, kinds?: readonly TimeKind[]): Promise<DayBlocks> {
  const params: Record<string, string> = { date };
  if (kinds && kinds.length > 0) params.kinds = kinds.join(',');
  return apiGet<DayBlocks>('/api/time/blocks', params, { timeoutMs: 10_000 });
}
