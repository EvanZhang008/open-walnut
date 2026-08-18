/**
 * Disk watermark E2E — a REAL server (startServer) with only the statfs
 * syscall stubbed, proving the graceful-degradation contract of the
 * 2026-08-12 ENOSPC outage fix end-to-end through actual HTTP:
 *
 *   1. disk at 92% → POST /api/tasks answers 507 disk_full (NOT an ENOSPC
 *      crash mid-lock), GET /api/tasks still works, git-sync is pull-only.
 *   2. disk at 81% → writes flow normally + a "Data Disk Filling Up"
 *      notification lands in the real notification feed.
 *   3. recovery → the 507 lifts and writes succeed again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import {
  _setStatfsForTest,
  pollDiskWatermarkOnce,
  resetDiskWatermarkForTest,
} from '../../src/core/disk-watermark.js';
import { isDiskPullOnly, resetSyncGuardForTest } from '../../src/integrations/git-sync.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string) { return `http://localhost:${port}${p}`; }

async function api(method: string, p: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(apiUrl(p), opts);
  return { status: r.status, data: await r.json().catch(() => null) };
}

/**
 * statfs stub for a 30GiB filesystem (the incident box's root size) at the
 * given used percent — small enough that the absolute-free gates trip too.
 */
function stubUsedPct(pct: number): void {
  const blocks = 30 * 256;
  const bsize = 4 * 1024 * 1024;
  const bavail = Math.round(blocks * (100 - pct) / 100);
  _setStatfsForTest(async () => ({ bsize, blocks, bfree: bavail, bavail }));
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  _setStatfsForTest(null);
  resetDiskWatermarkForTest();
  resetSyncGuardForTest();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('disk watermark through a real server', () => {
  it('baseline: task writes succeed on a healthy disk', async () => {
    stubUsedPct(40);
    await pollDiskWatermarkOnce();
    const create = await api('POST', '/api/tasks', { title: 'baseline task' });
    expect(create.status).toBe(201);
  });

  it('at 92%: task write answers 507 disk_full, reads keep working, git-sync pull-only', async () => {
    stubUsedPct(92);
    await pollDiskWatermarkOnce();

    // The write is REFUSED with the machine-readable contract — not an ENOSPC 500.
    const create = await api('POST', '/api/tasks', { title: 'should be refused' });
    expect(create.status).toBe(507);
    expect(create.data?.code).toBe('disk_full');
    expect(String(create.data?.error)).toMatch(/critically full/i);

    // Reads are untouched — the phone can still SEE its tasks while full.
    const list = await api('GET', '/api/tasks');
    expect(list.status).toBe(200);

    // git-sync is latched pull-only (no commits/pushes onto a full disk).
    expect(isDiskPullOnly()).toBe(true);

    // Update/delete are blocked too (any mutating verb).
    const patch = await api('PATCH', '/api/tasks/nonexistent-id', { title: 'x' });
    expect(patch.status).toBe(507);
  });

  it('notification carve-outs stay writable while blocked (mark-read must work)', async () => {
    stubUsedPct(92);
    await pollDiskWatermarkOnce();
    // Not a 507 — the alert about the full disk must itself stay actionable.
    const r = await api('POST', '/api/notifications/mark-read', { ids: [] });
    expect(r.status).not.toBe(507);
  });

  it('the phone\'s flight recorder keeps ingesting while blocked', async () => {
    stubUsedPct(92);
    await pollDiskWatermarkOnce();
    // /browser-logs was carved out but /v1/client-logs (its MOBILE twin) was
    // not, so a full disk silently 507'd every diagnostic upload — and the
    // client only abandons compression on a 4xx, so a 507 makes it retry the
    // same batch forever. Losing the phone's evidence of whatever the full disk
    // broke is exactly the outcome the carve-out list exists to prevent.
    const r = await api('POST', '/api/v1/client-logs', {
      device: 'disk-guard-probe', appVersion: '1.0.0', os: 'iOS 26',
      lines: [{ ts: new Date().toISOString(), level: 'error', subsystem: 'sse', message: 'x' }],
    });
    expect(r.status).not.toBe(507);
    expect(r.status).toBe(200);
  });

  it('at 81%: writes flow + the warning notification lands in the real feed', async () => {
    // Reset so the ok→warn transition (the notifying edge) happens now.
    resetDiskWatermarkForTest();
    stubUsedPct(81);
    // Route through the server's own monitor sink (publishErrorNotification →
    // notifications store) by polling with the wired notify: the running
    // monitor's next tick would do this, but the test forces it deterministically.
    const { addNotification } = await import('../../src/core/notifications/store.js');
    await pollDiskWatermarkOnce((title, body, dedupScope) => {
      void addNotification({
        kind: 'operation-error', severity: 'error', title, body,
        dedupKey: `error:${dedupScope}`,
      });
    });

    // Writes still work at warn level.
    const create = await api('POST', '/api/tasks', { title: 'warn-level task' });
    expect(create.status).toBe(201);
    expect(isDiskPullOnly()).toBe(false);

    // The warning is in the durable feed the UI reads ({ feed, unreadCount }).
    const feed = await api('GET', '/api/notifications');
    expect(feed.status).toBe(200);
    const items = (feed.data?.feed ?? []) as Array<{ title?: string }>;
    expect(items.some((n) => /Data Disk Filling Up/i.test(String(n.title)))).toBe(true);
  });

  it('recovery: the 507 lifts once the disk drains', async () => {
    stubUsedPct(95);
    await pollDiskWatermarkOnce();
    expect((await api('POST', '/api/tasks', { title: 'nope' })).status).toBe(507);

    stubUsedPct(50);
    await pollDiskWatermarkOnce();
    const create = await api('POST', '/api/tasks', { title: 'recovered task' });
    expect(create.status).toBe(201);
    expect(isDiskPullOnly()).toBe(false);
  });
});
