import { apiGet, apiPost, apiPut, apiDelete } from './client';
import { DISPLAY_RETIRED_PIN_TIERS, OFFERED_PIN_TIER_POLICY, displayPinTier } from '@open-walnut/core';

/** Built-in tiers the board draws and offers. Custom tiers (a plugin's, such as a
 *  Virtual Teammate's, included) are ids of the form `ct_<8 chars>`. */
export type BuiltinTier = 'focus' | 'satellite';
export const BUILTIN_TIERS: readonly BuiltinTier[] = ['focus', 'satellite'];

/**
 * Built-in tier ids the board no longer draws or offers (2026-11-11, the user: "just have 2
 * focus, satellite, remove park"): Parked (`wait`) and Backlog, which the server folds into
 * `wait`. One definition, the core's DISPLAY_RETIRED_PIN_TIERS. The server still stores and
 * accepts them, so an older client, the phone app, a plugin or an agent may keep writing them;
 * every web surface shows such a task in Satellite (`shownTier`) and offers neither. This is the
 * WAITING phase's neighbour by name only: nothing here reads or changes a task's phase.
 */
export const RETIRED_TIERS: ReadonlySet<string> = DISPLAY_RETIRED_PIN_TIERS;

export function isRetiredTier(tier: string | null | undefined): boolean {
  return !!tier && RETIRED_TIERS.has(tier);
}

/** The tier a stored or proposed tier value is drawn in: a retired one reads Satellite. */
export const shownTier = displayPinTier;

/** The built-in tiers' policy lines (label, guidance) as the board offers them. */
export const BOARD_TIER_POLICY = OFFERED_PIN_TIER_POLICY;

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
  /** Retired tier: always empty from a current server, folded into wait_tasks. */
  backlog_tasks?: string[];
  /** Tasks stored in the retired Parked tier (`wait`). Still on the wire for older clients;
   *  the web keeps the stored value and draws them in Satellite (RETIRED_TIERS). */
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

/** One task's batch outcome when it could not be applied ('not_found', 'complete', …). */
export interface PinBatchFailure { id: string; ok: false; error: string }

/**
 * Pin many tasks into ONE tier (pinning the unpinned ones at the bottom), or unpin
 * them all with `tier: null`, in one request and one store write. The response
 * carries the full tier split, like every other focus write.
 */
export async function setTierBulk(
  taskIds: string[],
  tier: FocusTier | null,
): Promise<FocusBarData & { changed: string[]; failed: PinBatchFailure[] }> {
  return apiPost('/api/focus/batch', { task_ids: taskIds, tier });
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
