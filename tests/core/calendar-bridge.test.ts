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
 *    the shared source refuses an unknown subcommand BEFORE asking for access;
 *  - write safety: a write, or the `get` it is checked against, only ever goes to a
 *    binary that proves the write-safety protocol (an upgraded Walnut.app, else the
 *    current helper), never to a read stand-in or an older generation, which would
 *    change somebody else's invitation without checking whose it is.
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
import { calendarEventNeedsApproval } from '../../src/integrations/calendar/types.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-calendar-bridge'));

const APP = '/Applications/Walnut.app';
const APP_EXE = `${APP}/Contents/MacOS/Walnut`;
const HELPER = '/cache/walnut-calendar-v7';
/** A previous generation: may hold the grant for reads, must never be written through. */
const OLD = '/cache/walnut-calendar-v6';

/** What each program answers, keyed by argv[0], then by subcommand. */
type Answer =
  | { ok: unknown }
  | { denied: true }
  | { fail: { error: string; code: string } }
  /** Never exits on its own (a native dialog nobody answers) until its process group is killed. */
  | { hang: true };
let answers: Record<string, Record<string, Answer>> = {};
let calls: string[][] = [];
/** The execFile options of each call, index-aligned with `calls`. */
let options: ({ timeout?: number; detached?: boolean } | undefined)[] = [];
/** Every program "runs" as this pid, so a group kill is `process.kill(-HUNG_PID)`. */
const HUNG_PID = 4242;
let killHung: ((signal: string) => void) | null = null;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const answer = async (file: string, args: string[]) => {
    // The bridge flag is not the subcommand; skip it to find what was asked.
    const sub = args[0] === '--calendar-bridge' ? args[1] : args[0];
    const reply = answers[file]?.[sub!];
    if (!reply) throw Object.assign(new Error(`no answer for ${file} ${sub}`), { stdout: '' });
    if ('denied' in reply) {
      throw Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify({ error: 'Calendar access denied', code: 'permission-denied' }),
      });
    }
    if ('fail' in reply) throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify(reply.fail) });
    if ('hang' in reply) {
      return new Promise<never>((_, reject) => {
        killHung = (signal) => reject(Object.assign(new Error('Command failed'), { signal, stdout: '' }));
      });
    }
    return { stdout: JSON.stringify(reply.ok), stderr: '' };
  };
  const run = async (file: string, args: string[], opts?: { timeout?: number; detached?: boolean }) => {
    calls.push([file, ...args]);
    options.push(opts);
    return answer(file, args);
  };
  // Writes use spawn (their own process group); same answers, delivered the way a child exits.
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawn = (file: string, args: string[], opts?: { detached?: boolean }) => {
    calls.push([file, ...args]);
    options.push(opts);
    const child = Object.assign(new EventEmitter(), {
      pid: HUNG_PID, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const exit = (stdout: string, code: number | null, signal: string | null) => {
      child.stdout.on('end', () => child.emit('close', code, signal));
      child.stdout.end(stdout);
      child.stderr.end();
    };
    answer(file, args).then(
      (r) => exit(r.stdout, 0, null),
      (err: { stdout?: string; signal?: string }) => exit(err.stdout ?? '', err.signal ? null : 1, err.signal ?? null),
    );
    return child;
  };
  const execFile = Object.assign(() => { throw new Error('callback form unused'); }, {
    [promisify.custom]: run,
  });
  return { ...actual, execFile, spawn };
});

