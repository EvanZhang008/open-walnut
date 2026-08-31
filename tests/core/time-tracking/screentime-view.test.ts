/**
 * Screen Time read-time fold: per-device rows, the local-Mac split, apps and
 * websites as two lists that are never summed, and the drop accounting on every
 * cap. Pure, so there is no fs, no clock, and no mocked constants here.
 *
 * Every date and timestamp is a literal with an explicit zone, so nothing in this
 * file can pass or fail by the runner's timezone.
 */

import { describe, it, expect } from 'vitest';
import {
  SCREEN_TIME_BLOCK_GRANULARITY,
  SCREEN_TIME_MAX_APPS,
  SCREEN_TIME_MAX_SITES,
  foldScreenTimeDay,
} from '../../../src/core/time-tracking/screentime-view.js';
import type { ScreenTimeRecord } from '../../../src/core/time-tracking/screentime-store.js';

const DAY = '2026-08-30';
const PHONE = 'device-phone-0001';
const TABLET = 'device-tablet-0002';
const MAC = 'device-mac-0003';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60_000;

function header(over: Partial<ScreenTimeRecord> = {}): ScreenTimeRecord {
  return {
    kind: 'device',
    date: DAY,
    deviceId: PHONE,
    deviceName: 'Phone',
    platform: 2,
    ms: 2 * HOUR,
    pickups: 40,
    notifications: 12,
    ...over,
  };
}

function app(bundleId: string, ms: number, over: Partial<ScreenTimeRecord> = {}): ScreenTimeRecord {
  return { kind: 'app', date: DAY, deviceId: PHONE, bundleId, ms, ...over };
}

function site(domain: string, ms: number, over: Partial<ScreenTimeRecord> = {}): ScreenTimeRecord {
  return { kind: 'site', date: DAY, deviceId: PHONE, domain, ms, ...over };
}

