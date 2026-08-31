/**
 * GET /api/time/screentime + its two POSTs — the real router on a throwaway express
 * app, answering from a real (temp) permanent store and a real config file.
 *
 * The READER is stubbed. Reading Apple's real store needs macOS, a Full Disk Access
 * grant a test can never obtain, and a swiftc compile; what matters at this layer is
 * everything around it, and each case below is a rule that would otherwise only be
 * caught by a human noticing a wrong number:
 *
 *   - the request path never touches Apple's store (the route must answer from OUR
 *     copy, because a three-copy + five-query read is a background job's work)
 *   - a stale grant reaches the client AS 'stale_grant', because its fix is the one
 *     nobody guesses (remove the row and add it back, not toggle it)
 *   - this Mac's rows are stored but hidden until asked for
 *   - turning the feature OFF never deletes history
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-screentime-route'));

// vi.hoisted: the mock factory is lifted above every import, so a stub it closes
// over has to be hoisted with it.
const reader = vi.hoisted(() => ({
  probe: vi.fn(),
  read: vi.fn(),
  helperPath: '/tmp/walnut-cache/walnut-reader-v1',
}));

vi.mock('../../../src/core/time-tracking/screentime-reader.js', async (importOriginal) => {
  // Keep the real types and any pure helper; only the two functions that would touch
  // Apple's protected store are replaced.
  const actual = await importOriginal<typeof import('../../../src/core/time-tracking/screentime-reader.js')>();
  return {
    ...actual,
    probeScreenTimeAccess: reader.probe,
    readScreenTime: reader.read,
    screenTimeHelperPath: async () => reader.helperPath,
  };
});

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js';
import { resetScreenTimeAccessCache, timeRouter } from '../../../src/web/routes/time.js';
import { resetScreenTimeStore } from '../../../src/core/time-tracking/screentime-store.js';
import { resetScreenTimeSnapshotState } from '../../../src/core/time-tracking/screentime-snapshot.js';
import { localDateKey } from '../../../src/core/time-tracking/rollup.js';
import type { ScreenTimeDay, ScreenTimeSnapshot } from '../../../src/core/time-tracking/screentime-reader.js';

const TODAY = localDateKey(new Date());
const PHONE = 'device-phone-0001';
const MAC = 'device-mac-0001';
const STORE_DIR = () => path.join(WALNUT_HOME, 'time-tracking', 'screentime');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/time', timeRouter);
  return server;
}

function phoneDay(date = TODAY): ScreenTimeDay {
  return {
    date,
    deviceId: PHONE,
    deviceName: 'Phone',
    platform: 1,
    totalMs: 3_600_000,
    pickups: 42,
    notifications: 17,
    apps: [
      { bundleId: 'com.example.reader', ms: 2_400_000, pickups: 30, notifications: 12 },
      { bundleId: 'com.example.browser', ms: 900_000 },
      { bundleId: 'com.example.browser', domain: 'example.com', ms: 600_000 },
    ],
    blocks: [
      { startTs: `${date}T09:00:00.000Z`, ms: 1_800_000 },
      { startTs: `${date}T10:00:00.000Z`, ms: 1_800_000 },
    ],
  };
}

function macDay(date = TODAY): ScreenTimeDay {
  return {
    date,
    deviceId: MAC,
    deviceName: 'Studio',
    platform: 3,
    totalMs: 7_200_000,
    pickups: 5,
    notifications: 2,
    apps: [{ bundleId: 'com.example.editor', ms: 7_200_000 }],
    blocks: [{ startTs: `${date}T14:00:00.000Z`, ms: 7_200_000 }],
  };
}

function snapshot(days: ScreenTimeDay[], localDeviceIds: string[] = [MAC]): ScreenTimeSnapshot {
  return {
    days,
    devices: days.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, platform: d.platform })),
    localDeviceIds,
  };
}

/** getConfig() re-reads the file on every call, so writing it is the whole setup. */
async function writeConfig(body: string): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, body, 'utf-8');
}

