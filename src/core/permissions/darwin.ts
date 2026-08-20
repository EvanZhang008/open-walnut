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
import os from 'node:os';
import { CLOUD_MODE } from '../../constants.js';
import { calendarAuthStatus } from '../calendar/sources/eventkit.js';
import { log } from '../../logging/index.js';
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
 * Full Disk Access probe. Apple ships no API for this, so we use the standard
 * community technique: try to read a file that only FDA unlocks. The user-level
 * TCC.db is ideal — it exists on every account and nothing else grants access.
 *
 * The read runs in a CHILD process (`/bin/cat`) rather than fs.readFile for
 * two reasons: a denied read is instant and clean in a child (no risk of a
 * TCC prompt attaching to our pid), and the child inherits our responsible
 * process, so the probe measures exactly the grant our sessions will use.
 * `cat` exits 1 with "Operation not permitted" when FDA is missing — that is
 * a definitive 'denied', not an error.
 *
 * FDA has no prompt (macOS never asks for it) → state is only ever
 * granted/denied/unknown, and the fix is always settings-only.
 */
async function probeFullDiskAccess(): Promise<'granted' | 'denied' | 'unknown'> {
  const tccDb = `${os.homedir()}/Library/Application Support/com.apple.TCC/TCC.db`;
  try {
    // head -c1: we need "can we open it", not the contents.
    await execFileAsync('/usr/bin/head', ['-c', '1', tccDb], { timeout: PROBE_TIMEOUT_MS });
    return 'granted';
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/Operation not permitted|Permission denied/i.test(msg)) return 'denied';
    // ENOENT / timeout / anything else: we learned nothing about the grant.
    log.web.warn('fda probe inconclusive', { error: msg.slice(0, 200) });
    return 'unknown';
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

  const [launcher, calState, fdaState] = await Promise.all([
    detectLauncher(),
    calendarAuthStatus(),
    probeFullDiskAccess(),
  ]);

  // Advice must name the real responsible app. When we're launched by a
  // terminal, granting FDA to Walnut.app does nothing — TCC checks the
  // terminal — so the grant target follows the launcher. When the launcher
  // is unknowable (deploy-script parent already exited, daemon spawn), we
  // can't name the responsible process at all; the honest, actionable advice
  // is "restart from the stable identity, then grant that" — never a fake
  // target like "launchd", which no user can add to the FDA panel.
  const fdaTarget =
    launcher.kind === 'mac-app'
      ? '/Applications/Walnut.app'
      : launcher.kind === 'terminal'
        ? launcher.name
        : '/Applications/Walnut.app (restart Walnut from the app first)';

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
      settingsUrl: SETTINGS_URL.calendars,
      steps:
        calState === 'not-determined'
          ? ['Click "Request access" below.', 'Click Allow Full Access in the macOS dialog.']
          : [
              'Open System Settings → Privacy & Security → Calendars.',
              'Find the walnut-calendar entry and enable Full Access.',
              'No entry? Click "Request access" below to re-trigger the prompt.',
            ],
    },
    {
      id: 'full-disk-access',
      label: 'Full Disk Access',
      state: fdaState,
      fixKind: 'settings-only',
      why:
        'Lets agent sessions read files that belong to other apps without a popup per app. ' +
        'Without it, macOS shows "node would like to access data from other apps" repeatedly.',
      grantTarget: fdaTarget,
      settingsUrl: SETTINGS_URL.fullDisk,
      steps: [
        'Open System Settings → Privacy & Security → Full Disk Access.',
        'Click + (authenticate if asked).',
        `Press Cmd+Shift+G and paste: ${fdaTarget}`,
        'Select it and make sure its toggle is ON.',
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
