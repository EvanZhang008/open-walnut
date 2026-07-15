/**
 * Notification center E2E — full REST surface through a real server.
 * Covers the iPhone-style behaviors added to the feed: legacy-body sanitization
 * on read, per-item dismiss (by id and dedupKey), clear-all, permission
 * resolution stamping, and the pending-permission re-add semantics.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import {
  addNotification,
  resolvePermissionNotification,
} from '../../src/core/notifications/store.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string) { return `http://localhost:${port}${path}`; }

async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(apiUrl(path), opts);
  return { status: r.status, data: await r.json() };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('notification center feed', () => {
  it('serves legacy bodies with entity refs stripped and long bodies truncated', async () => {
    await addNotification({
      kind: 'cron', severity: 'info', title: 'EKS Daily Report',
      body: 'Created <task-ref id="mr1-0001" label="Report Task"/> in <session-ref id="sess-1" label="CLI session"/>. '
        + 'padding '.repeat(120),
      dedupKey: 'cron:EKS Daily Report:1',
      sessionId: 'sess-1', taskId: 'mr1-0001',
    });

    const r = await api('GET', '/api/notifications');
    expect(r.status).toBe(200);
    const rec = r.data.feed.find((n: { dedupKey: string }) => n.dedupKey === 'cron:EKS Daily Report:1');
    expect(rec.body).not.toContain('<task-ref');
    expect(rec.body).toContain('Report Task');
    expect(rec.body.length).toBeLessThanOrEqual(601);
    // Deep-link targets survive alongside the stripped body.
    expect(rec.sessionId).toBe('sess-1');
    expect(rec.taskId).toBe('mr1-0001');
  });

  it('stamps a resolved permission so the UI can settle the card', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
      body: 'Session needs permission approval', sessionId: 'sess-2',
      dedupKey: 'perm:req-1',
    });
    await resolvePermissionNotification('req-1', 'allowed');

    const r = await api('GET', '/api/notifications');
    const rec = r.data.feed.find((n: { dedupKey: string }) => n.dedupKey === 'perm:req-1');
    expect(rec.resolved).toBe('allowed');
    expect(rec.severity).toBe('success');
  });

  it('dismisses a single entry by dedupKey, then re-adds a pending permission on re-ask', async () => {
    let r = await api('POST', '/api/notifications/dismiss', { dedupKeys: ['perm:req-1'] });
    expect(r.status).toBe(200);
    expect(r.data.removed).toBe(1);

    // The 60s re-ask path re-adds an unresolved permission under the same key.
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
      body: 'Session needs permission approval', sessionId: 'sess-2',
      dedupKey: 'perm:req-1',
    });
    r = await api('GET', '/api/notifications');
    expect(r.data.feed.filter((n: { dedupKey: string }) => n.dedupKey === 'perm:req-1')).toHaveLength(1);
  });

  it('clears the whole feed and leaves a .backup snapshot', async () => {
    const r = await api('POST', '/api/notifications/dismiss', {});
    expect(r.status).toBe(200);
    expect(r.data.removed).toBeGreaterThan(0);

    const list = await api('GET', '/api/notifications');
    expect(list.data.feed).toHaveLength(0);
    expect(list.data.unreadCount).toBe(0);

    const backup = JSON.parse(
      await fs.readFile(`${WALNUT_HOME}/notifications.backup.json`, 'utf-8'),
    );
    expect(backup.notifications.length).toBeGreaterThan(0);
  });
});
