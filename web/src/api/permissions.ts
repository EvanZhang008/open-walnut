/**
 * Permission Doctor API client — macOS TCC health + guided fixes.
 * Mirrors src/core/permissions/types.ts (keep the unions in sync by hand;
 * the shapes are small and a shared package isn't worth the build coupling).
 */
import { apiGet, apiPost } from './client';

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
  settingsUrl: string;
  steps: string[];
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