let appInstalled = true;
let gateOpen = true;
/** Whether a helper binary was ever built here (a fresh install has none). */
let helperBuilt = true;
let ensureHelperCalls = 0;
/** The helper compile failed (no Xcode command line tools): ensureHelper answers null. */
let buildFailed = false;
let olderGenerations: string[] = [];
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
    return gateOpen && !buildFailed ? HELPER : null;
  },
  existingHelperBinary: () => (gateOpen && helperBuilt ? HELPER : null),
  olderHelperGenerations: () => (gateOpen ? olderGenerations : []),
  helperFailure: () => (!gateOpen ? 'ephemeral' : buildFailed ? 'no_compiler' : null),
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
  options = [];
  killHung = null;
  appInstalled = true;
  gateOpen = true;
  helperBuilt = true;
  ensureHelperCalls = 0;
  buildFailed = false;
  olderGenerations = [];
  findCalls.length = 0;
  return () => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  };
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
    // The Permission Doctor reads the APP's grant, not a helper's, and then checks where
    // writes would go using only probes that cannot prompt.
    calls = [];
    expect(await ek.calendarAuthStatus()).toBe('granted');
    expect(calls[0]).toEqual([APP_EXE, '--calendar-bridge', 'status']);
    expect(calls.map((c) => c.at(-1))).toEqual(['status', 'capabilities', 'capabilities']);
  });

  it('uses the helper when there is no Walnut.app that knows the bridge', async () => {
    appInstalled = false;
    answers[HELPER] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS } };
    const ek = await load();

    await ek.createEventKitSource().listCalendars();

    // One status check (has this generation ever been asked?), then the helper itself.
    expect(calls).toEqual([[HELPER, 'status'], [HELPER, 'calendars']]);
    expect(ensureHelperCalls).toBe(1);
    // Null means "the helper asks for itself", which is what the row then says.
    expect(await ek.calendarGrantApp()).toBeNull();
  });

  it('while Walnut was never asked, reads go through the granted helper and nothing prompts', async () => {
    // The moment of the move: the user granted the helper long ago and
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
    expect(ek.calendarHelperFallback()).toEqual({ path: HELPER, version: 'v7' });
    // Points at Walnut's own Settings: macOS lists Walnut under Calendars only
    // after it has asked, so "open System Settings" would find nothing to turn on.
    expect(source.degraded?.()).toContain('Request access');
    expect(source.degraded?.()).not.toContain('System Settings');

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

    // The user presses Request access and allows it. An app that does its own writes is the
    // only program asked: the probe after it cannot prompt.
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, list: { ok: [] }, capabilities: SAFE };
    calls = [];
    expect(await ek.requestCalendarAccess()).toBe('granted');
    expect(calls).toEqual([[APP_EXE, '--calendar-bridge', 'calendars'], [APP_EXE, '--calendar-bridge', 'capabilities']]);
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

const SAFE = { ok: { writeSafetyVersion: 1 } };
/** What a binary that predates the protocol answers: refused before it asks for access. */
const UNKNOWN_SUB = { fail: { error: 'unknown subcommand: capabilities', code: 'usage' } };
const RAW = {
  id: 'e1', calendarId: 'c1', calendarName: 'Home', account: 'iCloud', title: 'Focus',
  start: '2026-10-08T09:00:00', end: '2026-10-08T10:00:00', allDay: false, readonly: false,
};
const OWN_BLOCK = {
  ...RAW, writeSafetyVersion: 1, walnutCreated: true, hasAttendees: false,
  organizerIsCurrentUser: true, organizerName: 'Me', recurring: false,
};
const WRITES = ['create', 'update', 'delete'];
const SPAN = { start: '2026-10-08T11:00:00', end: '2026-10-08T12:00:00' };
/** Every write subcommand (and pre-write `get`) any program was sent, as `[program, sub]`. */
const writesSent = () =>
  calls
    .map((c) => [c[0]!, c[1] === '--calendar-bridge' ? c[2]! : c[1]!] as const)
    .filter(([, sub]) => [...WRITES, 'get'].includes(sub));

describe('write safety', () => {
  it('an upgraded Walnut.app that proves the protocol takes the writes, and no helper is built', async () => {
    answers[APP_EXE] = {
      status: { ok: { state: 'granted' } }, calendars: { ok: CALS },
      capabilities: SAFE, update: { ok: OWN_BLOCK }, get: { ok: OWN_BLOCK },
    };
    const ek = await load();
    const source = ek.createEventKitSource();

    await source.getEvent!('e1');
    await source.updateEvent('e1', SPAN);

    expect(writesSent()).toEqual([[APP_EXE, 'get'], [APP_EXE, 'update']]);
    // Each write is preceded by its own probe: a cached "yes" could outlive the binary.
    const subs = calls.map((c) => c[2]);
    expect(subs.indexOf('capabilities')).toBeLessThan(subs.indexOf('get'));
    expect(subs.filter((s) => s === 'capabilities')).toHaveLength(2);
    expect(ensureHelperCalls).toBe(0);
  });

  it('an old Walnut.app keeps the reads, while every write goes to the current helper', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, list: { ok: [] }, capabilities: UNKNOWN_SUB };
    answers[HELPER] = {
      status: { ok: { state: 'granted' } },
      capabilities: SAFE, get: { ok: OWN_BLOCK }, update: { ok: OWN_BLOCK },
      create: { ok: OWN_BLOCK }, delete: { ok: { ok: true } },
    };
    const ek = await load();
    const source = ek.createEventKitSource();

    await source.listEvents('2026-10-01', '2026-10-31');
    await source.getEvent!('e1');
    await source.updateEvent('e1', { ...SPAN, title: 'Deep work' });
    await source.createEvent({ calendarId: 'c1', title: 'Block', ...SPAN });
    await source.deleteEvent('e1');

    expect(writesSent()).toEqual([[HELPER, 'get'], [HELPER, 'update'], [HELPER, 'create'], [HELPER, 'delete']]);
    expect(calls.filter((c) => c[0] === APP_EXE).map((c) => c[2])).not.toContain('update');
    // Reads stay on Walnut.app, so switching writes adds no Calendars prompt to a background read.
    expect(calls.find((c) => c[2] === 'list')?.[0]).toBe(APP_EXE);
  });

  it('with nothing that proves the protocol, no write runs anywhere, not even through a granted older helper', async () => {
    // Walnut never asked, so reads come from an OLDER generation that would happily write.
    helperBuilt = false;
    olderGenerations = [OLD];
    answers[APP_EXE] = { status: { ok: { state: 'not-determined' } }, capabilities: UNKNOWN_SUB };
    answers[OLD] = {
      status: { ok: { state: 'granted' } }, calendars: { ok: CALS },
      get: { ok: RAW }, update: { ok: RAW }, create: { ok: RAW }, delete: { ok: { ok: true } },
    };
    answers[HELPER] = {};
    const ek = await load();
    const source = ek.createEventKitSource();
    await source.listCalendars();
    expect(ek.calendarHelperFallback()?.path).toBe(OLD);

    // A helper that cannot answer, answers a string, an unknown version, or nothing at all.
    for (const caps of [undefined, { ok: { writeSafetyVersion: '1' } }, { ok: { writeSafetyVersion: 2 } }, { ok: {} }]) {
      if (caps) answers[HELPER]!.capabilities = caps;
      for (const attempt of [
        () => source.getEvent!('e1'),
        () => source.updateEvent('e1', SPAN, { humanConfirm: true }),
        () => source.createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }),
        () => source.deleteEvent('e1', { humanConfirm: true }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: 'human-approval-required' });
      }
    }
    expect(writesSent()).toEqual([]);
  });

  it('a protected write carries the confirmation flag last and waits 90s; a plain one neither', async () => {
    answers[APP_EXE] = {
      status: { ok: { state: 'granted' } }, calendars: { ok: CALS },
      capabilities: SAFE, update: { ok: OWN_BLOCK }, delete: { ok: { ok: true } },
    };
    const ek = await load();
    const source = ek.createEventKitSource();
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await source.updateEvent('e1', SPAN, { humanConfirm: true });
    await source.updateEvent('e1', { ...SPAN, title: 'Renamed' }, { humanConfirm: true });
    await source.deleteEvent('e1', { humanConfirm: true });
    await source.updateEvent('e1', SPAN);
    await source.deleteEvent('e1');
    // Only a real boolean asks: a string "true" from a tool call is not a confirmation request.
    await source.deleteEvent('e1', { humanConfirm: 'true' as unknown as boolean });

    const writes = calls.filter((c) => WRITES.includes(c[2]!)).map((c) => c.slice(2));
    expect(writes).toEqual([
      // The empty title slot keeps the flag out of the title position.
      ['update', 'e1', SPAN.start, SPAN.end, '', '--human-confirm'],
      ['update', 'e1', SPAN.start, SPAN.end, 'Renamed', '--human-confirm'],
      ['delete', 'e1', '--human-confirm'],
      ['update', 'e1', SPAN.start, SPAN.end],
      ['delete', 'e1'],
      ['delete', 'e1'],
    ]);
    // Writes run in their own process group with our own deadline, never execFile's.
    for (const [i, c] of calls.entries()) {
      if (WRITES.includes(c[2]!)) expect(options[i]).toMatchObject({ detached: true });
      if (WRITES.includes(c[2]!)) expect(options[i]?.timeout).toBeUndefined();
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it('a confirmation nobody answers is killed with its whole group at 90s and reported as not approved', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: SAFE, delete: { hang: true } };
    const ek = await load();
    const source = ek.createEventKitSource();
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
      if (pid === -HUNG_PID) killHung?.(signal);
      return true;
    }) as typeof process.kill);

    const result = source.deleteEvent('e1', { humanConfirm: true });
    const settled = expect(result).rejects.toMatchObject({ code: 'human-approval-required', message: /timed out/i });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The NEGATIVE pid: the disclaimed child that shows the dialog dies too, so no late click can write.
    expect(kill).toHaveBeenCalledWith(-HUNG_PID, 'SIGKILL');
    await settled;
  });

  it('a plain write that hangs is killed at 30s', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: SAFE, delete: { hang: true } };
    const ek = await load();
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
      if (pid === -HUNG_PID) killHung?.(signal);
      return true;
    }) as typeof process.kill);

    const settled = expect(ek.createEventKitSource().deleteEvent('e1')).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kill).toHaveBeenCalledWith(-HUNG_PID, 'SIGKILL');
    await settled;
  });

  it("the helper's own refusal reaches the caller unchanged and is not retried elsewhere", async () => {
    answers[APP_EXE] = {
      status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: SAFE,
      update: { fail: { error: 'This event belongs to someone else.', code: 'human-approval-required' } },
    };
    answers[HELPER] = { capabilities: SAFE, update: { ok: OWN_BLOCK } };
    const ek = await load();

    await expect(ek.createEventKitSource().updateEvent('e1', SPAN)).rejects.toMatchObject({
      code: 'human-approval-required', message: 'This event belongs to someone else.',
    });
    expect(writesSent()).toEqual([[APP_EXE, 'update']]);
  });

  it('a capable Walnut.app that is denied hands the write to the current helper, never an older one', async () => {
    olderGenerations = [OLD];
    answers[APP_EXE] = { status: { ok: { state: 'denied' } }, capabilities: SAFE, update: { denied: true }, calendars: { denied: true } };
    answers[HELPER] = { status: { ok: { state: 'granted' } }, capabilities: SAFE, update: { ok: OWN_BLOCK }, calendars: { ok: CALS } };
    answers[OLD] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, update: { ok: RAW } };
    const ek = await load();

    const updated = await ek.createEventKitSource().updateEvent('e1', SPAN);

    expect(updated.walnutCreated).toBe(true);
    // Its `status` already says denied, so the write is never sent to it at all.
    expect(writesSent()).toEqual([[HELPER, 'update']]);

    // And when the app's status said yes but the write itself was refused, the helper still answers.
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, capabilities: SAFE, update: { denied: true }, calendars: { ok: CALS } };
    calls = [];
    await ek.createEventKitSource().updateEvent('e1', SPAN);
    expect(writesSent()).toEqual([[APP_EXE, 'update'], [HELPER, 'update']]);
  });

  it('on the helper route, a new generation never asked prompts neither from a read nor from a write', async () => {
    appInstalled = false;
    olderGenerations = [OLD];
    answers[HELPER] = { status: { ok: { state: 'not-determined' } }, capabilities: SAFE, update: { ok: OWN_BLOCK } };
    answers[OLD] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, update: { ok: RAW } };
    const ek = await load();
    const source = ek.createEventKitSource();

    await source.listCalendars();
    // `status` is the only thing the new generation was asked: it cannot prompt.
    expect(calls).toEqual([[HELPER, 'status'], [OLD, 'status'], [OLD, 'calendars'], [OLD, 'calendars']]);

    // A write to it would put the Calendars request up and wait 30s on it: refused at once instead.
    await expect(source.updateEvent('e1', SPAN)).rejects.toMatchObject({ code: 'permission-denied', message: /Request access/ });
    expect(writesSent()).toEqual([]);

    // Once it is granted (Request access), the same write goes through to it.
    answers[HELPER]!.status = { ok: { state: 'granted' } };
    await source.updateEvent('e1', SPAN);
    expect(writesSent()).toEqual([[HELPER, 'update']]);
  });

  it('a Permission Doctor status poll first does not end the check: the read still goes to the granted older helper', async () => {
    appInstalled = false;
    olderGenerations = [OLD];
    answers[HELPER] = { status: { ok: { state: 'not-determined' } } };
    answers[OLD] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS } };
    const ek = await load();

    expect(await ek.calendarAuthStatus()).toBe('not-determined');
    await ek.createEventKitSource().listCalendars();

    expect(calls).toEqual([[HELPER, 'status'], [HELPER, 'status'], [OLD, 'status'], [OLD, 'calendars'], [OLD, 'calendars']]);
    expect(calls).not.toContainEqual([HELPER, 'calendars']);
  });

  it('copies the ownership fields only with their real JSON types; absent stays unknown', async () => {
    answers[APP_EXE] = {
      status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: SAFE,
      list: { ok: [RAW] },
    };
    const ek = await load();
    const source = ek.createEventKitSource();

    answers[APP_EXE]!.get = { ok: OWN_BLOCK };
    const own = await source.getEvent!('e1');
    expect(own).toMatchObject({
      writeSafetyVersion: 1, walnutCreated: true, hasAttendees: false,
      organizerIsCurrentUser: true, organizerName: 'Me', recurring: false,
    });
    expect(calendarEventNeedsApproval(own)).toBe(false);

    answers[APP_EXE]!.get = {
      ok: { ...RAW, writeSafetyVersion: '1', walnutCreated: 'true', hasAttendees: 0, organizerIsCurrentUser: 'yes', organizerName: 7, recurring: 'false' },
    };
    const lying = await source.getEvent!('e1');
    for (const key of ['writeSafetyVersion', 'walnutCreated', 'hasAttendees', 'organizerIsCurrentUser', 'organizerName', 'recurring']) {
      expect(lying, key).not.toHaveProperty(key);
    }
    expect(calendarEventNeedsApproval(lying)).toBe(true);

    // An invitation from someone else, and an event with no organizer at all.
    answers[APP_EXE]!.get = { ok: { ...OWN_BLOCK, walnutCreated: false, hasAttendees: true, organizerIsCurrentUser: false, organizerName: 'Pat' } };
    const invite = await source.getEvent!('e1');
    expect(invite).toMatchObject({ walnutCreated: false, hasAttendees: true, organizerIsCurrentUser: false, organizerName: 'Pat' });
    expect(calendarEventNeedsApproval(invite)).toBe(true);
    const noOrganizer: Record<string, unknown> = { ...OWN_BLOCK };
    delete noOrganizer.organizerIsCurrentUser;
    delete noOrganizer.organizerName;
    answers[APP_EXE]!.get = { ok: noOrganizer };
    const solo = await source.getEvent!('e1');
    expect(solo).not.toHaveProperty('organizerIsCurrentUser');
    expect(solo).not.toHaveProperty('organizerName');

    // A read from a binary older than the protocol carries none of them.
    const [old] = await source.listEvents('2026-10-01', '2026-10-31');
    expect(old).not.toHaveProperty('writeSafetyVersion');
    expect(old).not.toHaveProperty('walnutCreated');
    expect(calendarEventNeedsApproval(old!)).toBe(true);
  });
});

