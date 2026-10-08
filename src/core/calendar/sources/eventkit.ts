/**
 * EventKit calendar source — shells out to the walnut-calendar Swift helper,
 * which reads/writes ALL system-account calendars (iCloud, Google, Exchange…)
 * using the Mac's existing logins. No per-provider OAuth in Walnut; macOS
 * owns cloud sync.
 *
 * Compiling, signing and caching the helper binary belong to
 * src/core/helper-build.ts (its header explains why the signature is what decides
 * whether the user's calendar grant survives a rebuild). No swiftc on the box
 * means this source reports not-configured with an actionable message instead of
 * crashing.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CLOUD_MODE } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import {
  ensureHelper, existingHelperBinary, helperFailure, nativeHelpersAllowed, olderHelperGenerations,
  type HelperSpec,
} from '../../helper-build.js';
import { findDesktopAppWith } from '../../../providers/desktop-app.js';
import { safeKillProcessGroup } from '../../process-group-kill.js';
import { CalendarHelperError } from '../helper-error.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarEventStatus,
  CalendarInfo,
  CalendarSelfStatus,
  CalendarSource,
  CalendarSourceReason,
  CalendarWriteOptions,
  // Type-only, and pointed at the plugin on purpose: the event shape is the calendar
  // plugin's contract now, and this file is one implementation of its `CalendarSource`.
  // Erased at build time, so core keeps no runtime dependency on a plugin.
} from '../../../integrations/calendar/types.js';

const execFileAsync = promisify(execFile);
// v2: helper re-execs with TCC responsibility disclaimed and carries its own
// embedded Info.plist (__info_plist section), so the calendar grant belongs to
// the helper binary itself — not to whatever launched Walnut (iTerm, app
// bundle, launchd). Without this, changing the launcher silently revoked
// calendar access (tccd refused: parent had no NSCalendarsUsageDescription).
// v3: adds the side-effect-free `status` subcommand for the Permission Doctor.
// v4: `list` reports each event's status + the current user's participant status
// (a cancelled or declined invitation stays in the EventKit store, and dropping
// those fields made it indistinguishable from a live meeting), and accepts a
// `refresh` argument that pulls from the remote accounts first.
// NOTE: on a machine with no codesigning certificate the helper stays ad-hoc
// signed, so its TCC identity includes its content hash and any recompile asks
// for the calendar permission once more. That is expected, not a regression, and
// the Permission Doctor exists to walk the user through it. With a certificate the
// grant survives the bump (see src/core/helper-build.ts).
// v5 is not a source change either: it replaces the cached ad-hoc binary with a
// certificate-signed one, which is the only way the existing cache could ever get a
// signature (ensureHelper returns an existing file untouched, and re-signing in place
// changes the content hash and would break the grant the user already has). Cost:
// macOS asks for Calendars once more.
//
// v6 exists because v5 turned out to be UNGRANTABLE, and the reason is worth
// keeping. Signing it with a certificate also put it under the hardened runtime,
// and under that runtime tccd refuses to show the Calendars prompt for a binary
// that does not declare com.apple.security.personal-information.calendars. It
// does not report this to the caller: the request returns denied while the status
// stays notDetermined, so the UI reads "not asked yet" forever and no button can
// change it. Only tccd's own log said so. v6 carries the entitlement (see
// HELPER_SPEC below), and it needs a NEW file name rather than a re-sign of v5
// because tccd had already recorded an entry for v5's path whose code
// requirement no longer matches, and it will not re-prompt for that path.
// v7: the write-safety protocol (`capabilities`, `get`, ownership fields, guarded update/delete).
const HELPER_VERSION = 'v7';
/** The `writeSafetyVersion` a binary must report before any write or pre-write `get` goes to it. */
const WRITE_SAFETY_VERSION = 1;
/** Last argument of update/delete: the helper asks the user in a native dialog before a protected write. */
const HUMAN_CONFIRM_FLAG = '--human-confirm';
const HUMAN_CONFIRM_TIMEOUT_MS = 90_000;

