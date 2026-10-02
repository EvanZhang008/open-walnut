/**
 * Full Disk Access in Settings → macOS Access: ONE row, Walnut, when Walnut reads.
 *
 * Sessions run as Walnut (`Walnut --session-host`) and protected reads go through
 * `Walnut --reader-bridge`, so one grant covers both and the user adds one program.
 * What this file pins:
 *
 *  - one row when the reader IS the session app, two when a separate helper reads
 *    (two programs to macOS, so one row could not explain both);
 *  - the row is judged by every protected file in use together: on macOS 26 the
 *    Screen Time store refuses even a program that holds the grant, so a Screen Time
 *    refusal next to a working Focus read must not send the user to add Walnut again;
 *  - working through the older helper says so, and still asks for Walnut;
 *  - the copy contract every settings-only row keeps (opener step, paste carries the
 *    path, the optional session wording).
 *
 * The reader is faked; nothing runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PermissionStatus } from '../../src/core/permissions/types.js';

const APP = '/Applications/Walnut.app';
const HELPER = '/Users/someone/.open-walnut/cache/walnut-reader-v1';
const STORE = '/var/folders/x/0/com.apple.ScreenTimeAgent/Store/RMAdminStore-Cloud.sqlite';
const FOCUS = '/Users/someone/Library/DoNotDisturb/DB/Assertions.json';

let grantApp: string | null = APP;
let routeKind: 'app' | 'helper' = 'app';
let screenTimeOn = false;
let everWorked = false;
let standIn: string | null = null;
/** path → [exit code, answered by the stand-in] */
let answers: Record<string, [number, boolean]> = {};
let probed: string[] = [];

vi.mock('../../src/core/protected-reader.js', () => ({
  EXIT_NO_PERMISSION: 3,
  readerGrantApp: async () => grantApp,
  readerStandIn: () => standIn,
  routeEverSucceeded: async () => everWorked,
  runProtectedReader: async (_sub: string, file: string) => {
    probed.push(file);
    const [code, viaStandIn] = answers[file] ?? [2, false];
    const route = routeKind === 'app'
      ? { kind: 'app', cmd: [], grantTarget: APP }
      : { kind: 'helper', cmd: [], grantTarget: HELPER };
    return { code, stderr: '', bytes: 0, route, viaStandIn };
  },
}));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ time: { screentime: { enabled: screenTimeOn } } }),
}));

vi.mock('../../src/core/time-tracking/screentime-reader.js', () => ({
  screenTimeStorePath: async () => STORE,
}));

const { fullDiskAccessRows, probeFullDiskAccess } = await import('../../src/core/permissions/darwin-fda.js');
const { declareFullDiskAccessUse, resetFullDiskAccessUses } = await import('../../src/core/permissions/fda-uses.js');

const FOCUS_USE = { owner: 'walnut-rhythm', reason: "mirror your Mac's Focus into Walnut's quiet mode", probe: FOCUS };

beforeEach(() => {
  grantApp = APP;
  routeKind = 'app';
  screenTimeOn = false;
  everWorked = false;
  standIn = null;
  answers = {};
  probed = [];
  resetFullDiskAccessUses();
});

async function rows(sessionApp: string | null = APP): Promise<PermissionStatus[]> {
  return fullDiskAccessRows(await probeFullDiskAccess(), sessionApp);
}

function stepText(step: PermissionStatus['steps'][number]): string {
  return typeof step === 'string' ? step : step.text;
}

/** The contract every settings-only row keeps (also pinned over HTTP in permissions-api.test.ts). */
function expectActionableSteps(row: PermissionStatus): void {
  expect(row.steps.some((s) => typeof s !== 'string' && s.open)).toBe(true);
  for (const step of row.steps) {
    if (!/\bpaste\b/i.test(stepText(step))) continue;
    expect(typeof step === 'string' ? null : step.copy).toBe(row.grantTarget);
  }
}