beforeEach(async () => {
  reader.probe.mockReset();
  reader.read.mockReset();
  reader.probe.mockResolvedValue({ ok: true, helperPath: reader.helperPath });
  reader.read.mockResolvedValue(snapshot([phoneDay(), macDay()]));
  resetScreenTimeStore();
  resetScreenTimeSnapshotState();
  // The route caches the permission answer for 15s. Without this, a case that
  // stubs a DENIED probe would silently read the previous case's 'ok'.
  resetScreenTimeAccessCache();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetScreenTimeStore();
  resetScreenTimeSnapshotState();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/time/screentime', () => {
  it('reports off, and reads nothing at all, until the feature is enabled', async () => {
    await writeConfig('time: {}\n');
    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);

    expect(res.body.enabled).toBe(false);
    expect(res.body.access).toBe('off');
    expect(res.body.devices).toEqual([]);
    // The whole point: a disabled feature must not probe a permission or spawn a
    // helper, or merely opening the tab would ask macOS about Full Disk Access.
    expect(reader.probe).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('answers one day per device from our own store, without reading Apple', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    // Bank a day the way the scheduler would.
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);
    reader.read.mockClear();

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);

    expect(res.body.enabled).toBe(true);
    expect(res.body.access).toBe('ok');
    // The phone is the default view; the Mac is stored but withheld.
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].deviceId).toBe(PHONE);
    expect(res.body.devices[0].totalMs).toBe(3_600_000);
    expect(res.body.devices[0].pickups).toBe(42);
    expect(res.body.devices[0].notifications).toBe(17);
    expect(res.body.localDevices).toBeUndefined();
    // Apple's own numbers for this Mac are still REPORTED as a total, so a UI can
    // offer them without a second request.
    expect(res.body.localTotalMs).toBe(7_200_000);
    // A GET must never be the thing that reads Apple's store.
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('keeps app rows and website rows apart', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    const phone = res.body.devices[0];

    expect(phone.apps.map((a: { bundleId: string }) => a.bundleId))
      .toEqual(['com.example.reader', 'com.example.browser']);
    expect(phone.sites).toEqual([{ domain: 'example.com', ms: 600_000 }]);
    // Apple counts the site's time INSIDE the browser's app time. Summing the two
    // lists would double a browsing hour, so they are reported separately.
    expect(phone.appMs).toBe(3_300_000);
    expect(phone.siteMs).toBe(600_000);
  });

  it('shows this Mac only once asked, and the data was there all along', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    await request(app()).post('/api/time/screentime/toggle')
      .send({ includeThisMac: true }).expect(200);

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    expect(res.body.includeThisMac).toBe(true);
    expect(res.body.localDevices).toHaveLength(1);
    expect(res.body.localDevices[0].deviceId).toBe(MAC);
    // Never re-read Apple to answer this: flipping a display switch cannot be what
    // recovers data, or a user who flipped it a month late would have lost a month.
    expect(res.body.localDevices[0].totalMs).toBe(7_200_000);
  });

  it('passes a stale grant through as its own state, not as a plain denial', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    reader.probe.mockResolvedValue({
      kind: 'denied', denied: 'stale_grant', helperPath: reader.helperPath,
    });

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);

    expect(res.body.access).toBe('stale_grant');
    // The path has to reach the client: the fix is pasting THIS path back into
    // System Settings, and no other string will do.
    expect(res.body.helperPath).toBe(reader.helperPath);
  });

  it('distinguishes never-granted from stale, and a missing store from both', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');

    reader.probe.mockResolvedValue({
      kind: 'denied', denied: 'needs_grant', helperPath: reader.helperPath,
    });
    let res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    expect(res.body.access).toBe('needs_grant');

    // The route caches for 15s, so the next assertion needs a fresh probe.
    resetScreenTimeAccessCache();
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    reader.probe.mockResolvedValue({ kind: 'no_store', helperPath: reader.helperPath });
    res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    // no_store is not a permission problem, so it must never be reported as one.
    expect(res.body.access).toBe('no_store');
  });

  it('rejects a date that is not a real calendar day', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    const res = await request(app()).get('/api/time/screentime?date=2026-02-31').expect(400);
    expect(res.body.error).toBe('invalid_date');
  });

  it('lists the days our copy holds, so an empty day can say which it is', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    expect(res.body.storedDates).toContain(TODAY);
  });
});

