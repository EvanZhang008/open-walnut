/**
 * Permission Doctor API client — macOS TCC health + guided fixes.
 * Mirrors src/core/permissions/types.ts (keep the unions in sync by hand;
 * the shapes are small and a shared package isn't worth the build coupling).
 */
import { apiGet, apiPost } from './client';

/** One id per GRANT, never per feature: Full Disk Access is a single row
 *  covering every feature that reads through the shared helper. */
export type PermissionId = 'calendar' | 'full-disk-access';

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'not-applicable' | 'unknown';

export interface PermissionStatus {
  id: PermissionId;
  label: string;
  state: PermissionState;
  /** 'prompt' → show a Request-access button; 'settings-only' → open Settings. */
  fixKind: 'prompt' | 'settings-only';
  why: string;
  /** The identity to grant TO (e.g. /Applications/Walnut.app) — the single
   *  most important line in the dialog; users granting to the wrong identity
   *  ("node") is how the calendar broke invisibly. */
  grantTarget: string;
  /** The grant belongs to a self-responsible helper, so it does NOT depend on
   *  the launcher — the UI must not name the launcher for these rows. */
  launcherIndependent?: boolean;
  settingsUrl: string;
  steps: string[];
  /** The grant is IN System Settings with its toggle on, but keyed to an older
   *  build of the helper, so it no longer applies. Only a remove-and-re-add
   *  fixes it; toggling does nothing. The UI must say "re-add", not "add". */
  staleGrant?: boolean;
}

export interface PermissionsReport {
  platform: string;
  /** False off-macOS/cloud — hide all permission UI entirely. */
  applicable: boolean;
  launcher: { kind: 'mac-app' | 'terminal' | 'launchd' | 'unknown'; name: string };
  permissions: PermissionStatus[];
  probedAt: number;
}

/** force=true bypasses the server's 30s cache — used by the verify poll. */
export async function getPermissions(force = false) {
  return apiGet<PermissionsReport>('/api/permissions', force ? { force: '1' } : undefined);
}

/** Opens the matching System Settings pane on the Mac (works from any client). */
export async function openPermissionSettings(id: PermissionId) {
  return apiPost<{ ok: boolean }>(`/api/permissions/${id}/open-settings`);
}

/** Triggers the one-time system prompt (calendar only). Resolves after the
 *  user answers, with the resulting state. */
export async function requestPermission(id: PermissionId) {
  return apiPost<{ state: 'granted' | 'denied' | 'unknown' }>(`/api/permissions/${id}/request`);
}
