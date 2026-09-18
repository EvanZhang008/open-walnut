/**
 * Permission Doctor API client — macOS TCC health + guided fixes.
 * Mirrors src/core/permissions/types.ts (keep the unions in sync by hand;
 * the shapes are small and a shared package isn't worth the build coupling).
 */
import { apiGet, apiPost } from './client';

/** One id per GRANT, never per feature: Full Disk Access is a single row
 *  covering every feature that reads through the shared helper. */
export type PermissionId = 'calendar' | 'full-disk-access' | 'session-full-disk-access';

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'not-applicable' | 'unknown';

/** Mirror of the server's PermissionStep: a step can carry its own control. */
export type PermissionStep = string | { text: string; open?: true; copy?: string };

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
  steps: PermissionStep[];
  /** The grant is IN System Settings with its toggle on, but keyed to an older
   *  build of the helper, so it no longer applies. Only a remove-and-re-add
   *  fixes it; toggling does nothing. The UI must say "re-add", not "add". */
  staleGrant?: boolean;
  /** The feature works even though this reads as denied, naming what stands in
   *  (e.g. "an older copy of the helper (v4)"). Saying "not granted" beside a
   *  calendar full of events reads as a broken probe. */
  workingVia?: string;
  /** macOS offers no way to read this grant back, only to ask for it. */
  unverifiable?: boolean;
  /** Guidance for the dialog only: why this exists and what skipping it costs.
   *  Never rendered in the row — `why` is the one line the list shows. */
  context?: string;
  /** Nothing breaks without it: the UI offers "Set up" rather than "Fix", and
   *  never says "needs permission". Not the same fact as `unverifiable`. */
  optional?: boolean;
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
