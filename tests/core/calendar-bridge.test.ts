/**
 * Calendar requests go to Walnut.app first, so the Calendars grant belongs to Walnut.
 *
 * Every helper generation was its own program to macOS, and each version bump asked
 * for Calendars again (walnut-calendar-v2 … v6). Walnut.app is one certificate-signed
 * identity the user already knows. What this file pins:
 *
 *  - the route: Walnut.app when it knows `--calendar-bridge`, the helper when not;
 *  - the migration: while Walnut is not granted yet, the helper the user DID grant
 *    keeps the calendar full instead of going dark;
 *  - the gate: a server on a temporary data dir never runs the real Walnut.app
 *    either, since that puts the same dialog on the user's screen;
 *  - the Swift side agrees with this one (flag, build scripts, dispatch order), and
 *    the shared source refuses an unknown subcommand BEFORE asking for access.
 *
 * No process runs here: the program runner and the helper builder are faked, and
 * the assertion is the argv each request was sent to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-calendar-bridge'));

const APP = '/Applications/Walnut.app';
const APP_EXE = `${APP}/Contents/MacOS/Walnut`;
const HELPER = '/cache/walnut-calendar-v6';

/** What each program answers, keyed by argv[0], then by subcommand. */
type Answer = { ok: unknown } | { denied: true };
let answers: Record<string, Record<string, Answer>> = {};
let calls: string[][] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    // The bridge flag is not the subcommand; skip it to find what was asked.
    const sub = args[0] === '--calendar-bridge' ? args[1] : args[0];
    const answer = answers[file]?.[sub!];
    if (!answer) throw Object.assign(new Error(`no answer for ${file} ${sub}`), { stdout: '' });
    if ('denied' in answer) {
      throw Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify({ error: 'Calendar access denied', code: 'permission-denied' }),
      });
    }
    return { stdout: JSON.stringify(answer.ok), stderr: '' };
  };
  const execFile = Object.assign(() => { throw new Error('callback form unused'); }, {
    [promisify.custom]: run,
  });
  return { ...actual, execFile };
});

let appInstalled = true;
let gateOpen = true;
/** Whether a helper binary was ever built here (a fresh install has none). */
let helperBuilt = true;
let ensureHelperCalls = 0;
const findCalls: string[] = [];

vi.mock('../../src/providers/desktop-app.js', () => ({
  findDesktopAppWith: async (flag: string) => {
    findCalls.push(flag);
    return appInstalled ? { app: APP, executable: APP_EXE } : null;
  },
}));

