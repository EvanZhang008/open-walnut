/**
 * What the update notice says and offers for the SERVER's own update (the `live`
 * field of GET /api/system/update), kept apart from StaleBuildPill so a test pins
 * every state without a DOM.
 *
 * Precedence in the notice: the Mac app's installed update > the Mac app shell's
 * update > this > the page's own bundle reload. A server older than live
 * self-update sends no `live`, and then this offers nothing (the panel card is
 * where such a server's update lives, as before).
 */
import type { UpdateStatus } from '@/api/update';

/** What the notice's button does: open the command dialog, install now, restart now, or nothing. */
export type ServerPillAction = 'how' | 'install' | 'restart' | null;

export interface ServerPillView {
  /** Stable per release and step, so a × on one step does not hide the next (snooze identity). */
  identity: string;
  /** The `data-status` the notice carries (tests and logs read it). */
  /** `installed`: on disk, but this server cannot restart itself (a restart of Walnut runs it). */
  stage: 'available' | 'updating' | 'ready' | 'installed' | 'restarting' | 'failed';
  heading: string;
  action: ServerPillAction;
  /** The button's words; for a step with no action, the collapsed rail's status word. */
  label: string;
  /** The collapsed rail's word (56px wide). */
  short: string;
  tooltip: string;
  /** The heading's tooltip: the full version (a nightly's display form drops its build stamp). */
  versionTitle: string;
  /** No × while this runs: it ends by itself within seconds. */
  busy: boolean;
  /** Work is under way (installing, restarting): the collapsed rail spins its icon. */
  working: boolean;
}

/**
 * A version as the notice shows it: a nightly's build stamp is noise at 12px in a
 * 220px rail ("0.6.25-nightly.20261103.9000002" -> "0.6.25 nightly"). Every server
 * heading goes through this; the full version rides the tooltip.
 */
export function displayVersion(v: string): string {
  const m = /^v?(\d+\.\d+\.\d+)-nightly(?:[.+-].*)?$/.exec(v.trim());
  return m ? `${m[1]} nightly` : v;
}

/** The collapsed rail's word while work runs: it fits the 56px rail beside the spinning icon. */
export const WORKING_SHORT = 'Wait';

export const RESTART_TOOLTIP = 'Restarts by itself once you have been away 10 minutes';

export function serverPillView(s: UpdateStatus | null): ServerPillView | null {
  const live = s?.live;
  if (!s || !live || !s.enabled) return null;
  const version = live.version ?? s.latest ?? s.installed ?? null;
  if (!version) return null;
  const id = (stage: ServerPillView['stage']) => `server:${version}:${stage}`;
  const shown = displayVersion(version);
  const versionTitle = `Walnut ${version}`;
  switch (live.state) {
    case 'restarting':
      return { identity: id('restarting'), stage: 'restarting', heading: `Restarting into Walnut ${shown}…`, action: null,
        label: 'Restarting…', short: WORKING_SHORT, tooltip: `Walnut is restarting into ${version}; this window reconnects by itself`,
        versionTitle, busy: true, working: true };
    case 'installed':
    case 'waiting':
      return live.canInstall ? ready(version, id('ready')) : installedOnly(version, id('installed'));
    case 'failed':
      return { identity: id('failed'), stage: 'failed', heading: `Walnut ${shown} did not install`, action: 'install',
        label: 'Try again', short: 'Retry', tooltip: live.error ? `Install of ${version} failed: ${live.error}` : `Install of ${version} failed. Click to try again.`,
        versionTitle, busy: false, working: false };
    case 'downloading':
      return updating(version, id('updating'));
    default:
      break;
  }
  // A version the startup path installed after this server started: a restart runs it.
  if (s.installed && s.installed !== s.current) {
    return live.canInstall ? ready(s.installed, `server:${s.installed}:ready`) : installedOnly(s.installed, `server:${s.installed}:installed`);
  }
  if (!s.available || !s.latest) return null;
  if (!live.canInstall) {
    return { identity: id('available'), stage: 'available', heading: `Walnut ${shown} available`, action: 'how',
      label: 'How to update', short: 'How', tooltip: 'This copy cannot update itself: see the command that updates it',
      versionTitle, busy: false, working: false };
  }
  // Auto on and nothing held: the server starts the install by itself at its next check.
  if (live.updatesAuto && !live.held && live.state === 'idle') return updating(version, id('updating'));
  return { identity: id('available'), stage: 'available', heading: `Walnut ${shown} available`, action: 'install',
    label: 'Update', short: 'Update',
    tooltip: live.held ? `Install ${version} now and restart (held back here: ${live.held})` : `Install ${version} now and restart`,
    versionTitle, busy: false, working: false };
}

function ready(version: string, identity: string): ServerPillView {
  return { identity, stage: 'ready', heading: `Walnut ${displayVersion(version)} is ready`, action: 'restart', label: 'Restart', short: 'Restart',
    tooltip: RESTART_TOOLTIP, versionTitle: `Walnut ${version}`, busy: false, working: false };
}

/**
 * Installed, but this server has no way to restart itself (not supervised, no restart
 * handler): POST /restart would only answer 409 no_restart, so there is no button that
 * can only fail; the words say what runs it.
 */
function installedOnly(version: string, identity: string): ServerPillView {
  return { identity, stage: 'installed', heading: `Walnut ${displayVersion(version)} is installed`, action: null,
    label: 'Restart Walnut to use it', short: 'Ready', tooltip: INSTALLED_TOOLTIP,
    versionTitle: `Walnut ${version}. ${INSTALLED_TOOLTIP}`, busy: false, working: false };
}

export const INSTALLED_TOOLTIP = 'Installed. Quit Walnut and start it again to use it; this copy cannot restart itself';

function updating(version: string, identity: string): ServerPillView {
  return { identity, stage: 'updating', heading: `Updating Walnut to ${displayVersion(version)}…`, action: null, label: 'Updating…', short: WORKING_SHORT,
    tooltip: `Installing ${version} in the background; Walnut restarts once you have been away 10 minutes`,
    versionTitle: `Walnut ${version}`, busy: false, working: true };
}

/** The commands the "How to update" dialog lists: this install's own, then a Homebrew keg's way to the file. */
export function howToUpdateCommands(s: UpdateStatus | null): Array<{ note: string | null; command: string }> {
  if (!s) return [];
  const out: Array<{ note: string | null; command: string }> = [];
  if (s.install.updateCommand) out.push({ note: null, command: s.install.updateCommand });
  if (s.brewHint && s.brewHint.command !== s.install.updateCommand) out.push({ note: s.brewHint.note, command: s.brewHint.command });
  return out;
}

// ── "Walnut updated to X": the server came back on another version than this tab last saw ──

export const SEEN_VERSION_KEY = 'open-walnut-served-version';

/**
 * The version to announce, or null. `seen` is what this tab last saw (sessionStorage:
 * per tab, kept across this tab's own reloads). The first answer in a tab only records.
 */
export function updatedNotice(seen: string | null, current: string | null | undefined): string | null {
  if (!current || !seen || seen === current) return null;
  return current;
}

export function readSeenVersion(store: Pick<Storage, 'getItem'> | null = safeSession()): string | null {
  try { return store?.getItem(SEEN_VERSION_KEY) ?? null; } catch { return null; }
}

export function writeSeenVersion(version: string, store: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try { store?.setItem(SEEN_VERSION_KEY, version); } catch { /* private mode, quota */ }
}

function safeSession(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
