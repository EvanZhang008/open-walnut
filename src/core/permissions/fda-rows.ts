/**
 * The Full Disk Access rows, built from a probe (./darwin-fda.ts). Pure, so the
 * browser spec can render exactly what the server sends.
 */
import path from 'node:path';
import type { PermissionStatus } from './types.js';

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export interface FdaProbe {
  state: 'granted' | 'denied' | 'not-applicable' | 'unknown';
  /** What the user adds in System Settings. */
  target: string;
  /** True when that is Walnut.app (the reader runs inside it). */
  walnutReads: boolean;
  stale: boolean;
  reasons: string[];
  /** Screen Time is among them (its row adds the iPhone step). */
  screenTime: boolean;
  /** The helper answering while Walnut is refused, if any. */
  standIn: string | null;
}

const SESSION_WHY =
  'Optional. Stops the repeated "wants to access data from other apps" popups '
  + 'while Claude Code reads files in a session.';

const IPHONE_STEP =
  'For your iPhone: Settings → Screen Time → Share Across Devices, so its numbers reach this Mac.';

/**
 * The Full Disk Access rows. `sessionApp` is the Walnut.app agent sessions run under
 * (null when they do not). One row when the reader is that same app; otherwise the
 * helper's row and, when sessions run as Walnut, Walnut's optional session row.
 */
export function fullDiskAccessRows(fda: FdaProbe, sessionApp: string | null): PermissionStatus[] {
  if (!fda.walnutReads) return [helperRow(fda), sessionRow(sessionApp)];
  // Both look up the first installed Walnut.app, so they name the same bundle; a
  // second row appears only while one is being replaced, and then names it.
  return sessionApp && !sameApp(sessionApp, fda.target) ? [walnutRow(fda), sessionRow(sessionApp)] : [walnutRow(fda)];
}

