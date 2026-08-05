import { apiGet, apiPost, apiPut, apiDelete } from './client';

/** Built-in tiers. Custom tiers are ids of the form `ct_<8 chars>`. */
export type BuiltinTier = 'focus' | 'satellite' | 'backlog' | 'wait';
export const BUILTIN_TIERS: readonly BuiltinTier[] = ['focus', 'satellite', 'backlog', 'wait'];

/**
 * A tier is a built-in name or a custom tier id. The `string & {}` arm keeps
 * ct_* ids assignable (so the drag/render machinery treats built-ins and
 * customs uniformly) while preserving IDE autocomplete for the built-in
 * literals; use isBuiltinTier() where the distinction matters at runtime
 * (icons, colors, policy text).
 */
export type FocusTier = BuiltinTier | (string & {});

export function isBuiltinTier(tier: string): tier is BuiltinTier {
  return (BUILTIN_TIERS as readonly string[]).includes(tier);
}

/** User-defined tier from the registry (Settings → Focus Tiers). */
export interface CustomTierDef {
  id: string;
  label: string;
}

export interface FocusBarData {
  pinned_tasks: string[];
  focus_tasks: string[];
  satellite_tasks: string[];
  /** Absent on servers older than the built-in Backlog tier (2026-08). */
  backlog_tasks?: string[];
  wait_tasks: string[];
  /** Per custom-tier-id pinned task ids (pin order). Absent on old servers. */
  custom_tier_tasks?: Record<string, string[]>;
}

export async function fetchPinnedTasks(): Promise<FocusBarData> {
  return apiGet<FocusBarData>('/api/focus/tasks');
}

export async function pinTask(taskId: string): Promise<FocusBarData> {
  return apiPost<FocusBarData>(`/api/focus/tasks/${encodeURIComponent(taskId)}`);
}

export async function unpinTask(taskId: string): Promise<FocusBarData> {
  return apiDelete<FocusBarData>(`/api/focus/tasks/${encodeURIComponent(taskId)}`);
}

export async function reorderPinnedTasks(taskIds: string[]): Promise<FocusBarData> {
  return apiPut<FocusBarData>('/api/focus/reorder', { task_ids: taskIds });
}

export async function setTaskTier(taskId: string, tier: FocusTier): Promise<FocusBarData> {
  return apiPut<FocusBarData>(
    `/api/focus/tasks/${encodeURIComponent(taskId)}/tier`,
    { tier },
  );
}

// ── Custom tier registry ──

export async function fetchCustomTiers(): Promise<{ tiers: CustomTierDef[] }> {
  return apiGet<{ tiers: CustomTierDef[] }>('/api/focus/tiers');
}

export async function createCustomTier(label: string): Promise<{ tier: CustomTierDef; tiers: CustomTierDef[] }> {
  return apiPost<{ tier: CustomTierDef; tiers: CustomTierDef[] }>('/api/focus/tiers', { label });
}

export async function renameCustomTier(id: string, label: string): Promise<{ tier: CustomTierDef; tiers: CustomTierDef[] }> {
  return apiPut<{ tier: CustomTierDef; tiers: CustomTierDef[] }>(`/api/focus/tiers/${encodeURIComponent(id)}`, { label });
}

export async function deleteCustomTier(id: string): Promise<{ tiers: CustomTierDef[]; moved: number }> {
  // Typed response works only because the server answers 200 + body (never 204).
  return apiDelete<{ tiers: CustomTierDef[]; moved: number }>(`/api/focus/tiers/${encodeURIComponent(id)}`);
}
