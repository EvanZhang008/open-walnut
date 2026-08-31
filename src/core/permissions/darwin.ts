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
import { calendarAuthStatus } from '../calendar/sources/eventkit.js';
import { log } from '../../logging/index.js';
import type { Config } from '../types.js';
import type { LauncherInfo, PermissionsReport, PermissionStatus } from './types.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

/** deep links into System Settings (verified on macOS 15). */
const SETTINGS_URL = {
  calendars: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
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

/**
 * Full Disk Access — ONE row, ONE grant, for every feature that needs it.
 *
 * It is deliberately measured against the shared `walnut-reader` helper rather
 * than against this server process, and that choice is the whole design:
 *
 *   - The helper re-execs with parent responsibility disclaimed, so it is its
 *     OWN TCC subject. The grant therefore belongs to the helper and survives a
 *     different launcher, a redeploy, and (because it is certificate-signed) a
 *     rebuild. Grant it once, ever.
 *   - Probing the server process instead produced a row nobody could act on.
 *     TCC judges whoever is actually reading, and on a scripted install that is
 *     `/opt/homebrew/bin/node` running out of a staged temp directory with
 *     ppid 1, while the row told the user to add `/Applications/Walnut.app` —
 *     a different program with a different identity. The row stayed red no
 *     matter how many times they granted, and reading next to the helper's row
 *     it looked like Walnut was asking for the same permission twice.
 *
 * What that older row was for is not free, so state it plainly: giving the node
 * process FDA is what stops the repeated "node would like to access data from
 * other apps" popups in agent sessions. A helper cannot do that job, because
 * there it is node itself doing the reading. Handing a whole Node runtime
 * full-disk access is a much bigger hammer than one read-only helper, so it is
 * not something to ask for by default. If it comes back, it belongs behind an
 * explicit opt-in and must name the REAL launcher, never a hardcoded app path.
 *
 * Only probed when some feature actually needs it. With none enabled the row
 * reports not-applicable and the UI hides it: nobody should be asked for the
 * most powerful permission macOS has for a feature they never turned on, and
 * probing would also pay a first-run swiftc compile for nothing.
 */
interface FdaConsumer {
  /** Shown in the row's `why` so the user knows what the grant buys. */
  readonly reason: string;
  readonly enabled: (config: Config) => boolean;
}

/** Every feature that reads through the shared helper. Adding one is a line
 *  here; it must NOT grow a second permission row. */
const FDA_CONSUMERS: readonly FdaConsumer[] = [
  {
    reason:
      'read Apple Screen Time, including the numbers your iPhone syncs to this Mac, and keep '
      + 'them permanently (Apple deletes its own copy after a few weeks)',
    enabled: (config) => config.time?.screentime?.enabled === true,
  },
];

async function probeFullDiskAccess(): Promise<{
  state: 'granted' | 'denied' | 'not-applicable' | 'unknown';
  target: string;
  stale: boolean;
  reasons: string[];
}> {
  const unknown = { state: 'unknown' as const, target: 'walnut-reader', stale: false, reasons: [] };
  let reasons: string[];
  try {
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    reasons = FDA_CONSUMERS.filter((c) => c.enabled(config)).map((c) => c.reason);
  } catch {
    return unknown; // an unreadable config tells us nothing about the grant
  }
  if (reasons.length === 0) {
    return { state: 'not-applicable', target: 'walnut-reader', stale: false, reasons };
  }
  try {
    const { probeScreenTimeAccess } = await import('../time-tracking/screentime-reader.js');
    const result = await probeScreenTimeAccess();
    if (!('kind' in result)) return { state: 'granted', target: result.helperPath, stale: false, reasons };
    if (result.kind === 'denied') {
      return {
        state: 'denied',
        target: result.helperPath,
        stale: result.denied === 'stale_grant',
        reasons,
      };
    }
    // no_store means Screen Time itself has never written a database here, and
    // unavailable means the helper cannot exist on this box. Neither is a grant
    // problem, so neither may send the user to System Settings.
    if (result.kind === 'no_store') {
      return { state: 'granted', target: result.helperPath, stale: false, reasons };
    }
    return { ...unknown, reasons };
  } catch (err) {
    log.web.warn('full disk access probe inconclusive', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...unknown, reasons };
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

  const [launcher, calState, fda] = await Promise.all([
    detectLauncher(),
    calendarAuthStatus(),
    probeFullDiskAccess(),
  ]);

  const permissions: PermissionStatus[] = [
    {
      id: 'calendar',
      label: 'Calendar',
      state: calState,
      // EventKit prompts once from the not-determined state; after a denial
      // macOS never re-prompts, so the fix becomes settings-only. The dialog
      // picks its button off this field.
      fixKind: calState === 'not-determined' ? 'prompt' : 'settings-only',
      why: 'Shows your Mac calendar events (iCloud, Google, Exchange) in the calendar view.',
      // The v2+ helper disclaims parent responsibility, so the grant target
      // is the helper itself — launcher-independent by design.
      grantTarget: 'walnut-calendar (asks by itself — one Allow click)',
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
              'If you have granted this before, macOS is asking again because Walnut re-signed the helper, and a re-signed program is a new one to macOS. It is now signed with a certificate, so this is the last time.',
              'Click "Request access" below.',
              'Click Allow Full Access in the macOS dialog.',
            ]
          : [
              'Open System Settings → Privacy & Security → Calendars.',
              'Find the walnut-calendar entry and enable Full Access.',
              'No entry? Click "Request access" below to re-trigger the prompt.',
            ],
    },
    {
      id: 'full-disk-access',
      label: 'Full Disk Access',
      state: fda.state,
      fixKind: 'settings-only',
      // Built from the features actually switched on, so the row can never ask
      // for this permission "in general" — it always says what it is for. The
      // empty case is reachable (state is then not-applicable and the UI hides
      // the row), and an empty join would leave "Lets Walnut ." in the API.
      why:
        (fda.reasons.length > 0
          ? `Lets Walnut ${fda.reasons.join('; and ')}. `
          : 'Needed only by features that are currently switched off. ')
        + 'Only the walnut-reader helper gets this access, it is read-only, and you grant it once: '
        + 'the helper is its own signed identity, so redeploys and updates keep working.',
      grantTarget: fda.target,
      // walnut-reader re-execs with responsibility disclaimed, so this grant is
      // the helper's own and survives a different launcher.
      launcherIndependent: true,
      settingsUrl: SETTINGS_URL.fullDisk,
      ...(fda.stale ? { staleGrant: true } : {}),
      steps: fda.stale
        ? [
            // The row is already there with its toggle on, so "add it" would read
            // as nonsense and toggling it does nothing: tccd has to re-read the
            // helper, which only happens on a fresh add.
            'The helper is already listed, but macOS no longer recognizes it (Walnut rebuilt it).',
            'Open System Settings → Privacy & Security → Full Disk Access.',
            'Select the walnut-reader row and click the − button to remove it.',
            `Click +, press Cmd+Shift+G, then Cmd+V to paste the same path back (already copied): ${fda.target}`,
            'Turning the toggle off and on does NOT work — it has to be removed and re-added.',
          ]
        : [
            'Open System Settings → Privacy & Security → Full Disk Access.',
            'Click + (authenticate if asked).',
            `Press Cmd+Shift+G, then Cmd+V (the path is already copied): ${fda.target}`,
            'Select it and make sure its toggle is ON.',
            // Not a permission step, but it is the other half of "why is it still
            // empty", and this list is the only place the user is looking.
            'For your iPhone: Settings → Screen Time → Share Across Devices, so its numbers reach this Mac.',
          ],
    },
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
