/**
 * Permission Doctor — macOS probes.
 *
 * Ground rules (each encodes a shipped incident):
 *
 * 1. NEVER probe synchronously. Every check is a child process with a
 *    deadline; a TCC-protected read can hang, and one sync call freezes every
 *    route on the shared event loop (see event-loop-blocking-ratchet).
 * 2. NEVER trigger a system prompt from a probe. Probes run on a Settings
 *    poll; a prompt per poll tick would be hostile. Prompting is a separate,
 *    explicit user action (POST /request).
 * 3. Report the LAUNCHER. TCC attributes access to the responsible process —
 *    the top of the launcher chain — so "grant it to node" advice is wrong
 *    and was exactly the trap the calendar outage came from (grant sat on
 *    node; tccd checked Walnut.app). The UI must name the real grant target.
 * 4. 'unknown' ≠ 'denied'. A probe that couldn't run must not send the user
 *    to System Settings to fix a grant that may already be fine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLOUD_MODE } from '../../constants.js';
import { calendarAccessReport, calendarGrantApp, calendarHelperFallback } from '../calendar/sources/eventkit.js';
import { log } from '../../logging/index.js';
import { fullDiskAccessRows, probeFullDiskAccess } from './darwin-fda.js';
import { onFullDiskAccessUsesChanged } from './fda-uses.js';
import type { LauncherInfo, PermissionsReport, PermissionStatus } from './types.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

/** deep links into System Settings (verified on macOS 15). */
const SETTINGS_URL = {
  calendars: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
};

// ── launcher detection ───────────────────────────────────────────────────────

let launcherCache: LauncherInfo | null = null;

/** Terminal emulators we can name for the user. Anything else non-launchd in
 *  the chain top still counts as 'terminal' — the advice is the same. */
const TERMINAL_RE = /iTerm|Terminal|alacritty|kitty|wezterm|hyper|warp/i;

/**
 * Who is TCC's "responsible process" for this server?
 *
 * Fast path: Walnut.app sets WALNUT_LAUNCHER=mac-app when it spawns us
 * (desktop/main.swift) — authoritative and free.
 *
 * Fallback: walk the LIVE ancestor chain via `ps` up to pid 1 and classify
 * the topmost real process. Two traps this encodes:
 *  - TCC latches responsibility at SPAWN time, but `ps` only shows the chain
 *    as it is NOW. A deploy script's shell exits seconds after spawning us,
 *    reparenting us to launchd — probe then and you'd conclude "launchd" and
 *    tell the user to grant FDA to launchd (observed live; unactionable).
 *    warmLauncherDetection() therefore runs at server boot, while the chain
 *    is still intact.
 *  - Even at boot the chain can already be gone (daemon-spawned deploys). In
 *    that case we return 'unknown' — the report copy then recommends the
 *    stable identity (Walnut.app) instead of asserting a wrong one.
 */
export async function detectLauncher(): Promise<LauncherInfo> {
  if (launcherCache) return launcherCache;
  if (process.env.WALNUT_LAUNCHER === 'mac-app') {
    launcherCache = { kind: 'mac-app', name: 'Walnut.app' };
    return launcherCache;
  }
  try {
    // Ancestor walk, bounded: pid → … → child-of-launchd (≤10 hops).
    const chain: string[] = [];
    let pid = process.ppid;
    for (let hop = 0; hop < 10 && pid > 1; hop++) {
      const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        timeout: PROBE_TIMEOUT_MS,
      });
      const m = stdout.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      chain.push(m[2]);
      pid = Number(m[1]);
    }
    // Classify by the most specific signal anywhere in the chain: an app
    // match beats a terminal match beats shells (zsh/bash tell us nothing).
    const all = chain.join('\n');
    if (/Walnut\.app/i.test(all)) {
      launcherCache = { kind: 'mac-app', name: 'Walnut.app' };
    } else if (TERMINAL_RE.test(all)) {
      const name = chain.find((c) => TERMINAL_RE.exec(c))?.split('/').pop() ?? 'terminal';
      launcherCache = { kind: 'terminal', name };
    } else if (chain.length === 0) {
      // Already reparented to launchd — the spawn-time chain is unknowable.
      launcherCache = { kind: 'unknown', name: 'unknown' };
    } else {
      // A real chain that ends in something unrecognized (daemon, script).
      launcherCache = { kind: 'launchd', name: chain[chain.length - 1].split('/').pop() ?? 'launchd' };
    }
  } catch {
    launcherCache = { kind: 'unknown', name: 'unknown' };
  }
  return launcherCache;
}

/**
 * Call once at server boot: snapshots the ancestor chain before deploy-script
 * parents exit (see detectLauncher). Fire-and-forget; never blocks startup.
 */
export function warmLauncherDetection(): void {
  if (process.platform !== 'darwin' || CLOUD_MODE) return;
  detectLauncher().catch(() => {});
}

// ── individual probes ────────────────────────────────────────────────────────

// Full Disk Access lives in ./darwin-fda.ts: one row, one grant, for every feature.

/**
 * The identity agent sessions run under, if any.
 *
 * Read-only on purpose: the Settings panel polls this, and the launch path's
 * resolver APPROVES a command as a side effect. Polling that would rewrite the
 * manifest the running daemon was started against.
 */
