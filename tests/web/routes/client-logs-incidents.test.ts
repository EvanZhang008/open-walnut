/**
 * Client-log ingest → incident notification tests.
 *
 * Covers the server half of the iOS flight recorder:
 *  - the /api/v1/client-logs route accepts a gzipped body (full-dump mode ships
 *    every level, so compression is what makes it affordable on cellular);
 *  - a `freeze` / `crash` line raises a bus event AND a durable notification;
 *  - dedup is per device per severity class per 10-min window, so a freeze storm
 *    is one entry — but a recovered STALL never suppresses a real freeze;
 *  - ordinary telemetry lines raise nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-client-incidents'));

import express from 'express';
import request from 'supertest';
import { LOG_DIR, WALNUT_HOME } from '../../../src/constants.js';
import path from 'node:path';
import { apiV1Router } from '../../../src/web/routes/api-v1.js';
import { listNotifications } from '../../../src/core/notifications/store.js';
import {
  flagClientIncidents,
  _resetClientIncidentsForTesting,
  INCIDENT_WINDOW_MS,
} from '../../../src/core/notifications/client-incidents.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/v1', apiV1Router);
  app.use(errorHandler);
  return app;
}

/** A freeze line in AppLog's wire shape (meta rides as `m_<key>`). */
function freezeLine(overrides: Record<string, unknown> = {}) {
  return {
    ts: new Date().toISOString(),
    level: 'error',
    subsystem: 'freeze',
    message: 'main thread unresponsive',
    m_stalledSeconds: '7.4',
    m_ctxScreen: 'session:a1b2c3d4',
    m_ctxKbFlips10s: '14',
    m_ctxMemoryMB: '412',
    m_build: '36',
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetClientIncidentsForTesting();
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  _resetClientIncidentsForTesting();
});

describe('POST /api/v1/client-logs — full-dump transport', () => {
  it('accepts a gzip-encoded body and writes the lines out', async () => {
    const device = `gz-${Date.now()}`;
    const payload = JSON.stringify({
      device, appVersion: '1.0.0 (36)', os: 'iOS 26',
      lines: [
        { ts: '2026-08-07T00:00:00.000Z', level: 'debug', subsystem: 'heartbeat', message: 'state', m_ctxScreen: 'chat' },
        { ts: '2026-08-07T00:00:01.000Z', level: 'info', subsystem: 'crumb', message: 'send', m_count: '42' },
      ],
    });

    // `.send(buffer)` with a JSON content-type makes superagent re-serialize the
    // buffer (body-parser then fails with "incorrect header check"), so stream
    // the gzip bytes with .write() to get them on the wire byte-exact.
    const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(createApp())
        .post('/api/v1/client-logs')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip');
      req.write(zlib.gzipSync(Buffer.from(payload)));
      req.end((err, response) => {
        if (err) reject(err); else resolve({ status: response.status, body: response.body });
      });
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, received: 2 });

    const day = new Date().toISOString().slice(0, 10);
    // Derived from the MOCKED LOG_DIR, never the literal '/tmp/open-walnut'.
    // The route used to hardcode that path, so this assertion read (and the
    // route wrote) the real production forensics dir — every run of this file
    // left `gz-<epoch>-<day>.log` debris among a real device's logs, which is
    // what made a genuine upload indistinguishable from test noise.
    const content = await fs.readFile(
      path.join(LOG_DIR, 'ios-client', `${device}-${day}.log`), 'utf-8',
    );
    const written = content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    // debug-level lines must survive ingest — full-dump means full dump.
    expect(written.some((l) => l.level === 'debug' && l.subsystem === 'heartbeat')).toBe(true);
    expect(written.every((l) => l.appVersion === '1.0.0 (36)')).toBe(true);
  });

  it('flags a freeze line as an incident notification', async () => {
    const device = `frz-${Date.now()}`;
    const res = await request(createApp())
      .post('/api/v1/client-logs')
      .send({ device, appVersion: '1.0.0', os: 'iOS 26', lines: [freezeLine()] });
    expect(res.status).toBe(200);

    // Flagging is fire-and-forget after the response — give it a tick.
    await vi.waitFor(async () => {
      const { feed } = await listNotifications();
      expect(feed.some((n) => n.dedupKey.startsWith(`ios-freeze:${device}`))).toBe(true);
    }, { timeout: 3000 });

    const { feed, unreadCount } = await listNotifications();
    const incident = feed.find((n) => n.dedupKey.startsWith(`ios-freeze:${device}`))!;
    expect(incident.severity).toBe('error');
    expect(incident.title).toContain('froze');
    // The body carries the forensic context, so the bell alone answers "where".
    expect(incident.body).toContain('Screen=session:a1b2c3d4');
    expect(incident.body).toContain('stalledSeconds=7.4');
    expect(unreadCount).toBeGreaterThan(0);
  });
});

