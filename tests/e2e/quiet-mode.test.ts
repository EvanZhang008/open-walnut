/**
 * Quiet mode + reminder removal through a REAL server (routes mounted, boot load,
 * WebSocket broadcast), the wiring the unit tests cannot see:
 *   - GET/PUT /api/quiet answer from the core state, and a change reaches a
 *     browser WebSocket as `quiet:changed`.
 *   - `notification:removed` (a plugin retiring its reminder) reaches the browser.
 *   - `time:banked` from the console's heartbeat POST reaches an in-process
 *     subscriber and is NOT broadcast to the browser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

let server: HttpServer;
let port: number;
let ws: WebSocket;
const frames: Array<{ type?: string; name?: string; data?: unknown }> = [];

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

async function waitFor<T>(probe: () => T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
}, 60_000);

afterAll(async () => {
  ws?.close();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('quiet mode over the wire', () => {
  it('PUT holds the user hold, GET reads it, and the browser hears quiet:changed', async () => {
    expect((await api('GET', '/api/quiet')).data).toEqual({ active: false, allowPermissions: true, holds: [] });

    const on = await api('PUT', '/api/quiet', { on: true, minutes: 30 });
    expect(on.status).toBe(200);
    expect(on.data.active).toBe(true);
    const changed = await waitFor(() => frames.find(f => f.name === 'quiet:changed' && (f.data as { active?: boolean })?.active));
    expect((changed.data as { holds: Array<{ source: string }> }).holds[0].source).toBe('user');

    const off = await api('PUT', '/api/quiet', { on: false });
    expect(off.data.active).toBe(false);
    await waitFor(() => frames.find(f => f.name === 'quiet:changed' && (f.data as { active?: boolean })?.active === false));
  });

  it('a producer\'s notification:removed reaches the browser', async () => {
    bus.emit(EventNames.NOTIFICATION_REMOVED, { id: 'n1', dedupKey: 'plugin:walnut-rhythm:stand-up' }, ['web-ui'], { source: 'test' });
    const frame = await waitFor(() => frames.find(f => f.name === 'notification:removed'));
    expect(frame.data).toEqual({ id: 'n1', dedupKey: 'plugin:walnut-rhythm:stand-up' });
  });

  it('a console heartbeat announces time:banked in-process only', async () => {
    const seen: unknown[] = [];
    bus.subscribe('quiet-e2e-presence', (e) => { seen.push(e.data); }, { global: true, interest: [EventNames.TIME_BANKED] });
    try {
      const r = await api('POST', '/api/time/heartbeats', {
        samples: [{ ts: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, kind: 'chat' }],
      });
      expect(r.status).toBe(204);
      const data = await waitFor(() => seen[0] as { records: Array<{ kind: string; durationMs: number }> } | undefined);
      expect(data.records).toEqual([expect.objectContaining({ kind: 'chat', durationMs: 60_000 })]);
      await new Promise(r2 => setTimeout(r2, 100));
      expect(frames.some(f => f.name === 'time:banked')).toBe(false);
    } finally {
      bus.unsubscribe('quiet-e2e-presence');
    }
  });
});
