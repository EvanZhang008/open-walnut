/**
 * Lean event frames through a real server (2026-11-11). Two sockets listen side by
 * side: the web app's (`/ws?lean=<signature>`, rebuilt by the client's own cache) and an older
 * client's (`/ws`). For a background ledger heartbeat and for task changes made through
 * the REST API, the lean socket must read exactly what the older one reads, while
 * carrying only what changed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-ws-lean-frames'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { LeanFrameCache } from '../../web/src/api/ws-lean.js';
import { LEAN_SIGNATURE } from '../../src/lib/ws-lean-protocol.js';

let server: HttpServer;
let port: number;

interface Seen { name: string; data: unknown; bytes: number }

function listen(path: string, lean: boolean): Promise<{ ws: WebSocket; seen: Seen[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`);
    const cache = new LeanFrameCache();
    const seen: Seen[] = [];
    ws.on('message', (raw) => {
      const text = raw.toString();
      const frame = JSON.parse(text) as { type: string; name: string; data: unknown };
      if (frame.type !== 'event') return;
      if (frame.name !== 'session:background-tasks' && !frame.name.startsWith('task:')) return;
      const data = lean ? cache.rebuild(frame.name, frame.data) : frame.data;
      seen.push({ name: frame.name, data, bytes: text.length });
    });
    ws.on('open', () => resolve({ ws, seen }));
    ws.on('error', reject);
  });
}

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('lean event frames through the server', () => {
  it('the lean socket reads what the older socket reads, carrying only what changed', async () => {
    const lean = await listen(`/ws?lean=${LEAN_SIGNATURE}`, true);
    const plain = await listen('/ws', false);
    try {
      // A background ledger heartbeat, twice: the second changes one row of 150.
      const rows = Array.from({ length: 150 }, (_, i) => ({ taskId: `bg-${i}`, status: 'completed', description: `Running command ${i} `.repeat(20) }));
      const ledger = () => ({ sessionId: 'lean-s1', taskId: 'lean-t1', inFlight: 1, foregroundActive: false, tasks: rows.map((r) => ({ ...r })), phases: [], agents: [] });
      bus.emit(EventNames.SESSION_BACKGROUND_TASKS, ledger(), ['web-ui'], { source: 'test' });
      rows[3].status = 'killed';
      bus.emit(EventNames.SESSION_BACKGROUND_TASKS, ledger(), ['web-ui'], { source: 'test' });

      // A task with a long note, then a phase change that leaves the note alone.
      const created = await fetch(`http://localhost:${port}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Lean frame probe', category: 'test' }),
      });
      const { task } = (await created.json()) as { task: { id: string } };
      const patch = async (body: Record<string, unknown>) => {
        const res = await fetch(`http://localhost:${port}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(200);
      };
      const note = await fetch(`http://localhost:${port}/api/tasks/${task.id}/note`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'A long note line.\n'.repeat(1000) }) });
      expect(note.status).toBe(200);
      await until(() => plain.seen.filter((s) => s.name === 'task:updated').length >= 1);
      await patch({ phase: 'IN_PROGRESS' });
      await until(() => plain.seen.filter((s) => s.name === 'task:updated').length >= 2);
      // Both sockets hear every event: wait for the lean one to catch up, never on a clock.
      await until(() => lean.seen.length >= plain.seen.length);

      expect(lean.seen.map((s) => s.name)).toEqual(plain.seen.map((s) => s.name));
      for (let i = 0; i < plain.seen.length; i++) {
        expect(JSON.stringify(lean.seen[i].data)).toBe(JSON.stringify(plain.seen[i].data));
      }
      const bg = (s: Seen[]) => s.filter((x) => x.name === 'session:background-tasks');
      expect(bg(plain.seen)[1].bytes).toBeGreaterThan(50_000);
      expect(bg(lean.seen)[1].bytes).toBeLessThan(1_000);
      // This task's own updates, after its long description landed.
      const mine = (s: Seen[]) => s.filter((x) => x.name === 'task:updated'
        && (x.data as { task?: { id?: string } }).task?.id === task.id);
      const plainMine = mine(plain.seen);
      const leanMine = mine(lean.seen);
      expect(leanMine.length).toBe(plainMine.length);
      const longAt = plainMine.findIndex((x) => ((x.data as { task: { note?: string } }).task.note ?? '').length > 10_000);
      expect(longAt).toBeGreaterThanOrEqual(0);
      const after = plainMine.slice(longAt + 1).map((x, i) => [x.bytes, leanMine[longAt + 1 + i].bytes]);
      expect(after.length).toBeGreaterThan(0);
      for (const [plainBytes, leanBytes] of after) expect(leanBytes).toBeLessThan(plainBytes - 10_000);
    } finally {
      lean.ws.close();
      plain.ws.close();
    }
  });
});
