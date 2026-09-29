/**
 * Plugin status items through a REAL server: a plugin installed in the data home's
 * plugins/ directory publishes an item on activate, and the wiring the unit tests
 * cannot see is checked end to end:
 *   - GET /api/plugin-status-items answers the live list;
 *   - an op that changes the item reaches a browser WebSocket as `plugin:status-items`,
 *     whole list, with its buttons bound to the plugin's own ops;
 *   - the op a button names runs through the plugin-runtime route;
 *   - disabling the plugin removes the item (list + broadcast), reloading brings it back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;
let ws: WebSocket;
const frames: Array<{ type?: string; name?: string; data?: unknown }> = [];

type Items = { items: Array<{ key: string; title: string; tone: string; actions: Array<{ op: string; pluginId: string; label: string }> }> };

async function api(method: string, route: string, body?: unknown) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

async function waitFor<T>(probe: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

const itemFrames = () => frames.filter(f => f.name === 'plugin:status-items').map(f => f.data as Items);

const PROBE_SERVER = `
export function activate(walnut) {
  const item = walnut.ui.statusItem({ id: 'probe' })
  const op = (name, handler, properties = {}) => walnut.registry.op({
    name, title: name, description: 'Status item probe: ' + name, readonly: false, remote: 'deny',
    inputSchema: { type: 'object', properties }, handler,
  })
  let acks = 0
  op('show', async (args) => { item.set(args.state); return { shown: true } }, { state: { type: 'object' } })
  op('ack', async () => { acks += 1; item.set({ title: 'Acknowledged ' + acks, tone: 'success', glyph: 'check' }); return { acks } })
  item.set({ title: 'Probe ready', actions: [{ label: 'Got it', op: 'ack', primary: true }] })
}
`;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  const dir = path.join(WALNUT_HOME, 'plugins', 'probe');
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
  }));
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), PROBE_SERVER);
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
}, 90_000);

afterAll(async () => {
  ws?.close();
  await stopServer();
  // A late write after stopServer (a plugin flushing its data dir) made a plain rm fail
  // with ENOTEMPTY; retry instead of failing a run whose tests all passed.
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('plugin status items over the wire', () => {
  it('GET answers what the plugin published on activate, buttons bound to its own ops', async () => {
    // Plugins activate after the server starts listening; poll until the probe is up.
    let data: Items = { items: [] };
    for (let i = 0; i < 200 && data.items.length === 0; i++) {
      data = (await api('GET', '/api/plugin-status-items')).data as Items;
      if (data.items.length === 0) await new Promise(r => setTimeout(r, 50));
    }
    expect(data.items).toEqual([expect.objectContaining({
      key: 'probe:probe', title: 'Probe ready', tone: 'neutral',
      actions: [expect.objectContaining({ label: 'Got it', op: 'probe_ack', pluginId: 'probe' })],
    })]);
  });

  it('a change reaches the browser as the whole list, and the button\'s op runs', async () => {
    const shown = await api('POST', '/api/plugin-runtime/probe/ops/probe_show', { state: { title: 'Focus · {remaining} left', tone: 'accent' } });
    expect(shown.data).toMatchObject({ ok: true });
    const frame = await waitFor(() => itemFrames().find(d => d.items[0]?.tone === 'accent'));
    expect(frame.items).toHaveLength(1);
    expect(frame.items[0]).toMatchObject({ key: 'probe:probe', title: 'Focus · {remaining} left' });

    const acked = await api('POST', '/api/plugin-runtime/probe/ops/probe_ack', {});
    expect(acked.data).toMatchObject({ ok: true, result: { acks: 1 } });
    await waitFor(() => itemFrames().find(d => d.items[0]?.title === 'Acknowledged 1'));
    expect((await api('GET', '/api/plugin-status-items')).data.items[0]).toMatchObject({ title: 'Acknowledged 1', tone: 'success' });
  });

  it('disable takes the item away, reload brings it back', async () => {
    const disabled = await api('POST', '/api/plugin-runtime/probe/disable', {});
    expect(disabled.status).toBe(200);
    await waitFor(() => itemFrames().find(d => d.items.length === 0));
    expect((await api('GET', '/api/plugin-status-items')).data).toEqual({ items: [] });

    const reloaded = await api('POST', '/api/plugin-runtime/probe/reload', {});
    expect(reloaded.status).toBe(200);
    await waitFor(() => itemFrames().reverse().find(d => d.items[0]?.title === 'Probe ready'));
    expect((await api('GET', '/api/plugin-status-items')).data.items[0]).toMatchObject({ title: 'Probe ready' });
  });
});