describe('POST /api/time/screentime/toggle', () => {
  it('flips the master switch and persists it', async () => {
    await writeConfig('time: {}\n');

    const on = await request(app()).post('/api/time/screentime/toggle').send({}).expect(200);
    expect(on.body.enabled).toBe(true);
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toMatch(/enabled: true/);

    const off = await request(app()).post('/api/time/screentime/toggle').send({}).expect(200);
    expect(off.body.enabled).toBe(false);
  });

  it('honours an explicit value, so a double-fired UI cannot flip twice', async () => {
    await writeConfig('time: {}\n');
    await request(app()).post('/api/time/screentime/toggle').send({ enabled: true }).expect(200);
    const again = await request(app()).post('/api/time/screentime/toggle').send({ enabled: true }).expect(200);
    expect(again.body.enabled).toBe(true);
  });

  it('changes only the switch it was sent', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    const res = await request(app()).post('/api/time/screentime/toggle')
      .send({ includeThisMac: true }).expect(200);
    // Sending only the display switch must not turn the feature off.
    expect(res.body.enabled).toBe(true);
    expect(res.body.includeThisMac).toBe(true);
  });

  it('leaves the outside-activity setting alone', async () => {
    await writeConfig('time:\n  outside:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/toggle').send({ enabled: true }).expect(200);
    const body = await fs.readFile(CONFIG_FILE, 'utf-8');
    // updateConfig replaces the whole `time` key, so a sibling that is not carried
    // over is silently switched off.
    expect(body).toMatch(/outside:/);
    expect(body).toMatch(/screentime:/);
  });

  it('turning it OFF keeps every day already captured', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);
    const before = await fs.readdir(STORE_DIR());
    expect(before).toContain(`${TODAY}.jsonl`);

    await request(app()).post('/api/time/screentime/toggle').send({ enabled: false }).expect(200);

    // The entire value of this feature is that our copy outlives Apple's. "Stop
    // collecting" must never mean "delete what you collected".
    expect(await fs.readdir(STORE_DIR())).toEqual(before);
  });
});

describe('POST /api/time/screentime/refresh', () => {
  it('reads Apple once and banks every device-day', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');

    const res = await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(res.body.ok).toBe(true);
    expect(res.body.days).toBe(1); // both devices share one date, so one file
    expect(res.body.devices).toBe(2);
  });

  it('re-reading the same day REPLACES it rather than doubling the totals', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);
    await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    const res = await request(app()).get(`/api/time/screentime?date=${TODAY}`).expect(200);
    // Apple keeps revising recent days, so the scheduler re-reads them. If a rewrite
    // ever became an append, every total would multiply by the number of snapshots.
    expect(res.body.devices[0].totalMs).toBe(3_600_000);
    expect(res.body.devices[0].apps[0].ms).toBe(2_400_000);
  });

  it('a denied read is reported as not ok, and stores nothing', async () => {
    await writeConfig('time:\n  screentime:\n    enabled: true\n');
    reader.read.mockResolvedValue({ kind: 'denied', denied: 'needs_grant', helperPath: reader.helperPath });

    const res = await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.failure?.denied).toBe('needs_grant');
    await expect(fs.readdir(STORE_DIR())).rejects.toThrow();
  });

  it('does nothing while the feature is off', async () => {
    await writeConfig('time: {}\n');
    const res = await request(app()).post('/api/time/screentime/refresh').send({}).expect(200);
    // Not an error: the user chose this. Reporting it as a failure would light up
    // the settings panel with a problem they deliberately created.
    expect(res.body.ok).toBe(true);
    expect(res.body.days).toBe(0);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