/**
 * Walnut.app answers calendar requests itself: `Walnut --calendar-bridge <sub> …`
 * (desktop/CalendarBridge.swift, compiled from the same walnut-calendar.swift).
 * Preferred over the helper because the Calendars grant then belongs to Walnut, one
 * certificate-signed identity that survives rebuilds, instead of to a helper whose
 * version bumps each asked again (v2 … v6 above). The helper remains for installs
 * with no Walnut.app, and as the stand-in while Walnut is not granted yet.
 * Pinned against the Swift constant by tests/core/calendar-bridge.test.ts.
 */
export const CALENDAR_BRIDGE_FLAG = '--calendar-bridge';
const HELPER_TIMEOUT_MS = 30_000;

/** Embedded plist: tccd reads usage keys from here once the helper is its own
 *  responsible process. Both keys required, because macOS 14+ wants the FullAccess
 *  variant but refuses outright if the legacy key is absent. */
const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>dev.openwalnut.calendar-helper</string>
    <key>CFBundleName</key>
    <string>Walnut Calendar Helper</string>
    <key>NSCalendarsUsageDescription</key>
    <string>Walnut shows and edits your Mac calendar events alongside your tasks.</string>
    <key>NSCalendarsFullAccessUsageDescription</key>
    <string>Walnut shows and edits your Mac calendar events alongside your tasks.</string>
