/**
 * Screen Time snapshot store: idempotent per-(date, device) replace, the
 * never-delete-a-day rule, torn-line tolerance, and the bounded reads.
 *
 * Every date is a LITERAL key, never derived from the machine's clock or zone.
 * That is the point of the store's contract: the caller owns the local day, so a
 * test that computed one from `new Date()` would pass or fail by timezone.
 *
 * WALNUT_HOME is redirected to a fresh tmp dir via mocked constants, so the
 * store's per-call path resolution gives isolation for free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-screentime-store'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  MAX_DAY_FILE_BYTES,
  listScreenTimeDates,
  parseScreenTimeLine,
  readScreenTimeDay,
  recordScreenTimeDay,
  recordScreenTimeDays,
  recordScreenTimeSnapshot,
  resetScreenTimeStore,
} from '../../../src/core/time-tracking/screentime-store.js';
import type { ScreenTimeDay } from '../../../src/core/time-tracking/screentime-reader.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIR = (): string => path.join(WALNUT_HOME, 'time-tracking', 'screentime');
const FILE = (date: string): string => path.join(DIR(), `${date}.jsonl`);

/** Literal days and neutral invented device ids: nothing here names a real device. */
const DAY = '2026-08-30';
const NEXT = '2026-08-31';
const PHONE = 'device-phone-0001';
const TABLET = 'device-tablet-0002';
const MAC = 'device-mac-0003';
const T1 = '2026-08-30T20:00:00.000Z';
const T2 = '2026-08-31T20:00:00.000Z';

const HOUR = 60 * 60 * 1000;

function day(over: Partial<ScreenTimeDay> = {}): ScreenTimeDay {
  return {
    date: DAY,
    deviceId: PHONE,
    deviceName: 'Phone',
    platform: 2,
    totalMs: HOUR,
    pickups: 40,
    notifications: 12,
    apps: [
      { bundleId: 'com.example.messages', ms: 30 * 60_000, pickups: 20 },
      { bundleId: 'com.example.reader', ms: 10 * 60_000, category: 'Reading' },
      { bundleId: 'com.example.browser', domain: 'news.example.test', ms: 15 * 60_000 },
    ],
    blocks: [{ startTs: `${DAY}T15:00:00.000Z`, ms: 30 * 60_000 }],
    ...over,
  };
}

function tabletDay(over: Partial<ScreenTimeDay> = {}): ScreenTimeDay {
  return day({
    deviceId: TABLET,
    deviceName: 'Tablet',
    platform: 3,
    totalMs: 20 * 60_000,
    pickups: 5,
    notifications: 1,
    apps: [{ bundleId: 'com.example.reader', ms: 20 * 60_000 }],
    blocks: [],
    ...over,
  });
}