async function probeSessionIdentity(): Promise<{ app: string | null; detail?: string }> {
  try {
    const [{ inspectSessionHost }, { PROD_DAEMON_DIR }] = await Promise.all([
      import('../../providers/session-host.js'),
      import('../../providers/daemon-ownership.js'),
    ]);
    const seen = await inspectSessionHost({
      daemonDir: process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR,
      prodDaemonDir: PROD_DAEMON_DIR,
    });
    return { app: seen.app, ...(seen.detail ? { detail: seen.detail } : {}) };
  } catch (err) {
    log.web.warn('session identity probe inconclusive', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { app: null };
  }
}

// ── report assembly ──────────────────────────────────────────────────────────

const NOT_APPLICABLE: PermissionsReport = {
  platform: process.platform,
  applicable: false,
  launcher: { kind: 'unknown', name: 'n/a' },
  permissions: [],
  probedAt: 0,
};

let reportCache: { report: PermissionsReport; at: number } | null = null;
const REPORT_TTL_MS = 30_000;
// A plugin starting or stopping a Full Disk Access use changes what the row says.
onFullDiskAccessUsesChanged(() => { reportCache = null; });

/**
 * Full permission report, cached 30s (Settings polls at 2s while the fix
 * dialog is open — pass force=true there so a grant shows up immediately).
 */
export async function getPermissionsReport(force = false): Promise<PermissionsReport> {
  // Cloud replica / Linux: TCC doesn't exist there. Frozen n/a report.
  if (process.platform !== 'darwin' || CLOUD_MODE) return NOT_APPLICABLE;
  if (!force && reportCache && Date.now() - reportCache.at < REPORT_TTL_MS) {
    return reportCache.report;
  }

  const [launcher, calAccess, fda, session] = await Promise.all([
    detectLauncher(),
    calendarAccessReport(),
    probeFullDiskAccess(),
    probeSessionIdentity(),
  ]);

  // calendarAccessReport asks the CURRENT helper. A previous generation can still
  // be holding the grant and serving real events, and saying "not granted" over
  // a full calendar is how a correct panel loses the user's trust.
  // It also asks the write route: an older Walnut.app hands calendar CHANGES to the helper,
  // which needs its own Allow. `writeOnly` is the case where reads are fine and only that is missing.
  const { state: calState, read: calRead, writeGap } = calAccess;
  const writeOnly = !!writeGap && calRead === 'granted';
  const calFallback = calState === 'granted' || writeOnly ? null : calendarHelperFallback();
  // Walnut.app itself when it answers calendar requests; null means the helper does
  // and asks for itself. Resolved by the status probe above, so this is a lookup.
  const calApp = await calendarGrantApp();
  const writeNote = writeGap
    ? ' This copy of Walnut.app is older than the calendar write check, so new events and changes go through the separate walnut-calendar helper, which needs its own Allow.'
    : '';

  const permissions: PermissionStatus[] = [
    {
      id: 'calendar',
      label: 'Calendar',
      state: calState,
      // EventKit prompts once from the not-determined state; after a denial
      // macOS never re-prompts, so the fix becomes settings-only. The dialog
      // picks its button off this field.
      fixKind: calState === 'not-determined' ? 'prompt' : 'settings-only',
      why:
        'Shows your Mac calendar events (iCloud, Google, Exchange) in the calendar view.'
        + (calFallback
          ? ` Your calendar is working right now through an older copy of the helper (${calFallback.version}),`
            + ` so ${writeGap ? 'reading works' : 'nothing is missing'}; granting ${calApp ? 'Walnut' : 'the current one'} just retires the old copy.`
          : '')
        + writeNote,
      ...(calFallback ? { workingVia: `an older copy of the helper (${calFallback.version})` } : {}),
      // Both routes disclaim parent responsibility (Walnut.app re-execs itself the
      // same way the helper does), so the grant is launcher-independent either way.
      grantTarget: calApp && !writeOnly ? calApp : 'walnut-calendar (asks by itself: one Allow click)',
      launcherIndependent: true,
      settingsUrl: SETTINGS_URL.calendars,
      steps:
        calState === 'not-determined'
          ? [
              // "Not asked yet" for a permission someone remembers granting is
              // the single most confusing thing this panel can say, and it is
              // usually true: macOS keys a grant to a CODE IDENTITY, so a helper
              // that got rebuilt or re-signed is a different program with no
              // history. Naming that up front stops it reading as data loss.
              writeOnly
                ? 'Walnut can read your calendars already. Creating and moving events needs the walnut-calendar helper allowed too.'
                : calApp
                  // The move to Walnut itself is the one extra ask, and it is the
                  // last: the app keeps one certificate identity across updates.
                  ? 'If you granted this before, that was to a separate helper. Calendar now belongs to Walnut itself, so macOS asks once more, and this is the last time.'
                  : 'If you have granted this before, macOS is asking again because Walnut re-signed the helper, and a re-signed program is a new one to macOS. It is now signed with a certificate, so this is the last time.',
              'Click "Request access" below.',
              writeGap === 'not-determined' && !writeOnly
                ? 'Click Allow Full Access in the macOS dialog. A second dialog asks for the walnut-calendar helper: allow that too.'
                : 'Click Allow Full Access in the macOS dialog.',
            ]
          : [
              { text: 'Open System Settings → Privacy & Security → Calendars.', open: true },
              `Find ${calApp && !writeOnly ? 'Walnut' : 'the walnut-calendar entry'} and enable Full Access.`,
              'No entry? Click "Request access" below to re-trigger the prompt.',
            ],
    },
    ...fullDiskAccessRows(fda, session.app),
  ];

  const report: PermissionsReport = {
    platform: process.platform,
    applicable: true,
    launcher,
    permissions,
    probedAt: Date.now(),
  };
  reportCache = { report, at: Date.now() };
  return report;
}

/** Test hook: reset memoized launcher + report between cases. */
export function __resetPermissionCachesForTest(): void {
  launcherCache = null;
  reportCache = null;
}