/**
 * A write never asks macOS for Calendars. 2026-10-10: Walnut.app predated the write-safety
 * protocol, so every write went to the current helper, which nobody had ever allowed; EventKit
 * put the request up from inside the write and the server killed it at 30s, so each agent-made
 * block failed as a "helper timed out" while reads (an older granted helper) looked fine.
 */
describe('writes and the Calendars grant', () => {
  /** Reads stay on the old granted helper; writes have only the never-asked current helper. */
  function migrationMoment(helperState: string | null) {
    olderGenerations = [OLD];
    answers[APP_EXE] = { status: { ok: { state: 'not-determined' } }, capabilities: UNKNOWN_SUB };
    answers[OLD] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, list: { ok: [] } };
    answers[HELPER] = {
      ...(helperState ? { status: { ok: { state: helperState } } } : {}),
      capabilities: SAFE, get: { ok: OWN_BLOCK }, update: { ok: OWN_BLOCK }, create: { ok: OWN_BLOCK }, delete: { ok: { ok: true } },
    };
  }

  it('fails every write at once, before anything that could prompt, when the write route was never asked', async () => {
    helperBuilt = false; // the current helper does not exist yet, so the OLD one serves reads
    migrationMoment('not-determined');
    const ek = await load();
    const source = ek.createEventKitSource();
    await source.listEvents('2026-10-01', '2026-10-31');
    expect(ek.calendarHelperFallback()?.path).toBe(OLD);

    for (const attempt of [
      () => source.createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }),
      () => source.updateEvent('e1', SPAN),
      () => source.updateEvent('e1', SPAN, { humanConfirm: true }),
      () => source.deleteEvent('e1'),
      () => source.getEvent!('e1'),
    ]) {
      const err = await attempt().then(() => null, (e: Error) => e);
      expect(err).toMatchObject({ code: 'permission-denied' });
      expect(err!.message).toContain('Nothing was changed');
      expect(err!.message).toContain('Request access in Settings → macOS Access → Calendar');
      // Short enough that the quick-create form shows the fix whole.
      expect(err!.message.length).toBeLessThan(200);
    }
    // No write, no `get`, and no `calendars` to the never-asked helper: only probes.
    expect(writesSent()).toEqual([]);
    const helperSubs = new Set(calls.filter((c) => c[0] === HELPER).map((c) => c[1]));
    expect([...helperSubs].sort()).toEqual(['capabilities', 'status']);
    // The older generation that holds the grant is never written through either.
    expect(calls.filter((c) => c[0] === OLD).map((c) => c[1])).not.toContain('create');
  });

  it('names the fix: Request access when never asked, System Settings when refused, and says nothing changed', async () => {
    migrationMoment('not-determined');
    let ek = await load();
    const asked = await ek.createEventKitSource().createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }).catch((e: Error) => e);
    expect(asked.message).toContain('Request access');
    expect(asked.message).toContain('Nothing was changed');
    expect(asked.message).toContain('walnut-calendar helper');

    migrationMoment('denied');
    ek = await load();
    const refused = await ek.createEventKitSource().createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }).catch((e: Error) => e);
    expect(refused).toMatchObject({ code: 'permission-denied' });
    expect(refused.message).toContain('System Settings → Privacy & Security → Calendars');

    // A `status` that cannot be read is not a grant: no write, and not called a denial either.
    migrationMoment(null);
    ek = await load();
    const unknown = await ek.createEventKitSource().createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }).catch((e: Error) => e);
    expect(unknown).toMatchObject({ code: 'fetch-error' });
    expect(writesSent()).toEqual([]);
  });

  it('Request access also asks the write route when an older Walnut.app hands writes to the helper', async () => {
    migrationMoment('not-determined');
    const ek = await load();
    // The Doctor reports the gap, so the Request access button is there to press.
    expect(await ek.calendarAccessReport()).toEqual({ state: 'not-determined', read: 'not-determined', writeGap: 'not-determined' });

    // The user allows Walnut, then allows the helper in the second dialog.
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, list: { ok: [] }, capabilities: UNKNOWN_SUB };
    answers[HELPER]!.calendars = { ok: CALS };
    calls = [];
    expect(await ek.requestCalendarAccess()).toBe('granted');
    const prompting = calls.filter((c) => (c[1] === '--calendar-bridge' ? c[2] : c[1]) === 'calendars');
    expect(prompting).toEqual([[APP_EXE, '--calendar-bridge', 'calendars'], [HELPER, 'calendars']]);

    // The helper now answers granted, and the next write goes straight to it.
    answers[HELPER]!.status = { ok: { state: 'granted' } };
    calls = [];
    await ek.createEventKitSource().createEvent({ calendarId: 'c1', title: 'Block', ...SPAN });
    expect(writesSent()).toEqual([[HELPER, 'create']]);
    expect(await ek.calendarAccessReport()).toEqual({ state: 'granted', read: 'granted', writeGap: null });
    expect(await ek.calendarAuthStatus()).toBe('granted');
  });

  it('Request access asks the helper only when it needs asking, and reports a refusal of it', async () => {
    migrationMoment('granted');
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: UNKNOWN_SUB };
    let ek = await load();
    calls = [];
    expect(await ek.requestCalendarAccess()).toBe('granted');
    expect(calls).not.toContainEqual([HELPER, 'calendars']);

    migrationMoment('denied');
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: UNKNOWN_SUB };
    ek = await load();
    expect(await ek.requestCalendarAccess()).toBe('denied');
    expect(calls).not.toContainEqual([HELPER, 'calendars']);
  });

  it('the Doctor poll reports a missing write helper as not asked, without compiling one', async () => {
    helperBuilt = false;
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: UNKNOWN_SUB };
    const ek = await load();

    expect(await ek.calendarAccessReport()).toEqual({ state: 'not-determined', read: 'granted', writeGap: 'not-determined' });
    expect(await ek.calendarAuthStatus()).toBe('not-determined');
    expect(ensureHelperCalls).toBe(0);
  });

  it('a write helper that cannot be built is no grant gap, so Request access is not offered forever', async () => {
    helperBuilt = false;
    buildFailed = true;
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: UNKNOWN_SUB };
    const ek = await load();

    expect(await ek.calendarAccessReport()).toEqual({ state: 'granted', read: 'granted', writeGap: null });
    // The write itself still refuses, honestly: nothing proves the protocol.
    await expect(ek.createEventKitSource().createEvent({ calendarId: 'c1', title: 'Block', ...SPAN }))
      .rejects.toMatchObject({ code: 'human-approval-required' });
  });

  it('an app that writes for itself adds no write-route gap', async () => {
    answers[APP_EXE] = { status: { ok: { state: 'granted' } }, calendars: { ok: CALS }, capabilities: SAFE };
    const ek = await load();

    expect(await ek.calendarAccessReport()).toEqual({ state: 'granted', read: 'granted', writeGap: null });
    expect(calls.some((c) => c[0] === HELPER)).toBe(false);
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

  it('answers capabilities before asking for Calendars, and speaks the same write-safety protocol', () => {
    // Every write probes `capabilities` first; a binary that asked for access before answering would prompt from a probe.
    const src = read('src/data/walnut-calendar.swift');
    const body = src.slice(src.indexOf('func walnutCalendarMain'));
    const caps = body.indexOf('args[1] == "capabilities"');
    expect(caps).toBeGreaterThan(0);
    expect(caps).toBeLessThan(body.indexOf('\nrequestAccess()'));
    expect(src).toMatch(/let writeSafetyVersion = 1\b/);
    expect(src).toContain('let humanConfirmFlag = "--human-confirm"');
    // The dialog must give up on its own before the server's 90s group kill.
    const budget = Number(/let humanConfirmBudget: TimeInterval = (\d+)/.exec(src)?.[1]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(90);
  });
});