describe('one row when Walnut reads and runs the sessions', () => {
  it('with nothing switched on, it is the optional session setup step, named Walnut', async () => {
    const [row, ...rest] = await rows();

    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id: 'full-disk-access', grantTarget: APP, state: 'unknown', unverifiable: true, optional: true,
    });
    // Same scan-line contract the old session row had: optional, names Claude Code.
    expect(row!.why).toMatch(/^Optional\./);
    expect(row!.why).toContain('Claude Code');
    expect(row!.context).toContain('Claude Code runs inside Walnut');
    expect(row!.steps.length).toBeLessThanOrEqual(4);
    expectActionableSteps(row!);
    expect(probed).toEqual([]); // nothing to read, so nothing is run
  });

  it('with Screen Time on and readable, it is granted and says what it is for', async () => {
    screenTimeOn = true;
    answers[STORE] = [0, false];

    const [row, ...rest] = await rows();

    expect(rest).toEqual([]);
    expect(row).toMatchObject({ id: 'full-disk-access', state: 'granted', grantTarget: APP });
    expect(row!.unverifiable).toBeUndefined();
    expect(row!.optional).toBeUndefined();
    expect(row!.why).toMatch(/^Lets Walnut read Apple Screen Time/);
    expect(row!.why).toContain('Claude Code');
    expect(row!.steps.map(stepText)).toContain(
      'For your iPhone: Settings → Screen Time → Share Across Devices, so its numbers reach this Mac.',
    );
    expectActionableSteps(row!);
  });

  it('a plugin use joins the same row, and leaves it when released', async () => {
    const release = declareFullDiskAccessUse(FOCUS_USE);
    answers[FOCUS] = [0, false];

    const [row] = await rows();
    expect(row!.why).toContain("mirror your Mac's Focus into Walnut's quiet mode");
    expect(row!.state).toBe('granted');
    expect(probed).toEqual([FOCUS]);

    release();
    release(); // idempotent
    const [after] = await rows();
    expect(after!.why).not.toContain('Focus');
    expect(after!.optional).toBe(true);
  });

  it('a Screen Time refusal next to a working Focus read is not a missing grant (macOS 26)', async () => {
    screenTimeOn = true;
    declareFullDiskAccessUse(FOCUS_USE);
    answers[STORE] = [3, false];
    answers[FOCUS] = [0, false];

    const [row] = await rows();

    expect(row!.state).toBe('granted');
    expect(row!.staleGrant).toBeUndefined();
    expect(probed).toEqual([STORE, FOCUS]);
  });

  it('refused everywhere and never worked: add Walnut', async () => {
    screenTimeOn = true;
    answers[STORE] = [3, false];

    const [row] = await rows();

    expect(row).toMatchObject({ state: 'denied', grantTarget: APP });
    expect(row!.staleGrant).toBeUndefined();
    expect(row!.steps.map(stepText)).toContain('Click + (authenticate if asked).');
  });

  it('refused everywhere after it worked here: remove and re-add Walnut', async () => {
    screenTimeOn = true;
    everWorked = true;
    answers[STORE] = [3, false];

    const [row] = await rows();

    expect(row).toMatchObject({ state: 'denied', staleGrant: true });
    const text = row!.steps.map(stepText);
    expect(text).toContain('Select the Walnut row and click the − button to remove it.');
    expect(text.join(' ')).not.toContain('walnut-reader');
    expectActionableSteps(row!);
  });

  it('working through the older helper says so, and still asks for Walnut', async () => {
    screenTimeOn = true;
    standIn = HELPER;
    answers[STORE] = [0, true];

    const [row] = await rows();

    expect(row).toMatchObject({ state: 'denied', grantTarget: APP });
    expect(row!.workingVia).toContain('walnut-reader');
    expect(row!.why).toContain('granting Walnut retires it');
  });

  it('no file there yet is not a grant problem', async () => {
    screenTimeOn = true;
    answers[STORE] = [2, false]; // Screen Time never wrote a store

    const [row] = await rows();

    expect(row!.state).toBe('granted');
  });

  it('the new copy keeps to plain punctuation (no em or en dashes)', async () => {
    const optional = (await rows())[0]!;
    screenTimeOn = true;
    answers[STORE] = [3, false];
    const missing = (await rows())[0]!;
    everWorked = true;
    const stale = (await rows())[0]!;
    standIn = HELPER;
    answers[STORE] = [0, true];
    const viaHelper = (await rows())[0]!;
    for (const row of [optional, missing, stale, viaHelper]) {
      const text = [row.why, row.context ?? '', ...row.steps.map(stepText)].join('\n');
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('two rows when a separate helper reads', () => {
  it('names the helper for reads and Walnut for sessions', async () => {
    grantApp = null;
    routeKind = 'helper';
    screenTimeOn = true;
    answers[STORE] = [3, false];

    const out = await rows(APP);

    expect(out.map((r) => [r.id, r.grantTarget])).toEqual([
      ['full-disk-access', HELPER],
      ['session-full-disk-access', APP],
    ]);
    for (const row of out) expectActionableSteps(row);
  });

  it('with sessions not under Walnut either, the session row is hidden', async () => {
    grantApp = null;
    routeKind = 'helper';

    const out = await rows(null);

    expect(out.map((r) => [r.id, r.state])).toEqual([
      ['full-disk-access', 'not-applicable'],
      ['session-full-disk-access', 'not-applicable'],
    ]);
  });

  it('a different Walnut.app for sessions (one mid-replacement) gets its own row', async () => {
    const other = '/Users/someone/Applications/Walnut.app';
    const out = await rows(other);
    expect(out.map((r) => [r.id, r.grantTarget])).toEqual([
      ['full-disk-access', APP],
      ['session-full-disk-access', other],
    ]);
  });
});
