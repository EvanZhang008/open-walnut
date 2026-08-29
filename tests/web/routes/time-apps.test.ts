/**
 * GET /api/time/apps + POST /api/time/apps/toggle — the real router mounted on a
 * throwaway express app, answering from a real (temp) store and a real config
 * file. The helper CHILD is stubbed: spawning it would need macOS plus a swiftc
 * compile, and the acceptance rule it feeds is unit tested in
 * tests/core/time-tracking/outside-collector.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-outside-route'));

// vi.hoisted: vi.mock's factory is lifted above every import AND above plain
// top-level consts, so a stub it closes over has to be hoisted with it.
const helper = vi.hoisted(() => ({
  running: false,
  reason: null as null | 'not_macos' | 'no_compiler' | 'compile_failed',
  start: vi.fn(async () => {}),
  stop: vi.fn(() => {}),
}));
vi.mock('../../../src/core/time-tracking/outside-collector.js', () => ({
  isOutsideCollectorRunning: () => helper.running,
  outsideHelperReason: () => helper.reason,
  startOutsideCollector: helper.start,
  stopOutsideCollector: helper.stop,
}));

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js';
import { timeRouter } from '../../../src/web/routes/time.js';
import { resetOutsideStore } from '../../../src/core/time-tracking/outside-store.js';
import { localDateKey } from '../../../src/core/time-tracking/rollup.js';

const TODAY = localDateKey(new Date());
const OUTSIDE_DIR = () => path.join(WALNUT_HOME, 'time-tracking', 'outside');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/time', timeRouter);
  return server;
}

interface SeedRow {
  app: string;
  bundleId?: string;
  host?: string;
  durationMs: number;
}

async function seedDay(date: string, rows: SeedRow[]): Promise<void> {
  await fs.mkdir(OUTSIDE_DIR(), { recursive: true });
  const lines = rows.map((r) => JSON.stringify({ date, ts: `${date}T15:00:00.000Z`, ...r }));
  await fs.writeFile(path.join(OUTSIDE_DIR(), `${date}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  resetOutsideStore(); // next read hydrates from what we just wrote
}

async function writeConfig(body: string): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, body, 'utf-8');
}

beforeEach(async () => {
  helper.running = false;
  helper.reason = null;
  helper.start.mockClear();
  helper.stop.mockClear();
  resetOutsideStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetOutsideStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/time/apps', () => {
  it('answers one day as apps, sites, and inside-Walnut time', async () => {
    await writeConfig('time:\n  outside:\n    enabled: true\n');
    await seedDay(TODAY, [
      { app: 'Walnut', bundleId: 'com.local.walnut-desktop', durationMs: 600_000 },
      { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', durationMs: 300_000 },
      { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'localhost', durationMs: 120_000 },
      { app: 'Google Chrome', bundleId: 'com.google.Chrome', durationMs: 60_000 },
      { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', durationMs: 90_000 },
    ]);
    helper.running = true;

    const res = await request(app()).get(`/api/time/apps?date=${TODAY}`).expect(200);
    expect(res.body).toEqual({
      date: TODAY,
      enabled: true,
      running: true,
      totalMs: 1_170_000,
      walnutMs: 720_000, // the desktop app + the localhost tab
      browserHostsSeen: true,
      apps: [
        { app: 'Walnut', bundleId: 'com.local.walnut-desktop', ms: 600_000, walnut: true },
        {
          app: 'Google Chrome',
          bundleId: 'com.google.Chrome',
          ms: 480_000,
          sites: [
            { host: 'github.com', ms: 300_000 },
            { host: 'localhost', ms: 120_000 },
          ],
        },
        { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', ms: 90_000 },
      ],
    });
  });

  it('defaults to today and reports the disabled, empty state', async () => {
    const res = await request(app()).get('/api/time/apps').expect(200);
    expect(res.body).toEqual({
      date: TODAY,
      enabled: false,
      running: false,
      totalMs: 0,
      walnutMs: 0,
      browserHostsSeen: true,
      apps: [],
    });
  });

  it('flags a day whose browser time never carried a host', async () => {
    await seedDay(TODAY, [{ app: 'Safari', bundleId: 'com.apple.Safari', durationMs: 300_000 }]);
    const res = await request(app()).get(`/api/time/apps?date=${TODAY}`).expect(200);
    expect(res.body.browserHostsSeen).toBe(false);
    expect(res.body.apps).toEqual([{ app: 'Safari', bundleId: 'com.apple.Safari', ms: 300_000 }]);
  });

  it('counts the configured companion hostname as Walnut time', async () => {
    await writeConfig('cloud_bridge:\n  url: wss://companion.example.test/bridge\n');
    await seedDay(TODAY, [
      { app: 'Safari', bundleId: 'com.apple.Safari', host: 'companion.example.test', durationMs: 45_000 },
    ]);
    const res = await request(app()).get(`/api/time/apps?date=${TODAY}`).expect(200);
    expect(res.body.walnutMs).toBe(45_000);
    expect(res.body.apps[0].walnut).toBe(true);
  });

  it('rejects a date that is not a real calendar day', async () => {
    await request(app()).get('/api/time/apps?date=2026-02-30').expect(400);
    await request(app()).get('/api/time/apps?date=yesterday').expect(400);
  });

  it('reports WHY sampling cannot run, so the UI can say more than "off"', async () => {
    helper.reason = 'no_compiler';
    const res = await request(app()).get('/api/time/apps').expect(200);
    expect(res.body.reason).toBe('no_compiler');
  });

  it('omits reason when nothing is wrong', async () => {
    const res = await request(app()).get('/api/time/apps').expect(200);
    expect(res.body).not.toHaveProperty('reason');
  });
});

describe('POST /api/time/apps/toggle', () => {
  it('flips the persisted setting and starts the collector', async () => {
    const res = await request(app()).post('/api/time/apps/toggle').send({}).expect(200);
    expect(res.body).toEqual({ enabled: true, running: false });
    expect(helper.start).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toMatch(/outside:\s*\n\s*enabled: true/);
  });

  it('flips back and stops the collector', async () => {
    await writeConfig('time:\n  outside:\n    enabled: true\n');
    helper.running = true;
    const res = await request(app()).post('/api/time/apps/toggle').send({}).expect(200);
    expect(res.body.enabled).toBe(false);
    expect(helper.stop).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toMatch(/outside:\s*\n\s*enabled: false/);
  });

  it('honours an explicit enabled flag, so a double-fired UI cannot flip twice', async () => {
    await request(app()).post('/api/time/apps/toggle').send({ enabled: true }).expect(200);
    const res = await request(app()).post('/api/time/apps/toggle').send({ enabled: true }).expect(200);
    expect(res.body.enabled).toBe(true);
  });

  it('keeps the rest of the config when it persists the flag', async () => {
    await writeConfig('time:\n  outside:\n    enabled: false\nstt:\n  engine: mlx\n');
    await request(app()).post('/api/time/apps/toggle').send({ enabled: true }).expect(200);
    const text = await fs.readFile(CONFIG_FILE, 'utf-8');
    expect(text).toMatch(/engine: mlx/);
    expect(text).toMatch(/enabled: true/);
  });
});
