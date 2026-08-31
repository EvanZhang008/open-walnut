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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLOUD_MODE } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import { ensureHelper, olderHelperGenerations, type HelperSpec } from '../../helper-build.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarEventStatus,
  CalendarInfo,
  CalendarSelfStatus,
  CalendarSource,
  CalendarSourceReason,
} from '../types.js';

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
const HELPER_VERSION = 'v5';
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

/** Thrown for helper-reported failures so routes can map codes → HTTP. */
export class CalendarHelperError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'CalendarHelperError';
  }
}

const HELPER_SPEC: HelperSpec = {
  name: 'walnut-calendar',
  version: HELPER_VERSION,
  /** Version-free on purpose: a certificate-signed calendar grant is remembered
   *  against this string, so it must not move when HELPER_VERSION does. */
  identifier: 'dev.openwalnut.calendar',
  infoPlist: HELPER_INFO_PLIST,
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
}

async function execHelper<T>(bin: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(bin, args, {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/**
 * First older generation that both HOLDS the grant and speaks the protocol we
 * need. `status` answers the permission question without side effects; `calendars`
 * proves the binary actually understands the subcommands (a generation older than
 * the JSON shapes used here would parse but not match, and an array of calendars
 * is the cheapest thing that fails loudly if it does not).
 */
async function findGrantedOlderHelper(): Promise<string | null> {
  for (const bin of olderHelperGenerations(HELPER_SPEC)) {
    try {
      const { state } = await execHelper<{ state?: string }>(bin, ['status']);
      if (state !== 'granted') continue;
      const cals = await execHelper<unknown>(bin, ['calendars']);
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
async function runHelper<T>(args: string[], opts?: { currentOnly?: boolean }): Promise<T> {
  const current = await ensureHelper(HELPER_SPEC, 'walnut-calendar.swift');
  const bin = opts?.currentOnly ? current : (fallbackBin ?? current);
  if (!bin) {
    throw new CalendarHelperError(
      'Calendar helper unavailable (needs macOS + Xcode Command Line Tools for one-time compile).',
      'not-configured'
    );
  }
  try {
    return await execHelper<T>(bin, args);
  } catch (err) {
    const mapped = toHelperError(err);
    // A denial on the CURRENT generation is the one failure a previous generation
    // can still answer, so try that before reporting an empty calendar.
    if (
      mapped.code === 'permission-denied' &&
      !opts?.currentOnly &&
      bin === current &&
      Date.now() - lastFallbackProbe > FALLBACK_PROBE_COOLDOWN_MS
    ) {
      lastFallbackProbe = Date.now();
      const older = await findGrantedOlderHelper();
      if (older) {
        fallbackBin = older;
        log.calendar.warn('calendar permission lost on the current helper, using an older one', {
          current: bin,
          fallback: older,
          note: 'grant Calendars to the current helper again in System Settings → Privacy & Security → Calendars',
        });
        return await execHelper<T>(older, args);
      }
    }
    throw mapped;
  }
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
      return `Calendar access was lost after the helper was rebuilt, so events are coming from the previous helper (${fallback.version}). Grant Calendars to Walnut again in System Settings → Privacy & Security → Calendars.`;
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

    async updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
      if (!patch.start || !patch.end) {
        throw new CalendarHelperError('update requires start and end', 'usage');
      }
      const args = ['update', id, patch.start, patch.end];
      if (patch.title !== undefined) args.push(patch.title);
      const raw = await runHelper<RawEvent>(args);
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
      ]);
      return toEvent(raw, await colorMap());
    },

    async deleteEvent(id: string): Promise<void> {
      await runHelper<{ ok: boolean }>(['delete', id]);
    },
  };
}