</dict>
</plist>
`;

interface HelperError {
  error: string;
  code: string;
}

// Re-exported, not declared here: the class moved to ../helper-error.js so a consumer that
// only throws it (the calendar plugin) does not drag this module and helper-build.js into
// its bundle. Existing importers of this path keep working.
export { CalendarHelperError };

const HELPER_SPEC: HelperSpec = {
  name: 'walnut-calendar',
  version: HELPER_VERSION,
  /** Version-free on purpose: a certificate-signed calendar grant is remembered
   *  against this string, so it must not move when HELPER_VERSION does. */
  identifier: 'dev.openwalnut.calendar',
  infoPlist: HELPER_INFO_PLIST,
  // Without this, a certificate-signed helper can never be granted Calendars at
  // all: tccd applies its hardened-runtime prompting policy and refuses to show
  // the dialog for a binary that does not declare the entitlement. See the
  // `entitlements` field's comment in src/core/helper-build.ts.
  entitlements: ['com.apple.security.personal-information.calendars'],
  // The source's entry point is `@main`, because Walnut.app compiles the same file.
  parseAsLibrary: true,
};

/**
 * A PREVIOUS helper generation that still holds the Calendars grant.
 *
 * Why this exists, measured on this machine: bumping HELPER_VERSION writes a new
 * binary next to the old one, and an ad-hoc TCC grant is keyed to the binary's
 * content hash, so the new generation starts with NO permission while the old one
 * keeps full access. Nothing is broken in macOS's eyes, so nothing prompts and
 * nothing is logged — the calendar simply reads back empty. Preferring a proven
 * older generation over an empty day means a version bump degrades (we may lose
 * fields a newer protocol added) instead of going dark, and the warning below is
 * what tells the user to re-grant.
 */
let fallbackBin: string | null = null;
/** Cooldown so a hopeless probe (nothing older, or nothing granted) does not
 *  respawn N helpers on every read, while still allowing a later retry. */
let lastFallbackProbe = 0;
const FALLBACK_PROBE_COOLDOWN_MS = 60_000;

/** The older generation currently standing in, for status/UI. Null when the
 *  current helper is the one being used. */
export function calendarHelperFallback(): { path: string; version: string } | null {
  if (!fallbackBin) return null;
  const version = /-([^-]+)$/.exec(fallbackBin)?.[1] ?? 'older';
  return { path: fallbackBin, version };
}

/** Tests, and a manual "I re-granted, use the new one again" retry. */
export function resetCalendarHelperFallback(): void {
  fallbackBin = null;
  lastFallbackProbe = 0;
  lastStandInProbe = 0;
  currentAnswered = false;
}

/** `[program, ...leading args]`: `[helper]` or `[Walnut, '--calendar-bridge']`. */
type CalendarCommand = readonly string[];

async function execHelper<T>(cmd: CalendarCommand, args: string[], timeoutMs = HELPER_TIMEOUT_MS): Promise<T> {
  const { stdout } = await execFileAsync(cmd[0]!, [...cmd.slice(1), ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/** execHelper for writes, in its own process group: at the deadline the whole group gets SIGKILL and it rejects with `killed: true`. */
function execHelperGroup<T>(cmd: CalendarCommand, args: string[], timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // spawn, not execFile (which drops `detached`): the helper re-execs a disclaimed child that would outlive a parent-only kill.
    const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const killGroup = () => { safeKillProcessGroup(child.pid, 'SIGKILL'); };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      finish(new Error('Calendar helper timed out'));
    }, timeoutMs);
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err) {
        try {
          resolve(JSON.parse(stdout) as T);
        } catch (parseErr) {
          reject(parseErr);
        }
        return;
      }
      reject(Object.assign(err, { stdout, killed: timedOut }));
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length > 16 * 1024 * 1024) return;
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) killGroup();
    });
    child.stderr?.resume();
    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      finish(code === 0 && !timedOut ? null : new Error(`calendar helper exited with ${signal ?? `code ${code}`}`));
    });
  });
}

/**
 * First older generation that both HOLDS the grant and speaks the protocol we
 * need. `status` answers the permission question without side effects; `calendars`
 * proves the binary actually understands the subcommands (a generation older than
 * the JSON shapes used here would parse but not match, and an array of calendars
 * is the cheapest thing that fails loudly if it does not).
 */
async function findGrantedOlderHelper(currentIsApp: boolean): Promise<string | null> {
  // With Walnut.app answering, the current HELPER is itself a previous identity:
  // the one most likely to hold the grant, so it is tried first. Only an already
  // built one: compiling a helper just to ask it would mint a new, ungranted program.
  const current = currentIsApp ? existingHelperBinary(HELPER_SPEC) : null;
  const candidates = [...(current ? [current] : []), ...olderHelperGenerations(HELPER_SPEC)];
  for (const bin of candidates) {
    try {
      const { state } = await execHelper<{ state?: string }>([bin], ['status']);
      if (state !== 'granted') continue;
      const cals = await execHelper<unknown>([bin], ['calendars']);
      if (!Array.isArray(cals)) continue;
      return bin;
    } catch {
      continue; // an older generation that cannot run is simply not a candidate
    }
  }
  return null;
}

/**
 * Run a helper subcommand; helper always emits JSON (error shape on exit 1).
 *
 * `currentOnly` pins the call to the CURRENT generation, fallback or not. The
 * Permission Doctor needs that: its whole job is to report and fix the grant on
 * the helper Walnut is supposed to be using, and answering "granted" because a
 * previous generation is standing in would send the user away with the problem
 * still there.
 */
/** Which identity the CURRENT route asks as, for the Permission Doctor and the
 *  degraded message. Null until the first request resolves it. */
let currentRoute: { kind: 'app'; app: string } | { kind: 'helper' } | null = null;
/** Set once the current route has answered a real request, which ends the
 *  migration check below for the life of the process. */
let currentAnswered = false;
/** Its own clock, not lastFallbackProbe: sharing one would let this check use up
 *  the cooldown and stop a DENIED Walnut from falling back right after it. */
let lastStandInProbe = 0;

/**
 * The helper to use INSTEAD of asking Walnut, while Walnut has never been asked
 * and a helper the user granted before still holds Calendars.
 *
 * Why not just ask: the first read after the move to Walnut would put the
 * Calendars dialog up from a background poll, while the user is looking at
 * something else, and a request nobody answers times out after 30s as an error
 * rather than a denial, so the calendar would not even fall back. Instead the old
 * grant keeps the calendar full and the ONE ask for Walnut waits for the user to
 * press Request access in Settings → macOS Access (requestCalendarAccess).
 * With no granted helper there is nothing to stand in, and Walnut asks as before.
 * A new helper generation (v6 → v7) on the helper route is the same moment.
 */
async function standInWhileCurrentUnasked(current: CalendarCommand, currentIsApp: boolean): Promise<string | null> {
  if (Date.now() - lastStandInProbe <= FALLBACK_PROBE_COOLDOWN_MS) return null;
  lastStandInProbe = Date.now();
  try {
    const { state } = await execHelper<{ state?: string }>(current, ['status']);
    if (state !== 'not-determined') return null;
  } catch {
    return null;
  }
  return findGrantedOlderHelper(currentIsApp);
}

/**
 * Where a calendar request goes: Walnut.app when it knows the bridge, else the
 * helper. The app route obeys the same gate as the helper, because a test server
 * running the real Walnut.app would put the same dialog on the user's screen.
 */
async function currentCommand(): Promise<CalendarCommand | null> {
  if (process.platform === 'darwin' && !CLOUD_MODE && nativeHelpersAllowed()) {
    const found = await findDesktopAppWith(CALENDAR_BRIDGE_FLAG);
    if (found) {
      currentRoute = { kind: 'app', app: found.app };
      return [found.executable, CALENDAR_BRIDGE_FLAG];
    }
  }
  const bin = await ensureHelper(HELPER_SPEC, 'walnut-calendar.swift');
  currentRoute = bin ? { kind: 'helper' } : null;
  return bin ? [bin] : null;
}

/** The app that holds the Calendars grant when Walnut.app answers, else null (the
 *  helper asks for itself). Resolves the route if nothing has yet. */
export async function calendarGrantApp(): Promise<string | null> {
  if (!currentRoute) await currentCommand();
  return currentRoute?.kind === 'app' ? currentRoute.app : null;
}

interface RunOptions {
  /** Pin to the current route (the Permission Doctor). */
  currentOnly?: boolean;
  /** A write, or the `get` a write is checked against: see runSafeWrite. */
  safeWrite?: boolean;
  /** The args end with HUMAN_CONFIRM_FLAG, so the helper may wait on a native dialog. */
  humanConfirm?: boolean;
}

async function runHelper<T>(args: string[], opts?: RunOptions): Promise<T> {
  const current = await currentCommand();
  const cmd = opts?.currentOnly || opts?.safeWrite ? current : (fallbackBin ? [fallbackBin] : current);
  if (!cmd || !current) {
    // The compile message would send a fixture author to install Xcode for a helper
    // that was refused on purpose.
    const message = !nativeHelpersAllowed() || helperFailure(HELPER_SPEC.name) === 'ephemeral'
      ? 'Calendar helper is not run from a temporary data dir (it would re-prompt for Calendars); set WALNUT_NATIVE_HELPERS=1 to allow it.'
      : 'Calendar helper unavailable (needs macOS + Xcode Command Line Tools for one-time compile).';
    throw new CalendarHelperError(message, 'not-configured');
  }
  if (opts?.safeWrite) return runSafeWrite<T>(current, args, opts.humanConfirm === true);
  if (!opts?.currentOnly && !fallbackBin && currentRoute && !currentAnswered) {
    const standIn = await standInWhileCurrentUnasked(current, currentRoute.kind === 'app');
    if (standIn) {
      fallbackBin = standIn;
      log.calendar.info('the current calendar route has not been asked for Calendars yet, reading through a granted helper', {
        route: currentRoute.kind,
        fallback: standIn,
        note: 'Settings → macOS Access → Calendar → Request access moves the grant to the current route',
      });
      return await execHelper<T>([standIn], args);
    }
  }
  try {
    const result = await execHelper<T>(cmd, args);
    // Only a read that needs the grant proves it; `status` answers without one.
    if (cmd === current && (args[0] === 'calendars' || args[0] === 'list')) currentAnswered = true;
    return result;
  } catch (err) {
    const mapped = toHelperError(err);
    // A denial on the CURRENT generation is the one failure a previous generation
    // can still answer, so try that before reporting an empty calendar.
    if (
      mapped.code === 'permission-denied' &&
      !opts?.currentOnly &&
      cmd === current &&
      Date.now() - lastFallbackProbe > FALLBACK_PROBE_COOLDOWN_MS
    ) {
      lastFallbackProbe = Date.now();
      const older = await findGrantedOlderHelper(currentRoute?.kind === 'app');
      if (older) {
        fallbackBin = older;
        log.calendar.warn('calendar permission missing on the current route, using an older helper', {
          current: cmd.join(' '),
          fallback: older,
          note: 'grant Calendars to Walnut in System Settings → Privacy & Security → Calendars',
        });
        return await execHelper<T>([older], args);
      }
    }
    throw mapped;
  }
}

/** True only when `cmd` answers `capabilities` with this build's write-safety version. */
async function speaksWriteSafety(cmd: CalendarCommand): Promise<boolean> {
  try {
    // Answered before requestAccess on every bridge-capable binary, so the probe never prompts.
    const caps = await execHelper<{ writeSafetyVersion?: unknown }>(cmd, ['capabilities']);
    return caps?.writeSafetyVersion === WRITE_SAFETY_VERSION;
  } catch {
    return false;
  }
}

/** Writes and their pre-write `get` go only to Walnut.app or the current helper once it proves the protocol, never to a stand-in or older generation. */
async function runSafeWrite<T>(current: CalendarCommand, args: string[], humanConfirm: boolean): Promise<T> {
  const picks = currentRoute?.kind === 'app' ? ['current', 'helper'] as const : ['current'] as const;
  let denied: CalendarHelperError | null = null;
  for (const pick of picks) {
    let cmd: CalendarCommand | null = current;
    if (pick === 'helper') {
      const bin = await ensureHelper(HELPER_SPEC, 'walnut-calendar.swift');
      cmd = bin ? [bin] : null;
    }
    // Probed per call, never cached: a stale yes would send a guarded write to a binary that ignores the guard.
    if (!cmd || !(await speaksWriteSafety(cmd))) continue;
    if (pick === 'helper' && !denied) {
      log.calendar.info('Walnut.app predates the calendar write-safety check, writing through the helper', {
        helper: cmd[0], subcommand: args[0],
      });
    }
    try {
      return await execHelperGroup<T>(cmd, args, humanConfirm ? HUMAN_CONFIRM_TIMEOUT_MS : HELPER_TIMEOUT_MS);
    } catch (err) {
      if (humanConfirm && (err as { killed?: boolean }).killed) {
        throw new CalendarHelperError('Timed out waiting for the macOS confirmation dialog.', 'human-approval-required');
      }
      const mapped = toHelperError(err);
      // A denied identity changed nothing, so the other safe route may still answer.
      if (mapped.code !== 'permission-denied') throw mapped;
      denied = mapped;
    }
  }
  throw denied ?? new CalendarHelperError(
    'Walnut cannot check whose calendar event this is (the calendar bridge predates the write-safety check), so nothing was changed.',
    'human-approval-required',
  );
}

/** Map an execFile rejection onto our error shape. Non-zero exit still prints a
 *  JSON error payload on stdout, so that is preferred over the spawn message. */
function toHelperError(err: unknown): CalendarHelperError {
  const stdout = (err as { stdout?: string }).stdout;
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as HelperError;
      if (parsed?.error && parsed?.code) return new CalendarHelperError(parsed.error, parsed.code);
    } catch {
      // not JSON — fall through to the generic message
    }
  }
  return new CalendarHelperError(
    `calendar helper failed: ${(err as Error).message?.slice(0, 200)}`,
    'fetch-error'
  );
}

/**
 * Permission Doctor probe: current calendar authorization WITHOUT prompting.
 * Safe to poll (the `status` subcommand never touches requestAccess). Returns
 * 'unknown' when the helper can't run at all (no swiftc, non-macOS) — callers
 * must not present that as "denied", the fixes differ.
 */
export async function calendarAuthStatus(): Promise<'granted' | 'denied' | 'not-determined' | 'unknown'> {
  try {
    const { state } = await runHelper<{ state: string }>(['status'], { currentOnly: true });
    return state === 'granted' || state === 'denied' || state === 'not-determined' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Permission Doctor fix for the 'not-determined' state: run a real command so
 * EventKit shows the ONE system prompt macOS allows. Blocks until the user
 * answers (helper waits up to 30s). Returns the post-prompt state. Once the
 * state is 'denied' this is useless — macOS never re-prompts — which is why
 * the UI routes denied users to System Settings instead.
 */
export async function requestCalendarAccess(): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    await runHelper<unknown>(['calendars'], { currentOnly: true });
    // The current helper answered, so whatever stand-in was in place is obsolete.
    resetCalendarHelperFallback();
    return 'granted';
  } catch (err) {
    if (err instanceof CalendarHelperError && err.code === 'permission-denied') return 'denied';
    return 'unknown';
  }
}

interface RawCalendar {
  id: string;
  title: string;
  account: string;
  color: string;
  readonly: boolean;
}

interface RawEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  account: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  readonly: boolean;
  /** Absent from a v3-or-older helper binary, and from events the source says
   *  nothing about — treat "missing" as "unknown", never as "confirmed". */
  status?: string;
  selfStatus?: string;
  /** Write-safety protocol fields; `unknown` because only the exact JSON type counts (absent = unknown). */
  writeSafetyVersion?: unknown;
  walnutCreated?: unknown;
  hasAttendees?: unknown;
  organizerIsCurrentUser?: unknown;
  organizerName?: unknown;
  recurring?: unknown;
}

const EVENT_STATUSES: readonly string[] = ['confirmed', 'tentative', 'canceled'];
const SELF_STATUSES: readonly string[] = ['pending', 'accepted', 'declined', 'tentative', 'delegated'];

/** Drop anything the helper reports that this build doesn't model, so a newer
 *  helper can add states without a type lie reaching API consumers. */
function asEventStatus(v: string | undefined): CalendarEventStatus | undefined {
  return v && EVENT_STATUSES.includes(v) ? (v as CalendarEventStatus) : undefined;
}

function asSelfStatus(v: string | undefined): CalendarSelfStatus | undefined {
  return v && SELF_STATUSES.includes(v) ? (v as CalendarSelfStatus) : undefined;
}

function toEvent(raw: RawEvent, colorByCalendar: Map<string, string>): CalendarEvent {
  const status = asEventStatus(raw.status);
  const selfStatus = asSelfStatus(raw.selfStatus);
  return {
    id: raw.id,
    source: 'eventkit',
    calendarId: raw.calendarId,
    calendarName: raw.calendarName,
    accountName: raw.account,
    title: raw.title,
    start: raw.start,
    end: raw.end,
    allDay: raw.allDay,
    color: colorByCalendar.get(raw.calendarId),
    ...(raw.location ? { location: raw.location } : {}),
    ...(raw.readonly ? { readonly: true } : {}),
    ...(status ? { status } : {}),
    ...(selfStatus ? { selfStatus } : {}),
    ...(raw.writeSafetyVersion === WRITE_SAFETY_VERSION ? { writeSafetyVersion: WRITE_SAFETY_VERSION } : {}),
    ...(typeof raw.walnutCreated === 'boolean' ? { walnutCreated: raw.walnutCreated } : {}),
    ...(typeof raw.hasAttendees === 'boolean' ? { hasAttendees: raw.hasAttendees } : {}),
    ...(typeof raw.organizerIsCurrentUser === 'boolean' ? { organizerIsCurrentUser: raw.organizerIsCurrentUser } : {}),
    ...(typeof raw.organizerName === 'string' && raw.organizerName ? { organizerName: raw.organizerName } : {}),
    ...(typeof raw.recurring === 'boolean' ? { recurring: raw.recurring } : {}),
  };
}

export function createEventKitSource(): CalendarSource {
  // Calendar colors change rarely; cache the calendar list per process and
  // refresh it on every listCalendars() call (Settings) or list() miss.
  let calendarCache: RawCalendar[] | null = null;

  const fetchCalendars = async (): Promise<RawCalendar[]> => {
    calendarCache = await runHelper<RawCalendar[]>(['calendars']);
    return calendarCache;
  };

  const colorMap = async (): Promise<Map<string, string>> => {
    const cals = calendarCache ?? (await fetchCalendars());
    return new Map(cals.map((c) => [c.id, c.color]));
  };

  return {
    id: 'eventkit',

    available(): { ok: boolean; reason?: CalendarSourceReason; message?: string } {
      if (CLOUD_MODE) {
        return { ok: false, reason: 'cloud', message: 'macOS calendars are not reachable from the cloud companion.' };
      }
      if (process.platform !== 'darwin') {
        return { ok: false, reason: 'not-configured', message: 'EventKit calendars require macOS.' };
      }
      return { ok: true };
    },

    degraded(): string | undefined {
      const fallback = calendarHelperFallback();
      if (!fallback) return undefined;
      return currentRoute?.kind === 'app'
        ? `Calendar now belongs to Walnut, which has not been allowed yet, so events are coming from the older helper (${fallback.version}). Settings → macOS Access → Calendar → Request access moves it over.`
        : `Calendar access was lost after the helper was rebuilt, so events are coming from the previous helper (${fallback.version}). Grant Calendars to Walnut again in System Settings → Privacy & Security → Calendars.`;
    },

    async listCalendars(): Promise<CalendarInfo[]> {
      // `hidden` is overlaid by CalendarService (it owns the config).
      return (await fetchCalendars()).map((c) => ({
        id: c.id,
        title: c.title,
        account: c.account,
        color: c.color,
        readonly: c.readonly,
        hidden: false,
      }));
    },

    async listEvents(from: string, to: string, opts?: { refresh?: boolean }): Promise<CalendarEvent[]> {
      // No hidden-calendar filtering here — CalendarService filters at read
      // time so its cache stays complete (unhiding needs no refetch).
      const raw = await runHelper<RawEvent[]>(
        opts?.refresh ? ['list', from, to, 'refresh'] : ['list', from, to]
      );
      const colors = await colorMap();
      return raw.map((e) => toEvent(e, colors));
    },

    async getEvent(id: string): Promise<CalendarEvent> {
      const raw = await runHelper<RawEvent>(['get', id], { safeWrite: true });
      return toEvent(raw, await colorMap());
    },

    async updateEvent(id: string, patch: CalendarEventPatch, opts?: CalendarWriteOptions): Promise<CalendarEvent> {
      if (!patch.start || !patch.end) {
        throw new CalendarHelperError('update requires start and end', 'usage');
      }
      const humanConfirm = opts?.humanConfirm === true;
      const args = ['update', id, patch.start, patch.end];
      // The title slot is always filled before the flag, so the flag can never be read as a title.
      if (patch.title !== undefined || humanConfirm) args.push(patch.title ?? '');
      if (humanConfirm) args.push(HUMAN_CONFIRM_FLAG);
      const raw = await runHelper<RawEvent>(args, { safeWrite: true, humanConfirm });
      return toEvent(raw, await colorMap());
    },

    async createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
      const raw = await runHelper<RawEvent>([
        'create',
        input.calendarId,
        input.title,
        input.start,
        input.end,
        String(!!input.allDay),
      ], { safeWrite: true });
      return toEvent(raw, await colorMap());
    },

    async deleteEvent(id: string, opts?: CalendarWriteOptions): Promise<void> {
      const humanConfirm = opts?.humanConfirm === true;
      await runHelper<{ ok: boolean }>(
        humanConfirm ? ['delete', id, HUMAN_CONFIRM_FLAG] : ['delete', id],
        { safeWrite: true, humanConfirm },
      );
    },
  };
}
