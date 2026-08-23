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