vi.mock('../../src/core/helper-build.js', () => ({
  nativeHelpersAllowed: () => gateOpen,
  ensureHelper: async () => {
    ensureHelperCalls += 1;
    return gateOpen ? HELPER : null;
  },
  existingHelperBinary: () => (gateOpen && helperBuilt ? HELPER : null),
  olderHelperGenerations: () => [],
  helperFailure: () => (gateOpen ? null : 'ephemeral'),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function load() {
  // Fresh module per test: the route, the fallback and the calendar cache are
  // module state, and a test must never inherit the previous one's.
  vi.resetModules();
  return import('../../src/core/calendar/sources/eventkit.js');
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  answers = {};
  calls = [];
  appInstalled = true;
  gateOpen = true;
  helperBuilt = true;
  ensureHelperCalls = 0;
  findCalls.length = 0;
  return () => Object.defineProperty(process, 'platform', realPlatform);
});

const CALS = [{ id: 'c1', title: 'Home', account: 'iCloud', color: '#FF0000', readonly: false }];

describe('calendar route', () => {
  it('asks Walnut.app when it knows the bridge, and never builds the helper', async () => {
    answers[APP_EXE] = { calendars: { ok: CALS }, status: { ok: { state: 'granted' } } };
    const ek = await load();

    const source = ek.createEventKitSource();
    const cals = await source.listCalendars();

    expect(cals.map((c) => c.title)).toEqual(['Home']);
    // One status check (has Walnut ever been asked?), then Walnut itself.
    expect(calls).toEqual([
      [APP_EXE, '--calendar-bridge', 'status'],
      [APP_EXE, '--calendar-bridge', 'calendars'],
    ]);
    expect(ensureHelperCalls).toBe(0);
    // Once Walnut has answered, no more checks: a read is one process.
    answers[APP_EXE]!.list = { ok: [] };
    calls = [];
    await source.listEvents('2026-09-01', '2026-09-30');
    expect(calls).toEqual([[APP_EXE, '--calendar-bridge', 'list', '2026-09-01', '2026-09-30']]);
    expect(await ek.calendarGrantApp()).toBe(APP);
    // The Permission Doctor reads the APP's grant, not a helper's.
    expect(await ek.calendarAuthStatus()).toBe('granted');
    expect(calls.at(-1)).toEqual([APP_EXE, '--calendar-bridge', 'status']);
  });

  it('uses the helper when there is no Walnut.app that knows the bridge', async () => {
    appInstalled = false;
    answers[HELPER] = { calendars: { ok: CALS } };
    const ek = await load();

    await ek.createEventKitSource().listCalendars();

    expect(calls).toEqual([[HELPER, 'calendars']]);
    expect(ensureHelperCalls).toBe(1);
    // Null means "the helper asks for itself", which is what the row then says.
    expect(await ek.calendarGrantApp()).toBeNull();
  });

  it('while Walnut was never asked, reads go through the granted helper and nothing prompts', async () => {
    // The moment of the move: the user granted walnut-calendar-v6 long ago and
    // Walnut has never asked. A read must NOT ask Walnut, because that puts the
    // Calendars dialog up from a background poll; the old grant answers instead.
    answers[APP_EXE] = { status: { ok: { state: 'not-determined' } } };
    answers[HELPER] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS } };
    const ek = await load();
    const source = ek.createEventKitSource();

    const cals = await source.listCalendars();

    expect(cals.map((c) => c.title)).toEqual(['Home']);
    expect(calls).toEqual([
      [APP_EXE, '--calendar-bridge', 'status'],
      [HELPER, 'status'],
      [HELPER, 'calendars'],
      [HELPER, 'calendars'],
    ]);
    // Walnut was only ever asked `status`, the one subcommand that cannot prompt.
    expect(calls.filter((c) => c[0] === APP_EXE && c[2] !== 'status')).toEqual([]);
    // An EXISTING helper only: compiling one to ask it would mint a new program.
    expect(ensureHelperCalls).toBe(0);
    expect(ek.calendarHelperFallback()).toEqual({ path: HELPER, version: 'v6' });
    // Points at Walnut's own Settings: macOS lists Walnut under Calendars only
    // after it has asked, so "open System Settings" would find nothing to turn on.
    expect(source.degraded()).toContain('Request access');
    expect(source.degraded()).not.toContain('System Settings');

    // The Permission Doctor reports WALNUT's state, not the stand-in's "granted",
    // or the user would be sent away with the move still undone.
    expect(await ek.calendarAuthStatus()).toBe('not-determined');
  });

  it('Request access asks Walnut, and then Walnut takes over from the helper', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'not-determined' } } };
    answers[HELPER] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS } };
    const ek = await load();
    const source = ek.createEventKitSource();
    await source.listCalendars();
    expect(ek.calendarHelperFallback()).not.toBeNull();

    // The user presses Request access and allows it.
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, list: { ok: [] } };
    calls = [];
    expect(await ek.requestCalendarAccess()).toBe('granted');
    expect(calls).toEqual([[APP_EXE, '--calendar-bridge', 'calendars']]);
    expect(ek.calendarHelperFallback()).toBeNull();

    calls = [];
    await source.listEvents('2026-09-01', '2026-09-30');
    expect(calls.map((c) => c[0])).toEqual([APP_EXE, APP_EXE]);
    expect(calls.at(-1)).toEqual([APP_EXE, '--calendar-bridge', 'list', '2026-09-01', '2026-09-30']);
  });

  it('after Walnut is refused, the granted helper still keeps the calendar full', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'denied' } }, calendars: { denied: true } };
    answers[HELPER] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS } };
    const ek = await load();

    const cals = await ek.createEventKitSource().listCalendars();

    expect(cals.map((c) => c.title)).toEqual(['Home']);
    expect(calls).toEqual([
      [APP_EXE, '--calendar-bridge', 'status'],
      [APP_EXE, '--calendar-bridge', 'calendars'],
      [HELPER, 'status'],
      [HELPER, 'calendars'],
      [HELPER, 'calendars'],
    ]);
  });

  it('with no granted helper to stand in, Walnut asks (the fresh install)', async () => {
    helperBuilt = false;
    answers[APP_EXE] = { status: { ok: { state: 'not-determined' } }, calendars: { ok: CALS } };
    const ek = await load();

    await ek.createEventKitSource().listCalendars();

    expect(calls).toEqual([
      [APP_EXE, '--calendar-bridge', 'status'],
      [APP_EXE, '--calendar-bridge', 'calendars'],
    ]);
    expect(ek.calendarHelperFallback()).toBeNull();
  });

  it('on a temporary data dir runs neither Walnut.app nor a helper', async () => {
    gateOpen = false;
    const ek = await load();

    await expect(ek.createEventKitSource().listCalendars()).rejects.toThrow(/temporary data dir/);

    expect(findCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(await ek.calendarAuthStatus()).toBe('unknown');
  });
});

describe('the Swift side agrees', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

  it('uses the same flag', async () => {
    const { CALENDAR_BRIDGE_FLAG } = await load();
    const swift = read('desktop/CalendarBridge.swift');
    expect(swift).toContain(`let calendarBridgeFlag = "${CALENDAR_BRIDGE_FLAG}"`);
  });

  it('builds the shared source into every app binary', () => {
    // A build script that forgets it produces an app without the flag, which the
    // server then silently routes around: correct, but the grant never moves.
    for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
      const compiles = read(script).split('swiftc ').slice(1);
      expect(compiles.length, script).toBeGreaterThan(0);
      for (const cmd of compiles) {
        const invocation = cmd.slice(0, cmd.indexOf('-framework Carbon'));
        expect(invocation, script).toContain('CalendarBridge.swift');
        expect(invocation, script).toContain('src/data/walnut-calendar.swift');
        expect(invocation, script).toContain('-D WALNUT_APP');
      }
    }
  });

  it('dispatches the bridge before the app exists', () => {
    // After NSApplication.shared, a calendar request would be a visible app instance.
    const main = read('desktop/main.swift');
    const bridge = main.indexOf('runCalendarBridgeIfRequested()');
    expect(bridge).toBeGreaterThan(0);
    expect(bridge).toBeLessThan(main.indexOf('NSApplication.shared'));
  });

  it('refuses an unknown subcommand before asking for Calendars', () => {
    // 2026-09-26: `helper bogus` asked for Calendars, THEN answered "usage", and a
    // real dialog appeared on the user's screen for a typo.
    const src = read('src/data/walnut-calendar.swift');
    const body = src.slice(src.indexOf('func walnutCalendarMain'));
    const guard = body.indexOf('unknown subcommand');
    const request = body.indexOf('\nrequestAccess()');
    expect(guard).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(0);
    expect(guard).toBeLessThan(request);
  });
});
