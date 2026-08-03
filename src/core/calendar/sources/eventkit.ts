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
const HELPER_VERSION = 'v1';
const HELPER_TIMEOUT_MS = 30_000;

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
    const compiled = await new Promise<boolean>((resolve) => {
      const child = spawn('nice', ['-n', '10', 'xcrun', 'swiftc', '-O', '-o', bin, src], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
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
