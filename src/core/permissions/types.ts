/**
 * Permission Doctor — shared types.
 *
 * Walnut features fail silently when the macOS TCC layer denies access, and
 * WHO must be granted depends on which process macOS holds "responsible"
 * (the top of the launcher chain — Walnut.app, iTerm, launchd — not the node
 * binary that appears in the prompt). These types describe a launcher-aware
 * permission report the UI can turn into a "click here, we verify" flow.
 */

/** Stable ids — new checks register in darwin.ts and reuse this union. */
export type PermissionId = 'calendar' | 'full-disk-access' | 'screen-time';

export type PermissionState =
  /** Grant confirmed by a real probe (not by assuming). */
  | 'granted'
  /** Probe says no. For prompt-capable services this may also mean the user
   *  clicked Don't Allow; the UI copy has to cover both. */
  | 'denied'
  /** Service supports a system prompt and it has never been shown — the
   *  fix is "trigger the prompt", not "dig through System Settings". */
  | 'not-determined'
  /** This host/platform never needs the permission (Linux, cloud replica,
   *  remote daemon). The UI hides these rows entirely. */
  | 'not-applicable'
  /** Probe itself failed (helper missing, timeout). Distinct from denied so
   *  we never tell the user to fix a grant that might already be fine. */
  | 'unknown';

/** How the user gets from "denied" to "granted" for this permission. */
export type PermissionFixKind =
  /** A system dialog can be triggered programmatically (EventKit etc.). */
  | 'prompt'
  /** No prompt exists — the user must flip a switch in System Settings
   *  (Full Disk Access is the canonical case: macOS NEVER prompts for it). */
  | 'settings-only';

export interface PermissionStatus {
  id: PermissionId;
  /** Human name for UI rows ("Calendar", "Full Disk Access"). */
  label: string;
  state: PermissionState;
  fixKind: PermissionFixKind;
  /** What breaks without it — shown under the row so the user can decide
   *  whether they care ("agent sessions hit per-app popups"). */
  why: string;
  /** The identity the user must grant TO. For settings-only fixes this is
   *  what they add in the panel (e.g. /Applications/Walnut.app); surfacing it
   *  is the whole point — users kept granting to "node" and it never worked. */
  grantTarget: string;
  /**
   * True when the grant belongs to a helper that disclaims parent
   * responsibility, so it does NOT depend on how Walnut was started. The UI must
   * then STOP naming the launcher: saying "launched by iTerm2, so macOS checks
   * the grant for walnut-reader" is a non sequitur that makes a correct
   * instruction look wrong, and the launcher sentence exists precisely to be
   * believed.
   */
  launcherIndependent?: boolean;
  /** x-apple.systempreferences deep link opened by the fix endpoint. */
  settingsUrl: string;
  /** Short numbered steps rendered inside the fix dialog. */
  steps: string[];
  /**
   * Set when the grant EXISTS in System Settings but no longer applies, which
   * happens to an ad-hoc signed helper whenever it is rebuilt: TCC keyed the
   * grant to the old content hash, yet the panel still shows the row with its
   * toggle on. It is the one denial the user cannot fix by following the
   * ordinary "add it" steps, and toggling off/on does not work either — the row
   * has to be removed with MINUS and added again with PLUS. The UI needs the
   * flag to lead with "re-add" instead of "add", because a user staring at an
   * enabled toggle will otherwise assume our probe is broken.
   */
  staleGrant?: boolean;
}

export interface LauncherInfo {
  /** 'mac-app' when spawned by Walnut.app (WALNUT_LAUNCHER env), else a
   *  best-effort parent-process name ('iTerm2', 'launchd', 'terminal'). */
  kind: 'mac-app' | 'terminal' | 'launchd' | 'unknown';
  /** Display name of the responsible app the user would recognize. */
  name: string;
}

export interface PermissionsReport {
  platform: NodeJS.Platform;
  /** True on the Mac primary; cloud replica reports everything n/a. */
  applicable: boolean;
  launcher: LauncherInfo;
  permissions: PermissionStatus[];
  /** Ms-since-epoch when the probes actually ran (report may be cached). */
  probedAt: number;
}
