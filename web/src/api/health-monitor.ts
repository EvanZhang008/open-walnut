/**
 * Walnut's own health alarms (server: src/core/health-monitor/, routes
 * src/web/routes/health-monitor-v1.ts), read by Settings > Walnut Health.
 */
import { apiGet, apiPatch, apiPut } from './client';

export type AlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

export interface AlarmAction { at: number; kind: 'auto-fix' | 'fix-task' | 'notify'; ok: boolean; detail: string; taskId?: string; started?: boolean }
export interface AlarmOverride { threshold?: number; enabled?: boolean; mutedUntil?: number; ownerTask?: string; by: string; at: number }

export type FixTasksMode = 'record' | 'start' | 'off';

export interface AlarmRow {
  id: string;
  defId: string;
  title: string;
  description: string;
  state: AlarmState;
  since: number;
  value: number | null;
  unit: string;
  condition: string;
  labels?: Record<string, string>;
  signature?: string;
  spark: Array<number | null>;
  actions: AlarmAction[];
  fixTaskId?: string;
  override?: AlarmOverride;
  held: boolean;
}

export interface HealthView {
  checkedAt: number;
  actions: boolean;
  counts: Record<AlarmState, number>;
  fixesToday: number;
  fixesPerDay: number;
  /** What an alarm that needs a fix does (config health_monitor.fix_tasks). */
  fixTasks?: FixTasksMode;
  alarms: AlarmRow[];
}

export interface AlarmDetail extends AlarmRow {
  history: Array<{ at: number; from: AlarmState; to: AlarmState; value: number | null; reason: string }>;
  series: Array<{ t: number; v: number | null }>;
  sample?: string;
}

export function fetchHealth(): Promise<HealthView> {
  return apiGet<HealthView>('/api/v1/health-monitor', undefined, { quietStatuses: [503] });
}

export function fetchAlarm(id: string): Promise<AlarmDetail> {
  return apiGet<AlarmDetail>(`/api/v1/health-monitor/alarms/${encodeURIComponent(id)}`);
}

export function changeAlarm(id: string, body: { enabled?: boolean; muted_for?: string; muted_until?: string | null; threshold?: number | null }): Promise<unknown> {
  return apiPatch(`/api/v1/health-monitor/alarms/${encodeURIComponent(id)}`, body);
}

export function setFixTasks(mode: FixTasksMode): Promise<{ fixTasks: FixTasksMode }> {
  return apiPut('/api/v1/health-monitor/settings', { fix_tasks: mode });
}
