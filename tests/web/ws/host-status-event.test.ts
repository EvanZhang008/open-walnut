/**
 * host:status over the WebSocket.
 *
 * The whole point of the event is that the browser never polls a connecting
 * host. Two things have to hold for that:
 *   - emitting to 'web-ui' is enough (server.ts's single bus→WS bridge), and
 *   - it reaches a LIGHTWEIGHT client too. A client that narrowed its interest
 *     to one session still needs host news, because the host is what its
 *     session runs on. The handler's rule is "an event with no sessionId/taskId
 *     is not about some other entity, so send it" — that rule is what this
 *     event depends on, and it had no test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { attachWss, broadcastEvent, closeWss } from '../../../src/web/ws/handler.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import type { WsFrame } from '../../../src/web/ws/protocol.js';

let server: HttpServer;
let port: number;
const open: WebSocket[] = [];

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    open.push(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMatchingMessage(
  ws: WebSocket,
  predicate: (frame: WsFrame) => boolean,
  timeoutMs = 3000,
): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for matching WS message')), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as WsFrame;
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

function sendRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = waitForMatchingMessage(ws, (f) => f.type === 'res' && f.id === id);
  ws.send(JSON.stringify({ type: 'req', id, method, payload } satisfies WsFrame));
  return res;
}

const isHostStatus = (f: WsFrame) => f.type === 'event' && f.name === EventNames.HOST_STATUS;

/** A realistic mid-connect payload (the shape buildHostStatus produces). */
function status(host: string, phase: string) {
  return {
    host, label: host, hostname: `${host}.example.test`,
    connected: phase === 'connected', phase, phaseLabel: `Opening an SSH connection to ${host}`,
    steps: [{ phase: 'ssh', label: 'SSH', status: 'active' }],
    phaseElapsedMs: 300, connectElapsedMs: 300, at: Date.now(),
  };
}

beforeAll(async () => {
  server = createServer();
  attachWss(server);
  // The one bridge server.ts installs: gated purely by each emit's destinations.
  bus.subscribe('web-ui', (event) => { broadcastEvent(event.name, event.data); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  bus.unsubscribe('web-ui');
  closeWss();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(async () => {
  while (open.length) open.pop()?.close();
  await new Promise((r) => setTimeout(r, 30));
});

describe('host:status over WS', () => {
  it('reaches a normal client with the payload intact', async () => {
    const ws = await connectClient();
    const wait = waitForMatchingMessage(ws, isHostStatus);

    bus.emit(EventNames.HOST_STATUS, status('devbox', 'install-runtime'), ['web-ui']);

    const frame = await wait;
    expect(frame.name).toBe('host:status');
    expect(frame.data).toMatchObject({ host: 'devbox', phase: 'install-runtime' });
  });

  it('reaches a LIGHTWEIGHT client filtered to an unrelated session', async () => {
    const ws = await connectClient();
    const applied = await sendRpc(ws, 'set-interest', { mode: 'lightweight', ids: ['session-somewhere-else'] });
    expect((applied.payload as { mode: string }).mode).toBe('lightweight');

    const wait = waitForMatchingMessage(ws, isHostStatus);
    bus.emit(EventNames.HOST_STATUS, status('marina', 'ssh'), ['web-ui']);

    const frame = await wait;
    expect(frame.data).toMatchObject({ host: 'marina', phase: 'ssh' });
  });

  it('reaches every open client at once (each host push is a fan-out)', async () => {
    const a = await connectClient();
    const b = await connectClient();
    await sendRpc(b, 'set-interest', { mode: 'lightweight', ids: ['session-b'] });

    const waits = Promise.all([
      waitForMatchingMessage(a, isHostStatus),
      waitForMatchingMessage(b, isHostStatus),
    ]);
    bus.emit(EventNames.HOST_STATUS, status('acme-1', 'connected'), ['web-ui']);

    const [fa, fb] = await waits;
    expect(fa.data).toMatchObject({ host: 'acme-1', connected: true });
    expect(fb.data).toMatchObject({ host: 'acme-1', connected: true });
  });

  it('an emit that does not name web-ui never reaches the browser', async () => {
    const ws = await connectClient();
    let seen = false;
    ws.on('message', (data) => {
      if (isHostStatus(JSON.parse(data.toString()) as WsFrame)) seen = true;
    });

    bus.emit(EventNames.HOST_STATUS, status('devbox', 'ssh'), ['some-other-subsystem']);
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toBe(false);
  });
});