beforeEach(async () => {
  resetScreenTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetScreenTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('recordScreenTimeDay', () => {
  it('writes a header row plus one row per app and per website domain', async () => {
    const result = await recordScreenTimeDay(day(), { capturedAt: T1 });
    expect(result.dates).toEqual([DAY]);
    expect(result.written).toBe(4); // header + 2 apps + 1 site
    expect(result.kept).toBe(0);
    expect(result.replaced).toBe(0);

    const file = await readScreenTimeDay(DAY);
    const header = file.records.find((rec) => rec.kind === 'device')!;
    expect(header).toMatchObject({
      date: DAY, deviceId: PHONE, deviceName: 'Phone', platform: 2,
      ms: HOUR, pickups: 40, notifications: 12, capturedAt: T1,
    });
    expect(header.blocks).toEqual([{ startTs: `${DAY}T15:00:00.000Z`, ms: 30 * 60_000 }]);
    // An app row and a website row are different KINDS, so nothing downstream can
    // rank or sum them together by accident.
    expect(file.records.filter((rec) => rec.kind === 'app').map((rec) => rec.bundleId))
      .toEqual(['com.example.messages', 'com.example.reader']);
    expect(file.records.filter((rec) => rec.kind === 'site')).toEqual([
      { kind: 'site', date: DAY, deviceId: PHONE, domain: 'news.example.test', ms: 15 * 60_000 },
    ]);
  });

  it('is a no-op for an empty list of days', async () => {
    const result = await recordScreenTimeDays([]);
    expect(result.dates).toEqual([]);
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });
});

describe('idempotent replace', () => {
  it('re-snapshotting a day leaves every total alone instead of doubling it', async () => {
    const first = await recordScreenTimeDay(day(), { capturedAt: T1 });
    expect(first.dates).toEqual([DAY]);

    const second = await recordScreenTimeDay(day(), { capturedAt: T2 });
    // Identical numbers: nothing is written at all, so a settled day stops
    // churning the git-synced data directory on every scheduled snapshot.
    expect(second.dates).toEqual([]);
    expect(second.unchanged).toEqual([DAY]);
    expect(second.written).toBe(0);

    const third = await recordScreenTimeDay(day(), { capturedAt: T2 });
    expect(third.unchanged).toEqual([DAY]);

    const file = await readScreenTimeDay(DAY);
    expect(file.records).toHaveLength(4); // not 8, not 12
    const header = file.records.find((rec) => rec.kind === 'device')!;
    expect(header.ms).toBe(HOUR);
    // capturedAt means "when we first stored THIS content", so it stays at T1.
    expect(header.capturedAt).toBe(T1);
    expect(file.records.filter((rec) => rec.kind === 'app').map((rec) => rec.ms))
      .toEqual([30 * 60_000, 10 * 60_000]);
  });

  it('takes Apple\'s revised numbers rather than adding them to the stored ones', async () => {
    await recordScreenTimeDay(day(), { capturedAt: T1 });
    const revised = await recordScreenTimeDay(day({
      totalMs: 2 * HOUR,
      apps: [{ bundleId: 'com.example.messages', ms: 45 * 60_000 }],
    }), { capturedAt: T2 });

    expect(revised.dates).toEqual([DAY]);
    expect(revised.replaced).toBe(4); // the whole previous device-day went away
    expect(revised.written).toBe(2);

    const file = await readScreenTimeDay(DAY);
    const header = file.records.find((rec) => rec.kind === 'device')!;
    expect(header.ms).toBe(2 * HOUR);
    expect(header.capturedAt).toBe(T2); // content changed, so the stamp moved
    expect(file.records.filter((rec) => rec.kind === 'app').map((rec) => rec.ms)).toEqual([45 * 60_000]);
    // The dropped app and the dropped domain are GONE, not left behind as ghosts
    // that a naive per-row upsert would have kept forever.
    expect(file.records.filter((rec) => rec.kind === 'site')).toEqual([]);
    expect(file.records).toHaveLength(2);
  });

  it('replaces only the device it was handed and carries the other device across', async () => {
    await recordScreenTimeDays([day(), tabletDay()], { capturedAt: T1 });
    const before = await readScreenTimeDay(DAY);
    expect(before.records).toHaveLength(6); // 4 for the phone, 2 for the tablet

    const again = await recordScreenTimeDay(day({ totalMs: 3 * HOUR }), { capturedAt: T2 });
    expect(again.replaced).toBe(4); // the phone's rows
    expect(again.kept).toBe(2); // the tablet's rows, untouched

    const after = await readScreenTimeDay(DAY);
    const headers = after.records.filter((rec) => rec.kind === 'device');
    expect(headers.map((rec) => [rec.deviceId, rec.ms, rec.capturedAt])).toEqual([
      [PHONE, 3 * HOUR, T2],
      [TABLET, 20 * 60_000, T1],
    ]);
    expect(after.records).toHaveLength(6);
  });

  it('keeps two devices on one day separate rather than folding them together', async () => {
    await recordScreenTimeDays([day(), tabletDay()], { capturedAt: T1 });
    const file = await readScreenTimeDay(DAY);
    // Both devices have a `com.example.reader` row; they must stay two rows.
    const reader = file.records.filter((rec) => rec.bundleId === 'com.example.reader');
    expect(reader.map((rec) => [rec.deviceId, rec.ms])).toEqual([
      [PHONE, 10 * 60_000],
      [TABLET, 20 * 60_000],
    ]);
  });

  it('serializes two concurrent snapshots of one date instead of interleaving them', async () => {
    // No await between the two calls. Both read-modify-write the same file, so
    // without the per-date promise chain the second would read a version from
    // before the first renamed, and the first device would vanish.
    const a = recordScreenTimeDay(day(), { capturedAt: T1 });
    const b = recordScreenTimeDay(tabletDay(), { capturedAt: T1 });
    await Promise.all([a, b]);

    const file = await readScreenTimeDay(DAY);
    expect(file.records.filter((rec) => rec.kind === 'device').map((rec) => rec.deviceId))
      .toEqual([PHONE, TABLET]);
    expect(file.records).toHaveLength(6);
  });

  it('writes each date to its own file and never mixes two days', async () => {
    await recordScreenTimeDays([day(), day({ date: NEXT, totalMs: 30 * 60_000 })], { capturedAt: T1 });
    expect(await listScreenTimeDates()).toEqual([DAY, NEXT]);
    expect((await readScreenTimeDay(DAY)).records.every((rec) => rec.date === DAY)).toBe(true);
    expect((await readScreenTimeDay(NEXT)).records.every((rec) => rec.date === NEXT)).toBe(true);
  });
});

describe('the local-Mac flag', () => {
  it('flags exactly the devices the snapshot named, and the flag round-trips', async () => {
    await recordScreenTimeSnapshot({
      days: [day({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1 }), tabletDay()],
      devices: [],
      localDeviceIds: [MAC],
    }, { capturedAt: T1 });

    const file = await readScreenTimeDay(DAY);
    const headers = new Map(file.records.filter((rec) => rec.kind === 'device').map((rec) => [rec.deviceId, rec]));
    expect(headers.get(MAC)!.local).toBe(true);
    expect(headers.get(TABLET)!.local).toBeUndefined();

    // …and it survives a parse of the raw line, which is what a later read does.
    const raw = await fs.readFile(FILE(DAY), 'utf-8');
    const macLine = raw.split('\n').find((line) => line.includes(MAC) && line.includes('"kind":"device"'))!;
    expect(parseScreenTimeLine(macLine, DAY)!.local).toBe(true);
    // No stray flag on a device that is not this Mac.
    const tabletLine = raw.split('\n').find((line) => line.includes(TABLET) && line.includes('"kind":"device"'))!;
    expect(parseScreenTimeLine(tabletLine, DAY)!.local).toBeUndefined();
  });

  it('PRESERVES the stored flag when a writer does not say which device is local', async () => {
    // Behaviour under test, stated plainly: omitting localDeviceIds means "I was
    // not told", NOT "this device is not a Mac". A rewrite that dropped the flag
    // would retroactively relabel the day, which is the exact thing storing the
    // flag at capture time exists to prevent: the next scheduled snapshot would
    // un-hide a Mac row that the user had chosen not to see.
    await recordScreenTimeSnapshot({
      days: [day({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1 })],
      devices: [],
      localDeviceIds: [MAC],
    }, { capturedAt: T1 });

    const rewritten = await recordScreenTimeDays(
      [day({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1, totalMs: 4 * HOUR })],
      { capturedAt: T2 },
    );
    expect(rewritten.dates).toEqual([DAY]); // the row really was rewritten

    const header = (await readScreenTimeDay(DAY)).records.find((rec) => rec.kind === 'device')!;
    expect(header.ms).toBe(4 * HOUR);
    expect(header.local).toBe(true);
  });

  it('clears the flag when a writer DOES say, and says this device is not local', async () => {
    await recordScreenTimeSnapshot({
      days: [day({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1 })],
      devices: [],
      localDeviceIds: [MAC],
    }, { capturedAt: T1 });

    // An empty list is a real answer ("I checked; none of these is this Mac"),
    // so this is the one call that is allowed to relabel the device.
    await recordScreenTimeSnapshot({
      days: [day({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1, totalMs: 5 * HOUR })],
      devices: [],
      localDeviceIds: [],
    }, { capturedAt: T2 });

    const header = (await readScreenTimeDay(DAY)).records.find((rec) => rec.kind === 'device')!;
    expect(header.ms).toBe(5 * HOUR);
    expect(header.local).toBeUndefined();
  });
});

describe('a day file is never deleted', () => {
  it('has no code path that unlinks a day file', async () => {
    // A behavioural test can only prove the paths it exercises; this pins the
    // rule itself. Apple purges its own copy after two to four weeks, so a
    // delete here is unrecoverable data loss, not a tidy-up.
    const source = await fs.readFile(
      path.join(REPO_ROOT, 'src/core/time-tracking/screentime-store.ts'), 'utf-8',
    );
    expect(source).not.toMatch(/\bunlink\b/);
    expect(source).not.toMatch(/\brmdir\b/);
    expect(source).not.toMatch(/\brmSync\b/);
    // The only removal in the module is the temp file of a write that failed.
    const removals = [...source.matchAll(/\.rm\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(removals).toEqual(['tmp, { force: true }']);
  });

  it('keeps the file through repeated snapshots, a revision, and a read', async () => {
    await recordScreenTimeDay(day(), { capturedAt: T1 });
    const born = (await fs.stat(FILE(DAY))).birthtimeMs;
    await recordScreenTimeDay(day(), { capturedAt: T2 });
    await recordScreenTimeDay(day({ totalMs: 2 * HOUR }), { capturedAt: T2 });
    await readScreenTimeDay(DAY);
    await recordScreenTimeDay(tabletDay(), { capturedAt: T2 });

    await expect(fs.stat(FILE(DAY))).resolves.toBeTruthy();
    expect(await listScreenTimeDates()).toEqual([DAY]);
    // No temp file left behind either.
    expect((await fs.readdir(DIR())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(born).toBeGreaterThan(0);
  });

  it('refuses to rewrite a day file it could not read whole', async () => {
    // Rewriting from a partial parse is the one way a snapshot could destroy
    // history, so an over-cap file is skipped and left exactly as it was.
    await fs.mkdir(DIR(), { recursive: true });
    const junk = `${'#'.repeat(1024)}\n`.repeat(Math.ceil((MAX_DAY_FILE_BYTES + 4096) / 1025));
    await fs.writeFile(FILE(DAY), junk, 'utf-8');
    const sizeBefore = (await fs.stat(FILE(DAY))).size;
    expect(sizeBefore).toBeGreaterThan(MAX_DAY_FILE_BYTES);

    const result = await recordScreenTimeDay(day(), { capturedAt: T1 });
    expect(result.skipped).toEqual([DAY]);
    expect(result.dates).toEqual([]);
    expect((await fs.stat(FILE(DAY))).size).toBe(sizeBefore);
  });
});

describe('parse tolerance', () => {
  it('skips a torn tail line instead of throwing', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      FILE(DAY),
      [
        JSON.stringify({ kind: 'device', date: DAY, deviceId: PHONE, deviceName: 'Phone', platform: 2, ms: HOUR, pickups: 3, notifications: 1 }),
        JSON.stringify({ kind: 'app', date: DAY, deviceId: PHONE, bundleId: 'com.example.messages', ms: 60_000 }),
        '{"kind":"app","date":"' + DAY + '","deviceId":"' + PHONE + '","bun',
      ].join('\n'),
      'utf-8',
    );
    const file = await readScreenTimeDay(DAY);
    expect(file.skippedLines).toBe(1);
    expect(file.records).toHaveLength(2);
    expect(file.records.find((rec) => rec.kind === 'device')!.ms).toBe(HOUR);
  });

  it('drops the torn line when the day is rewritten, and keeps every good row', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      FILE(DAY),
      [
        JSON.stringify({ kind: 'device', date: DAY, deviceId: TABLET, deviceName: 'Tablet', platform: 3, ms: 600_000, pickups: 1, notifications: 0 }),
        '{"kind":"device","date":"' + DAY + '","devi',
      ].join('\n') + '\n',
      'utf-8',
    );
    const result = await recordScreenTimeDay(day(), { capturedAt: T1 });
    expect(result.kept).toBe(1); // the tablet's header survived
    const file = await readScreenTimeDay(DAY);
    expect(file.skippedLines).toBe(0);
    expect(file.records.filter((rec) => rec.kind === 'device').map((rec) => rec.deviceId))
      .toEqual([PHONE, TABLET]);
  });

  it('answers a day with no file as empty rather than an error', async () => {
    await expect(readScreenTimeDay('2020-01-01')).resolves.toEqual({
      date: '2020-01-01', records: [], skippedLines: 0,
    });
    expect(await listScreenTimeDates()).toEqual([]);
  });
});

describe('parseScreenTimeLine', () => {
  it('rejects a line whose kind is not one of the three', () => {
    expect(parseScreenTimeLine(JSON.stringify({ kind: 'block', date: DAY, deviceId: PHONE, ms: 1 }), DAY)).toBeNull();
    expect(parseScreenTimeLine('not json at all', DAY)).toBeNull();
    expect(parseScreenTimeLine('', DAY)).toBeNull();
    expect(parseScreenTimeLine('null', DAY)).toBeNull();
  });

  it('rejects a control character in an id, which would forge a second field', () => {
    const forged = JSON.stringify({ kind: 'app', date: DAY, deviceId: `${PHONE}\u0000x`, bundleId: 'com.example.a', ms: 60_000 });
    expect(parseScreenTimeLine(forged, DAY)).toBeNull();
    const bundle = JSON.stringify({ kind: 'app', date: DAY, deviceId: PHONE, bundleId: 'com.example\u001fa', ms: 60_000 });
    expect(parseScreenTimeLine(bundle, DAY)).toBeNull();
  });

  it('clamps an absurd duration instead of trusting or dropping the row', () => {
    const rec = parseScreenTimeLine(
      JSON.stringify({ kind: 'app', date: DAY, deviceId: PHONE, bundleId: 'com.example.a', ms: 99 * 24 * HOUR }),
      DAY,
    )!;
    expect(rec.ms).toBe(24 * HOUR);
    const negative = parseScreenTimeLine(
      JSON.stringify({ kind: 'app', date: DAY, deviceId: PHONE, bundleId: 'com.example.a', ms: -5 }),
      DAY,
    );
    expect(negative).toBeNull();
  });

  it('caps a field length and falls back to the file date for a bad one', () => {
    const long = parseScreenTimeLine(
      JSON.stringify({ kind: 'app', date: DAY, deviceId: PHONE, bundleId: 'c'.repeat(400), ms: 60_000 }),
      DAY,
    );
    expect(long).toBeNull();
    const badDate = parseScreenTimeLine(
      JSON.stringify({ kind: 'app', date: 'yesterday', deviceId: PHONE, bundleId: 'com.example.a', ms: 60_000 }),
      DAY,
    )!;
    expect(badDate.date).toBe(DAY);
  });

  it('lower-cases a domain so one site cannot become two rows', () => {
    const rec = parseScreenTimeLine(
      JSON.stringify({ kind: 'site', date: DAY, deviceId: PHONE, domain: 'News.Example.Test', ms: 60_000 }),
      DAY,
    )!;
    expect(rec.domain).toBe('news.example.test');
  });

  it('keeps a device header whose total is zero', () => {
    // "The phone was not touched" is an answer; dropping it would leave the day
    // looking as though it had never been snapshotted.
    const rec = parseScreenTimeLine(
      JSON.stringify({ kind: 'device', date: DAY, deviceId: PHONE, deviceName: 'Phone', platform: 2, ms: 0, pickups: 0, notifications: 0 }),
      DAY,
    )!;
    expect(rec).toMatchObject({ kind: 'device', ms: 0, deviceId: PHONE });
  });
});

describe('sanitizing on the way in', () => {
  it('merges a duplicated app row rather than storing the app twice', async () => {
    await recordScreenTimeDay(day({
      apps: [
        { bundleId: 'com.example.messages', ms: 60_000, pickups: 2 },
        { bundleId: 'com.example.messages', ms: 30_000, pickups: 1 },
      ],
    }), { capturedAt: T1 });
    const apps = (await readScreenTimeDay(DAY)).records.filter((rec) => rec.kind === 'app');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ bundleId: 'com.example.messages', ms: 90_000, pickups: 3 });
  });

  it('drops a row with no usable identity and clamps the day total', async () => {
    await recordScreenTimeDay(day({
      totalMs: 99 * HOUR,
      apps: [
        { bundleId: '', ms: 60_000 },
        { bundleId: 'com.example.a', ms: 0 },
        { bundleId: 'com.example.b', ms: 60_000 },
      ],
    }), { capturedAt: T1 });
    const file = await readScreenTimeDay(DAY);
    expect(file.records.find((rec) => rec.kind === 'device')!.ms).toBe(24 * HOUR);
    expect(file.records.filter((rec) => rec.kind === 'app').map((rec) => rec.bundleId)).toEqual(['com.example.b']);
  });

  it('refuses a date that is not a local day key, and writes no file for it', async () => {
    const result = await recordScreenTimeDay(day({ date: '../../escape' }), { capturedAt: T1 });
    expect(result.dates).toEqual([]);
    expect(result.skipped).toEqual(['']);
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });

  it('refuses a device id it cannot store, without touching the rest of the day', async () => {
    await recordScreenTimeDay(day(), { capturedAt: T1 });
    const result = await recordScreenTimeDay(day({ deviceId: 'bad\u0000id' }), { capturedAt: T2 });
    expect(result.skipped).toEqual([DAY]);
    expect((await readScreenTimeDay(DAY)).records).toHaveLength(4);
  });
});