/** Walnut reads the protected files AND runs the sessions: one program, one row. */
function walnutRow(fda: FdaProbe): PermissionStatus {
  const app = fda.target;
  // With no feature switched on there is nothing to read, so nothing can be
  // checked, and the grant is purely the session one: optional and grey.
  const checkable = fda.reasons.length > 0;
  const why = checkable
    ? `Lets Walnut ${fda.reasons.join('; and ')}, and stops the repeated "wants to access data `
      + 'from other apps" popups while Claude Code reads files in a session.'
    : SESSION_WHY;
  return {
    id: 'full-disk-access',
    label: 'Full Disk Access',
    state: checkable ? fda.state : 'unknown',
    ...(checkable ? {} : { unverifiable: true, optional: true }),
    fixKind: 'settings-only',
    why: fda.standIn
      ? `${why} It works right now through the walnut-reader helper you granted before; granting Walnut retires it.`
      : why,
    ...(fda.standIn ? { workingVia: 'the walnut-reader helper you granted before' } : {}),
    grantTarget: app,
    // Walnut makes ITSELF the responsible process for both its reads and its
    // sessions, so the grant does not depend on what started the server.
    launcherIndependent: true,
    settingsUrl: SETTINGS_URL,
    ...(fda.stale ? { staleGrant: true } : {}),
    context:
      'Claude Code runs inside Walnut, so macOS asks Walnut for access, and granting it once '
      + 'replaces a popup per file. The same grant covers everything else that reads protected '
      + 'files, so macOS lists Walnut once. Work in your own project folders never needed it. '
      + 'Sessions already running keep the identity they started with, so for them the switch '
      + 'applies after the session daemon next restarts.'
      + (fda.standIn
        ? ' Until Walnut is on, the walnut-reader helper keeps reading; after that you can remove its row.'
        : ''),
    steps: fda.stale
      ? [
          // The row is already there with its toggle on, so "add it" would read as
          // nonsense and toggling it does nothing: tccd re-reads only on a fresh add.
          'Walnut is already listed, but macOS no longer recognizes it (it was rebuilt).',
          { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
          'Select the Walnut row and click the − button to remove it.',
          { text: 'Click +, press ⌘⇧G, then paste the same path back:', copy: app },
          'Turning the toggle off and on does not work: it has to be removed and re-added.',
        ]
      : [
          { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
          'Click + (authenticate if asked).',
          { text: 'Press ⌘⇧G, then paste:', copy: app },
          checkable
            ? 'Select it and make sure its toggle is ON.'
            // The honest completion signal, because there is nothing to turn green.
            : 'Turn its toggle on. The popups stop, and that is how you know.',
          ...(fda.screenTime ? [IPHONE_STEP] : []),
        ],
  };
}

/** The walnut-reader helper's row, for installs where it is the reader. */
function helperRow(fda: FdaProbe): PermissionStatus {
  return {
    id: 'full-disk-access',
    label: 'Full Disk Access',
    state: fda.state,
    fixKind: 'settings-only',
    // Built from the features actually switched on, so the row can never ask for
    // this permission "in general". The empty case is reachable (state is then
    // not-applicable and the UI hides the row), and an empty join would leave
    // "Lets Walnut ." in the API.
    why:
      (fda.reasons.length > 0
        ? `Lets Walnut ${fda.reasons.join('; and ')}. `
        : 'Needed only by features that are currently switched off. ')
      + 'Only the walnut-reader helper gets this access, it is read-only, and you grant it once: '
      + 'the helper is its own signed identity, so redeploys and updates keep working.',
    grantTarget: fda.target,
    // walnut-reader re-execs with responsibility disclaimed, so this grant is the
    // helper's own and survives a different launcher.
    launcherIndependent: true,
    settingsUrl: SETTINGS_URL,
    ...(fda.stale ? { staleGrant: true } : {}),
    steps: fda.stale
      ? [
          'The helper is already listed, but macOS no longer recognizes it (Walnut rebuilt it).',
          { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
          'Select the walnut-reader row and click the − button to remove it.',
          { text: 'Click +, press ⌘⇧G, then paste the same path back:', copy: fda.target },
          'Turning the toggle off and on does NOT work — it has to be removed and re-added.',
        ]
      : [
          { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
          'Click + (authenticate if asked).',
          { text: 'Press ⌘⇧G, then paste:', copy: fda.target },
          'Select it and make sure its toggle is ON.',
          // Not a permission step, but it is the other half of "why is it still
          // empty", and this list is the only place the user is looking.
          IPHONE_STEP,
        ],
  };
}

/** Walnut's own grant for sessions, when a separate helper does the reading. */
function sessionRow(sessionApp: string | null): PermissionStatus {
  // ONE binding for the path the row names: the grantTarget and the copy control
  // inside its paste step have to be the same string, and writing the fallback
  // twice already produced an empty copy chip once.
  const target = sessionApp ?? 'Walnut.app';
  return {
    id: 'session-full-disk-access',
    label: 'Session file access',
    // Never 'granted' and never 'denied': see `unverifiable`. Proving it would mean
    // reading a protected file as this identity, which is the very access the user
    // is deciding about.
    state: sessionApp ? 'unknown' : 'not-applicable',
    unverifiable: true,
    // Sessions work without it; it removes popups. Everything the UI says about
    // this row has to keep agreeing with that.
    optional: true,
    fixKind: 'settings-only',
    // One short sentence, like every other row: this is a list the user scans. It
    // names Claude Code because that is what they see doing the reading, and it
    // leads with "Optional" so a scan never reads it as something broken.
    why: SESSION_WHY,
    grantTarget: target,
    // The app makes ITSELF the responsible process before starting the daemon, so
    // this grant does not depend on whether a terminal or the Mac app started Walnut.
    launcherIndependent: true,
    settingsUrl: SETTINGS_URL,
    context:
      'Claude Code runs inside Walnut, so macOS asks Walnut for access, and granting it '
      + 'once replaces a popup per file. Skipping it costs nothing: work in your own '
      + 'project folders never needed it. macOS lists this separately from the reader '
      + 'helper above because it grants access per program, not per app you think of as '
      + 'one. Sessions already running keep the identity they started with, so the switch '
      + 'applies after the session daemon next restarts.',
    // Each step owns its action: step 1 IS the link that opens the pane, and step 3
    // IS the copy control for the path it tells you to paste.
    steps: [
      { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
      'Click + (authenticate if asked).',
      { text: 'Press ⌘⇧G, then paste:', copy: target },
      // The honest completion signal, because there is nothing to turn green.
      'Turn its toggle on. The popups stop — that is how you know.',
    ],
  };
}

/** Same bundle, however it was spelled (both come from desktopAppCandidates, so a
 *  trailing slash is the only variation; no filesystem call on the report path). */
function sameApp(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