describe('flagClientIncidents', () => {
  it('emits a bus event with the incident class', async () => {
    const seen: unknown[] = [];
    bus.subscribe('test-client-incident', (e) => { seen.push(e.data); }, {
      global: true, interest: [EventNames.CLIENT_INCIDENT],
    });
    try {
      await flagClientIncidents('phone-a', [freezeLine()]);
    } finally {
      bus.unsubscribe('test-client-incident');
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ device: 'phone-a', kind: 'freeze', count: 1 });
  });

  it('collapses a storm into ONE notification per device per window', async () => {
    const lines = Array.from({ length: 12 }, () => freezeLine());
    const first = await flagClientIncidents('phone-b', lines);
    const second = await flagClientIncidents('phone-b', lines);
    expect(first).toBe(1); // 12 lines in one batch → one entry
    expect(second).toBe(0); // still inside the 10-min window

    const { feed } = await listNotifications();
    expect(feed.filter((n) => n.dedupKey.includes('phone-b'))).toHaveLength(1);
  });

  it('a new window after the dedup interval gets its own entry', async () => {
    const now = Date.now();
    await flagClientIncidents('phone-c', [freezeLine()], { now });
    await flagClientIncidents('phone-c', [freezeLine()], { now: now + INCIDENT_WINDOW_MS + 1000 });
    const { feed } = await listNotifications();
    expect(feed.filter((n) => n.dedupKey.includes('phone-c'))).toHaveLength(2);
  });

  it('separates classes so a recovered stall cannot bury a real freeze', async () => {
    // Recovered stalls are ~10x more frequent by design (MainThreadWatchdog
    // reports sub-threshold hangs too) — sharing a dedup key with hard freezes
    // would mean the severe case silently never notifies.
    await flagClientIncidents('phone-d', [
      { subsystem: 'freeze', message: 'main thread recovered', level: 'error', m_hangSeconds: '3.2' },
    ]);
    await flagClientIncidents('phone-d', [freezeLine()]);
    await flagClientIncidents('phone-d', [
      { subsystem: 'crash', message: 'crash from previous launch', level: 'error', m_signal: '11' },
    ]);

    const { feed } = await listNotifications();
    const mine = feed.filter((n) => n.dedupKey.includes('phone-d'));
    expect(mine).toHaveLength(3);
    expect(mine.map((n) => n.dedupKey.split(':')[0]).sort())
      .toEqual(['ios-crash', 'ios-freeze', 'ios-stall']);
    // Severity reflects the class: a brief stall is a warning, not an error.
    expect(mine.find((n) => n.dedupKey.startsWith('ios-stall'))!.severity).toBe('warning');
    expect(mine.find((n) => n.dedupKey.startsWith('ios-crash'))!.severity).toBe('error');
  });

  it('classes a stall sample as evidence, not a verdict of "froze"', async () => {
    // T41 regression. `stall sample` is a stack captured while a stall is still
    // BUILDING (past the 1.5s sampling line, not yet the 5s report line) — it
    // may never become a freeze. It was added after this classifier and fell
    // through to the severe default, so every sample rang the bell as an ERROR
    // titled "iOS app froze". Field result: 68 of 72 iOS notifications read
    // "iOS app froze — stall sample" while the device had recorded ZERO
    // `main thread unresponsive` lines, which is what kept T41 open for four
    // rounds of investigating freezes that had not happened.
    await flagClientIncidents('phone-stall', [
      { subsystem: 'freeze', message: 'stall sample', level: 'error', m_stalledSeconds: '2.0', m_build: '45' },
    ]);
    const { feed } = await listNotifications();
    const entry = feed.find((n) => n.dedupKey.includes('phone-stall'))!;
    expect(entry.dedupKey.startsWith('ios-stall')).toBe(true);
    expect(entry.severity).toBe('warning');
    expect(entry.title).not.toContain('froze');
  });

  it('still fails loud on an UNKNOWN freeze message', async () => {
    // The permissive default is deliberate: a freeze message this server has
    // never seen must be treated as severe, not quietly downgraded.
    await flagClientIncidents('phone-unknown', [
      { subsystem: 'freeze', message: 'watchdog tripped some new way', level: 'error' },
    ]);
    const { feed } = await listNotifications();
    const entry = feed.find((n) => n.dedupKey.includes('phone-unknown'))!;
    expect(entry.dedupKey.startsWith('ios-freeze')).toBe(true);
    expect(entry.severity).toBe('error');
  });

  it('ignores ordinary telemetry', async () => {
    const created = await flagClientIncidents('phone-e', [
      { subsystem: 'heartbeat', message: 'state', level: 'debug' },
      { subsystem: 'network', message: 'request rejected', level: 'error', m_status: '502' },
      { subsystem: 'crumb', message: 'send', level: 'info' },
    ]);
    expect(created).toBe(0);
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(0);
  });

  it('names the repeat count so one entry still conveys a storm', async () => {
    await flagClientIncidents('phone-f', Array.from({ length: 5 }, () => freezeLine()));
    const { feed } = await listNotifications();
    const incident = feed.find((n) => n.dedupKey.includes('phone-f'))!;
    expect(incident.body).toContain('5×');
  });
});
