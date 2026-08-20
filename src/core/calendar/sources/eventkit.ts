/**
 * EventKit calendar source — shells out to the walnut-calendar Swift helper,
 * which reads/writes ALL system-account calendars (iCloud, Google, Exchange…)
 * using the Mac's existing logins. No per-provider OAuth in Walnut; macOS
 * owns cloud sync.
 *
 * Helper compile pattern follows attachment-text.ts (walnut-extract): source
 * ships in src/data/, `xcrun swiftc -O` lazily once per machine into
 * WALNUT_HOME/cache, versioned binary name. No swiftc → source reports
 * not-configured with an actionable message instead of crashing.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALNUT_HOME, CLOUD_MODE } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarInfo,
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
// NOTE: every version bump (or any recompile) changes the binary's cdhash,
// which is the identity TCC keys the grant to — so users see ONE fresh
// permission prompt after an upgrade. That is expected, not a regression;
// the Permission Doctor exists to walk them through it.
const HELPER_VERSION = 'v3';
const HELPER_TIMEOUT_MS = 30_000;

/** Embedded plist: tccd reads usage keys from here once the helper is its own
 *  responsible process. Both keys required — macOS 14+ wants the FullAccess
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

function helperSourcePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'data/walnut-calendar.swift'), // dist/cli.js → dist/data
    path.resolve(here, '../data/walnut-calendar.swift'),
    path.resolve(here, '../../../src/data/walnut-calendar.swift'), // src/core/calendar/sources → src/data
    path.resolve(here, '../../data/walnut-calendar.swift'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

let helperPromise: Promise<string | null> | null = null;

async function ensureHelper(): Promise<string | null> {
  if (helperPromise) return helperPromise;
  helperPromise = (async () => {
    if (process.platform !== 'darwin' || CLOUD_MODE) return null;
    const bin = path.join(WALNUT_HOME, 'cache', `walnut-calendar-${HELPER_VERSION}`);
    if (fs.existsSync(bin)) return bin;
    const src = helperSourcePath();
    if (!fs.existsSync(src)) {
      log.calendar.warn('eventkit: helper source missing, calendar disabled', { src });
      return null;
    }
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    // Embed the Info.plist into the binary (__TEXT,__info_plist) so tccd can
    // read the calendar usage keys when the helper disclaims responsibility.
    const plistPath = path.join(WALNUT_HOME, 'cache', `walnut-calendar-${HELPER_VERSION}.plist`);
    await fsp.writeFile(plistPath, HELPER_INFO_PLIST);
    const compiled = await new Promise<boolean>((resolve) => {
      const child = spawn(
        'nice',
        ['-n', '10', 'xcrun', 'swiftc', '-O', '-o', bin, src,
         '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
         '-Xlinker', plistPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => {
        if (code !== 0) {
          log.calendar.warn('eventkit: swift compile failed, calendar disabled', {
            error: stderr.slice(0, 400),
          });
        }
        resolve(code === 0);
      });
    });
    return compiled ? bin : null;
  })();
  return helperPromise;
}

/** Run a helper subcommand; helper always emits JSON (error shape on exit 1). */
async function runHelper<T>(args: string[]): Promise<T> {
  const bin = await ensureHelper();
  if (!bin) {
    throw new CalendarHelperError(
      'Calendar helper unavailable (needs macOS + Xcode Command Line Tools for one-time compile).',
      'not-configured'
    );
  }
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch (err) {
    // Non-zero exit still prints a JSON error payload on stdout.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout) as HelperError;
        throw new CalendarHelperError(parsed.error, parsed.code);
      } catch (parseErr) {
        if (parseErr instanceof CalendarHelperError) throw parseErr;
      }
    }
    throw new CalendarHelperError(
      `calendar helper failed: ${(err as Error).message?.slice(0, 200)}`,
      'fetch-error'
    );
  }
}

/**
 * Permission Doctor probe: current calendar authorization WITHOUT prompting.
 * Safe to poll (the `status` subcommand never touches requestAccess). Returns
 * 'unknown' when the helper can't run at all (no swiftc, non-macOS) — callers
 * must not present that as "denied", the fixes differ.
 */
export async function calendarAuthStatus(): Promise<'granted' | 'denied' | 'not-determined' | 'unknown'> {
  try {
    const { state } = await runHelper<{ state: string }>(['status']);
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
    await runHelper<unknown>(['calendars']);
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
}

function toEvent(raw: RawEvent, colorByCalendar: Map<string, string>): CalendarEvent {
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

    async listEvents(from: string, to: string): Promise<CalendarEvent[]> {
      // No hidden-calendar filtering here — CalendarService filters at read
      // time so its cache stays complete (unhiding needs no refetch).
      const raw = await runHelper<RawEvent[]>(['list', from, to]);
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