describe('foldScreenTimeDay', () => {
  it('folds one device into Apple\'s totals plus ranked apps and ranked sites', () => {
    const fold = foldScreenTimeDay([
      header(),
      app('com.example.reader', 10 * MINUTE, { category: 'Reading' }),
      app('com.example.messages', 30 * MINUTE, { pickups: 20, notifications: 8 }),
      site('news.example.test', 15 * MINUTE),
      site('docs.example.test', 5 * MINUTE, { category: 'Reference' }),
    ], { date: DAY });

    expect(fold.date).toBe(DAY);
    expect(fold.devices).toHaveLength(1);
    const device = fold.devices[0]!;
    expect(device).toMatchObject({
      deviceId: PHONE, deviceName: 'Phone', platform: 2,
      totalMs: 2 * HOUR, pickups: 40, notifications: 12,
      appMs: 40 * MINUTE, siteMs: 20 * MINUTE,
    });
    expect(device.apps).toEqual([
      { bundleId: 'com.example.messages', ms: 30 * MINUTE, pickups: 20, notifications: 8 },
      { bundleId: 'com.example.reader', ms: 10 * MINUTE, category: 'Reading' },
    ]);
    expect(device.sites).toEqual([
      { domain: 'news.example.test', ms: 15 * MINUTE },
      { domain: 'docs.example.test', ms: 5 * MINUTE, category: 'Reference' },
    ]);
    // The day total is APPLE's number, not the sum of the rows: adding an app
    // list to a website list double counts every minute spent browsing.
    expect(fold.totalMs).toBe(2 * HOUR);
    expect(device.appMs + device.siteMs).not.toBe(device.totalMs);
    expect(fold.pickups).toBe(40);
    expect(fold.notifications).toBe(12);
  });

  it('keeps an app and a website with the same name in their own lists', () => {
    // Apple can report a bundle id and a domain that read alike. Merged into one
    // list they would look like one row with the wrong total.
    const fold = foldScreenTimeDay([
      header(),
      app('news.example.test', 7 * MINUTE),
      site('news.example.test', 3 * MINUTE),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.apps).toEqual([{ bundleId: 'news.example.test', ms: 7 * MINUTE }]);
    expect(device.sites).toEqual([{ domain: 'news.example.test', ms: 3 * MINUTE }]);
    expect(device.appMs).toBe(7 * MINUTE);
    expect(device.siteMs).toBe(3 * MINUTE);
  });

  it('sums duplicate rows of one identity instead of showing the app twice', () => {
    const fold = foldScreenTimeDay([
      header(),
      app('com.example.messages', 5 * MINUTE, { pickups: 2 }),
      app('com.example.messages', 3 * MINUTE, { pickups: 1 }),
      site('news.example.test', 4 * MINUTE),
      site('news.example.test', 1 * MINUTE),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.apps).toEqual([{ bundleId: 'com.example.messages', ms: 8 * MINUTE, pickups: 3 }]);
    expect(device.sites).toEqual([{ domain: 'news.example.test', ms: 5 * MINUTE }]);
  });

  it('drops rows with no positive time', () => {
    const fold = foldScreenTimeDay([
      header(),
      app('com.example.a', 0),
      app('com.example.b', -5 * MINUTE),
      app('com.example.c', MINUTE),
      site('a.example.test', 0),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.apps).toEqual([{ bundleId: 'com.example.c', ms: MINUTE }]);
    expect(device.sites).toEqual([]);
  });

  it('takes the date from the records when the caller does not name one', () => {
    expect(foldScreenTimeDay([header()]).date).toBe(DAY);
    expect(foldScreenTimeDay([]).date).toBe('');
    expect(foldScreenTimeDay([]).devices).toEqual([]);
    expect(foldScreenTimeDay([]).totalMs).toBe(0);
  });
});

describe('the local Mac', () => {
  const records = (): ScreenTimeRecord[] => [
    header(),
    app('com.example.messages', 30 * MINUTE),
    header({ deviceId: MAC, deviceName: 'Desk Mac', platform: 1, ms: 6 * HOUR, pickups: 3, notifications: 1 }),
    { kind: 'app', date: DAY, deviceId: MAC, bundleId: 'com.example.editor', ms: 5 * HOUR },
  ];

  it('is excluded by default when the caller names it, and its data still comes back', () => {
    const fold = foldScreenTimeDay(records(), { date: DAY, localDeviceIds: [MAC] });

    expect(fold.devices.map((d) => d.deviceId)).toEqual([PHONE]);
    expect(fold.totalMs).toBe(2 * HOUR); // the Mac's 6h is NOT in the day total
    expect(fold.pickups).toBe(40);

    // Kept in full, so a UI that wants Apple's version of this Mac can render it.
    expect(fold.localDevices).toHaveLength(1);
    const mac = fold.localDevices[0]!;
    expect(mac).toMatchObject({ deviceId: MAC, deviceName: 'Desk Mac', totalMs: 6 * HOUR, local: true });
    expect(mac.apps).toEqual([{ bundleId: 'com.example.editor', ms: 5 * HOUR }]);
    expect(fold.localTotalMs).toBe(6 * HOUR);
  });

  it('is excluded from the STORED flag too, with no help from the caller', () => {
    // The reader stamps `local` at capture time, which is the only answer that
    // still holds for a day captured on a machine that has since been replaced.
    const fold = foldScreenTimeDay(
      records().map((rec) => (rec.kind === 'device' && rec.deviceId === MAC ? { ...rec, local: true as const } : rec)),
      { date: DAY },
    );
    expect(fold.devices.map((d) => d.deviceId)).toEqual([PHONE]);
    expect(fold.localDevices.map((d) => d.deviceId)).toEqual([MAC]);
    expect(fold.localTotalMs).toBe(6 * HOUR);
  });

  it('unions the two signals rather than letting either clear the other', () => {
    const stamped = records().map((rec) => (
      rec.kind === 'device' && rec.deviceId === MAC ? { ...rec, local: true as const } : rec
    ));
    // The caller names a DIFFERENT device; the stored Mac stays local anyway.
    const fold = foldScreenTimeDay([
      ...stamped,
      header({ deviceId: TABLET, deviceName: 'Tablet', platform: 3, ms: HOUR, pickups: 2, notifications: 0 }),
    ], { date: DAY, localDeviceIds: [TABLET] });
    expect(fold.localDevices.map((d) => d.deviceId).sort()).toEqual([MAC, TABLET]);
    expect(fold.devices.map((d) => d.deviceId)).toEqual([PHONE]);
    expect(fold.totalMs).toBe(2 * HOUR);
  });

  it('shows every device when none is local', () => {
    const fold = foldScreenTimeDay(records(), { date: DAY });
    expect(fold.devices.map((d) => d.deviceId)).toEqual([MAC, PHONE]); // 6h before 2h
    expect(fold.localDevices).toEqual([]);
    expect(fold.totalMs).toBe(8 * HOUR);
    expect(fold.localTotalMs).toBe(0);
  });
});

describe('blocks', () => {
  const blocks = (n: number, msOf: (i: number) => number) => (
    Array.from({ length: n }, (_, i) => ({
      startTs: `${DAY}T${String(i % 24).padStart(2, '0')}:${String(Math.floor(i / 24) * 10).padStart(2, '0')}:00.000Z`,
      ms: msOf(i),
    }))
  );

  it('passes blocks through in chronological order with the granularity flag', () => {
    const fold = foldScreenTimeDay([
      header({
        blocks: [
          { startTs: `${DAY}T18:00:00.000Z`, ms: 20 * MINUTE },
          { startTs: `${DAY}T07:00:00.000Z`, ms: 5 * MINUTE },
        ],
      }),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.blocks).toEqual([
      { startTs: `${DAY}T07:00:00.000Z`, ms: 5 * MINUTE },
      { startTs: `${DAY}T18:00:00.000Z`, ms: 20 * MINUTE },
    ]);
    // Hour resolution, unlike the 5-second sampling of the Mac's own lane. A
    // caller that draws these next to that one has to be able to say so.
    expect(device.blockGranularity).toBe('hour');
    expect(SCREEN_TIME_BLOCK_GRANULARITY).toBe('hour');
  });

  it('has no blocks and no crash when the header carries none', () => {
    const fold = foldScreenTimeDay([header(), app('com.example.a', MINUTE)], { date: DAY });
    expect(fold.devices[0]!.blocks).toEqual([]);
    expect(fold.devices[0]!.dropped.blocks).toBe(0);
  });

  it('keeps the LONGEST blocks over the cap and reports the rest', () => {
    // Dropping the tail of the array instead would cut the END of the day off.
    const fold = foldScreenTimeDay([header({ blocks: blocks(10, (i) => (i + 1) * MINUTE) })], {
      date: DAY, maxBlocks: 8,
    });
    const device = fold.devices[0]!;
    expect(device.blocks).toHaveLength(8);
    expect(device.blocks.map((b) => b.ms).sort((a, b) => a - b)).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * MINUTE),
    );
    // Still chronological after the cap, so a chart draws them left to right.
    const stamps = device.blocks.map((b) => b.startTs);
    expect([...stamps].sort()).toEqual(stamps);
    expect(device.dropped.blocks).toBe(2);
    expect(device.dropped.blockMs).toBe(1 * MINUTE + 2 * MINUTE);
  });
});

describe('drop accounting', () => {
  it('caps the app list and reports what fell off as a count AND ms', () => {
    // A rank list that silently ends at N tells the user their day was shorter
    // than it was, so the tail has to be reported rather than dropped.
    const records: ScreenTimeRecord[] = [header()];
    for (let i = 0; i < SCREEN_TIME_MAX_APPS + 3; i++) {
      records.push(app(`com.example.app${String(i).padStart(3, '0')}`, (i + 1) * MINUTE));
    }
    const fold = foldScreenTimeDay(records, { date: DAY });
    const device = fold.devices[0]!;
    expect(device.apps).toHaveLength(SCREEN_TIME_MAX_APPS);
    expect(device.dropped.apps).toBe(3);
    expect(device.dropped.appMs).toBe(1 * MINUTE + 2 * MINUTE + 3 * MINUTE); // the three smallest
    // appMs still counts every row, capped or not.
    expect(device.appMs).toBe(records.slice(1).reduce((sum, rec) => sum + rec.ms, 0));
    expect(device.dropped.sites).toBe(0);
    expect(device.dropped.siteMs).toBe(0);
  });

  it('caps the site list separately from the app list', () => {
    const records: ScreenTimeRecord[] = [header(), app('com.example.only', 9 * HOUR)];
    for (let i = 0; i < SCREEN_TIME_MAX_SITES + 2; i++) {
      records.push(site(`s${String(i).padStart(3, '0')}.example.test`, (i + 1) * MINUTE));
    }
    const fold = foldScreenTimeDay(records, { date: DAY });
    const device = fold.devices[0]!;
    expect(device.sites).toHaveLength(SCREEN_TIME_MAX_SITES);
    expect(device.dropped.sites).toBe(2);
    expect(device.dropped.siteMs).toBe(1 * MINUTE + 2 * MINUTE);
    // The big app row is untouched by the SITE cap: two lists, two caps.
    expect(device.apps).toEqual([{ bundleId: 'com.example.only', ms: 9 * HOUR }]);
    expect(device.dropped.apps).toBe(0);
  });

  it('honours a caller-supplied cap, including zero', () => {
    const fold = foldScreenTimeDay([
      header(), app('com.example.a', 2 * MINUTE), app('com.example.b', MINUTE),
    ], { date: DAY, maxApps: 1 });
    expect(fold.devices[0]!.apps).toEqual([{ bundleId: 'com.example.a', ms: 2 * MINUTE }]);
    expect(fold.devices[0]!.dropped).toMatchObject({ apps: 1, appMs: MINUTE });

    const none = foldScreenTimeDay([header(), app('com.example.a', 2 * MINUTE)], { date: DAY, maxApps: 0 });
    expect(none.devices[0]!.apps).toEqual([]);
    expect(none.devices[0]!.dropped).toMatchObject({ apps: 1, appMs: 2 * MINUTE });
  });
});

describe('deterministic ordering', () => {
  it('breaks a tie on ms by id, so a redraw can never reshuffle two rows', () => {
    const fold = foldScreenTimeDay([
      header(),
      app('com.example.zebra', 5 * MINUTE),
      app('com.example.alpha', 5 * MINUTE),
      app('com.example.mango', 5 * MINUTE),
      site('z.example.test', MINUTE),
      site('a.example.test', MINUTE),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.apps.map((row) => row.bundleId))
      .toEqual(['com.example.alpha', 'com.example.mango', 'com.example.zebra']);
    expect(device.sites.map((row) => row.domain)).toEqual(['a.example.test', 'z.example.test']);
  });

  it('orders devices by total, then by id on a tie', () => {
    const fold = foldScreenTimeDay([
      header({ deviceId: TABLET, deviceName: 'Tablet', ms: HOUR }),
      header({ deviceId: MAC, deviceName: 'Desk Mac', ms: 3 * HOUR }),
      header({ deviceId: PHONE, ms: HOUR }),
    ], { date: DAY });
    expect(fold.devices.map((d) => d.deviceId)).toEqual([MAC, PHONE, TABLET]);
  });

  it('gives the same answer whatever order the records arrive in', () => {
    const records = [
      header(),
      app('com.example.messages', 30 * MINUTE),
      site('news.example.test', 15 * MINUTE),
      header({ deviceId: TABLET, deviceName: 'Tablet', ms: HOUR }),
    ];
    const forward = foldScreenTimeDay(records, { date: DAY });
    const backward = foldScreenTimeDay([...records].reverse(), { date: DAY });
    expect(backward).toEqual(forward);
  });
});

describe('a file that lost its header', () => {
  it('reports headerMissing and refuses to invent a day total from the rows', () => {
    const fold = foldScreenTimeDay([
      app('com.example.messages', 30 * MINUTE),
      site('news.example.test', 15 * MINUTE),
    ], { date: DAY });
    const device = fold.devices[0]!;
    expect(device.headerMissing).toBe(true);
    expect(device.totalMs).toBe(0);
    expect(fold.totalMs).toBe(0);
    // The rows themselves are still there, and still summed honestly.
    expect(device.appMs).toBe(30 * MINUTE);
    expect(device.siteMs).toBe(15 * MINUTE);
    expect(device.deviceName).toBe(PHONE); // no name to show, so the id stands in
    expect(device.blockGranularity).toBe('hour');
  });

  it('takes the FIRST header when a corrupt file has two for one device', () => {
    // Summing two headers would double the device's whole day.
    const fold = foldScreenTimeDay([
      header({ ms: 2 * HOUR, pickups: 40 }),
      header({ ms: 9 * HOUR, pickups: 900 }),
    ], { date: DAY });
    expect(fold.devices[0]!.totalMs).toBe(2 * HOUR);
    expect(fold.devices[0]!.pickups).toBe(40);
    expect(fold.devices).toHaveLength(1);
    expect(fold.devices[0]!.headerMissing).toBeUndefined();
  });

  it('ignores a record with no device id at all', () => {
    const fold = foldScreenTimeDay([
      header(),
      { kind: 'app', date: DAY, deviceId: '', bundleId: 'com.example.orphan', ms: HOUR },
    ], { date: DAY });
    expect(fold.devices).toHaveLength(1);
    expect(fold.devices[0]!.apps).toEqual([]);
  });
});
