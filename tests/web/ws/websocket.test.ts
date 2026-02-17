import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import {
  attachWss,
  broadcastEvent,
  closeWss,
  clientCount,
  registerMethod,
} from '../../../src/web/ws/handler.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import type { WsFrame } from '../../../src/web/ws/protocol.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

/** Connect a WS client and wait for open. */
function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait for the next message from a WS client, parsed as WsFrame. */
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as WsFrame);
    });
  });
}

/** Wait for a message matching a predicate. */
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

/** Send an RPC request and wait for the response. */
function sendRpc(ws: WebSocket, method: string, payload: unknown, id?: string): Promise<WsFrame> {
  const reqId = id ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame: WsFrame = { type: 'req', id: reqId, method, payload };

  const responsePromise = waitForMatchingMessage(
    ws,
    (f) => f.type === 'res' && f.id === reqId,
  );

  ws.send(JSON.stringify(frame));
  return responsePromise;
}

/** Small delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Setup / Teardown ──

beforeAll(async () => {
  server = createServer();
  attachWss(server);

  // Wire bus → WS broadcast (same as server.ts does)
  bus.subscribe('web-ui', (event) => {
    broadcastEvent(event.name, event.data);
  });

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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterEach(() => {
  // Clean up any registered RPC methods between tests (except builtins)
  // The handler module doesn't expose a clearMethods, so we just register over
});

// ── Connection tests ──

describe('WebSocket connection', () => {
  it('client connects successfully', async () => {
    const ws = await connectClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await delay(50);
  });

  it('multiple clients can connect simultaneously', async () => {
    const ws1 = await connectClient();
    const ws2 = await connectClient();
    const ws3 = await connectClient();

    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    expect(ws3.readyState).toBe(WebSocket.OPEN);

    expect(clientCount()).toBeGreaterThanOrEqual(3);

    ws1.close();
    ws2.close();
    ws3.close();
    await delay(50);
  });

  it('rejects upgrade on non /ws path', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/not-ws`);
    const error = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    expect(error).toBe(true);
  });

  it('client receives events after connecting', async () => {
    const ws = await connectClient();
    const msgPromise = waitForMessage(ws);

    broadcastEvent(EventNames.TASK_CREATED, { id: 'new-task' });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    if (frame.type === 'event') {
      expect(frame.name).toBe(EventNames.TASK_CREATED);
      expect(frame.data).toEqual({ id: 'new-task' });
    }

    ws.close();
    await delay(50);
  });

  it('disconnected client does not receive events and no errors', async () => {
    const ws = await connectClient();
    ws.close();
    await delay(100);

    // Should not throw
    expect(() => {
      broadcastEvent(EventNames.TASK_UPDATED, { id: 'x' });
    }).not.toThrow();
  });

  it('client reconnects and receives events again', async () => {
    const ws1 = await connectClient();
    ws1.close();
    await delay(100);

    const ws2 = await connectClient();
    const msgPromise = waitForMessage(ws2);

    broadcastEvent(EventNames.TASK_COMPLETED, { id: 'reconnect-test' });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    if (frame.type === 'event') {
      expect(frame.name).toBe(EventNames.TASK_COMPLETED);
    }

    ws2.close();
    await delay(50);
  });
});

// ── Event push tests (bus → WebSocket) ──

describe('Event push (bus → WebSocket)', () => {
  it('bus.emit with destination ["web-ui"] pushes event to WS clients', async () => {
    const ws = await connectClient();
    const msgPromise = waitForMessage(ws);

    bus.emit(EventNames.TASK_CREATED, { id: 'bus-push' }, ['web-ui'], { source: 'api' });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    if (frame.type === 'event') {
      expect(frame.name).toBe(EventNames.TASK_CREATED);
      expect(frame.data).toEqual({ id: 'bus-push' });
    }

    ws.close();
    await delay(50);
  });

  it('event frame has correct format: { type: "event", name, data, seq }', async () => {
    const ws = await connectClient();
    const msgPromise = waitForMessage(ws);

    broadcastEvent('test:event', { foo: 'bar' });

    const frame = await msgPromise;
    expect(frame).toHaveProperty('type', 'event');
    expect(frame).toHaveProperty('name', 'test:event');
    expect(frame).toHaveProperty('data', { foo: 'bar' });
    expect(frame).toHaveProperty('seq');
    if (frame.type === 'event') {
      expect(typeof frame.seq).toBe('number');
      expect(frame.seq).toBeGreaterThan(0);
    }

    ws.close();
    await delay(50);
  });

  it('sequence numbers increment per client', async () => {
    const ws = await connectClient();

    const msg1Promise = waitForMessage(ws);
    broadcastEvent('test:seq', { n: 1 });
    const frame1 = await msg1Promise;

    const msg2Promise = waitForMessage(ws);
    broadcastEvent('test:seq', { n: 2 });
    const frame2 = await msg2Promise;

    const msg3Promise = waitForMessage(ws);
    broadcastEvent('test:seq', { n: 3 });
    const frame3 = await msg3Promise;

    if (frame1.type === 'event' && frame2.type === 'event' && frame3.type === 'event') {
      expect(frame2.seq).toBe(frame1.seq + 1);
      expect(frame3.seq).toBe(frame2.seq + 1);
    }

    ws.close();
    await delay(50);
  });

  it('events not destined for "web-ui" are NOT pushed to WS clients', async () => {
    const ws = await connectClient();

    // Emit to a different destination — should NOT arrive at WS client
    bus.emit(EventNames.TASK_CREATED, { id: 'not-for-ui' }, ['agent'], { source: 'test' });

    // Wait a bit and verify no message arrived
    const gotMessage = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      ws.once('message', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(gotMessage).toBe(false);

    ws.close();
    await delay(50);
  });

  it('broadcast events (["*"]) ARE pushed to WS clients', async () => {
    const ws = await connectClient();
    const msgPromise = waitForMessage(ws);

    bus.emit(EventNames.SYSTEM_EVENT, { msg: 'broadcast' }, ['*'], { source: 'test' });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    if (frame.type === 'event') {
      expect(frame.name).toBe(EventNames.SYSTEM_EVENT);
    }

    ws.close();
    await delay(50);
  });
});

// ── RPC tests (client → server → response) ──

describe('RPC (client → server)', () => {
  it('client sends req frame, receives matching res frame', async () => {
    registerMethod('echo-test', async () => {});
    const ws = await connectClient();

    const frame = await sendRpc(ws, 'echo-test', { msg: 'hello' });

    expect(frame.type).toBe('res');
    if (frame.type === 'res') {
      expect(frame.ok).toBe(true);
    }

    ws.close();
    await delay(50);
  });

  it('RPC with valid method returns ok: true', async () => {
    registerMethod('valid-method', async () => {});
    const ws = await connectClient();

    const frame = await sendRpc(ws, 'valid-method', {});

    expect(frame.type).toBe('res');
    if (frame.type === 'res') {
      expect(frame.ok).toBe(true);
    }

    ws.close();
    await delay(50);
  });

  it('RPC with unknown method returns ok: false with error message', async () => {
    const ws = await connectClient();

    const frame = await sendRpc(ws, 'nonexistent-method', {});

    expect(frame.type).toBe('res');
    if (frame.type === 'res') {
      expect(frame.ok).toBe(false);
      expect(frame.error).toContain('Unknown method');
      expect(frame.error).toContain('nonexistent-method');
    }

    ws.close();
    await delay(50);
  });

  it('RPC handler that throws returns ok: false with error', async () => {
    registerMethod('throw-test', async () => {
      throw new Error('handler error');
    });
    const ws = await connectClient();

    const frame = await sendRpc(ws, 'throw-test', {});

    expect(frame.type).toBe('res');
    if (frame.type === 'res') {
      expect(frame.ok).toBe(false);
      expect(frame.error).toBe('handler error');
    }

    ws.close();
    await delay(50);
  });

  it('multiple concurrent RPC requests return correct responses (matched by id)', async () => {
    registerMethod('slow-a', async () => {
      await delay(50);
    });
    registerMethod('slow-b', async () => {
      await delay(30);
    });

    const ws = await connectClient();

    const idA = 'req-a';
    const idB = 'req-b';

    const resA = sendRpc(ws, 'slow-a', {}, idA);
    const resB = sendRpc(ws, 'slow-b', {}, idB);

    const [frameA, frameB] = await Promise.all([resA, resB]);

    expect(frameA.type).toBe('res');
    expect(frameB.type).toBe('res');
    if (frameA.type === 'res' && frameB.type === 'res') {
      expect(frameA.id).toBe(idA);
      expect(frameB.id).toBe(idB);
      expect(frameA.ok).toBe(true);
      expect(frameB.ok).toBe(true);
    }

    ws.close();
    await delay(50);
  });
});

// ── Error handling ──

describe('Error handling', () => {
  it('malformed JSON from client does not crash server', async () => {
    const ws = await connectClient();

    // Send garbage
    ws.send('not-json-at-all{{{');
    ws.send('');
    ws.send('{"broken');

    // Server should still be alive — send a valid RPC
    registerMethod('alive-check', async () => {});
    const frame = await sendRpc(ws, 'alive-check', {});
    expect(frame.type).toBe('res');
    if (frame.type === 'res') {
      expect(frame.ok).toBe(true);
    }

    ws.close();
    await delay(50);
  });

  it('server handles client disconnect mid-RPC gracefully', async () => {
    registerMethod('slow-disconnect', async () => {
      await delay(200);
    });

    const ws = await connectClient();

    // Send RPC then immediately close
    const reqId = 'disconnect-mid-rpc';
    ws.send(JSON.stringify({ type: 'req', id: reqId, method: 'slow-disconnect', payload: {} }));
    ws.close();

    // Wait for the RPC to finish — server should not crash
    await delay(300);

    // Verify server is still alive by connecting a new client
    const ws2 = await connectClient();
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws2.close();
    await delay(50);
  });

  it('non-req frame types from client are ignored', async () => {
    const ws = await connectClient();

    // Send an event frame (server → client only, should be ignored)
    ws.send(JSON.stringify({ type: 'event', name: 'fake', data: {}, seq: 1 }));

    // Send a res frame (not valid from client)
    ws.send(JSON.stringify({ type: 'res', id: 'fake', ok: true }));

    // Server should still be alive
    registerMethod('ignore-check', async () => {});
    const frame = await sendRpc(ws, 'ignore-check', {});
    if (frame.type === 'res') {
      expect(frame.ok).toBe(true);
    }

    ws.close();
    await delay(50);
  });
});