describe('timezone robustness', () => {
  it('files a day under the date it was GIVEN, never one derived from a timestamp', async () => {
    // The only block starts at midnight UTC, which is the previous local day in
    // any negative-offset zone and the same day in a positive one. Deriving the
    // file name or the row date from it would make this test pass or fail by the
    // runner's timezone; the caller owns the local day, and the store obeys it.
    await recordScreenTimeDay(day({
      blocks: [{ startTs: `${DAY}T00:00:00.000Z`, ms: 60_000 }],
    }), { capturedAt: T1 });

    expect(await listScreenTimeDates()).toEqual([DAY]);
    const file = await readScreenTimeDay(DAY);
    expect(new Set(file.records.map((rec) => rec.date))).toEqual(new Set([DAY]));
    expect(file.records.find((rec) => rec.kind === 'device')!.blocks)
      .toEqual([{ startTs: `${DAY}T00:00:00.000Z`, ms: 60_000 }]);
  });

  it('never reinterprets a stored timestamp on the way back out', async () => {
    await recordScreenTimeDay(day({
      blocks: [
        { startTs: `${DAY}T23:00:00.000Z`, ms: 60_000 },
        { startTs: `${DAY}T07:00:00.000Z`, ms: 120_000 },
      ],
    }), { capturedAt: T1 });
    const header = (await readScreenTimeDay(DAY)).records.find((rec) => rec.kind === 'device')!;
    // Chronological by the STRING, which for a Z-suffixed instant is also
    // chronological by instant, with no local-zone arithmetic anywhere.
    expect(header.blocks!.map((b) => b.startTs)).toEqual([
      `${DAY}T07:00:00.000Z`, `${DAY}T23:00:00.000Z`,
    ]);
  });
});

describe('listScreenTimeDates', () => {
  it('lists day files ascending and ignores anything that is not one', async () => {
    await recordScreenTimeDays([
      day({ date: '2026-08-28' }), day({ date: NEXT }), day({ date: DAY }),
    ], { capturedAt: T1 });
    await fs.writeFile(path.join(DIR(), `${DAY}.jsonl.snapshot-999.tmp`), 'x', 'utf-8');
    await fs.writeFile(path.join(DIR(), 'notes.md'), 'x', 'utf-8');

    expect(await listScreenTimeDates()).toEqual(['2026-08-28', DAY, NEXT]);
  });

  it('answers an empty store with an empty list', async () => {
    expect(await listScreenTimeDates()).toEqual([]);
  });
});

describe('resetScreenTimeStore', () => {
  it('re-resolves WALNUT_HOME so a later write lands in the current home', async () => {
    await recordScreenTimeDay(day(), { capturedAt: T1 });
    resetScreenTimeStore();
    // Same mocked home, but the store has no memory of it: the read has to find
    // the file on disk rather than in a cache.
    const file = await readScreenTimeDay(DAY);
    expect(file.records).toHaveLength(4);
  });
});
