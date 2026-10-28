import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { WebSocket } from '#ws';
import { z } from 'zod';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('feature-node-e2e'));

import { startServer, stopServer } from '../../src/web/server.js';
import { registerOwnedMethod, onClientDisconnect, sendToClient } from '../../src/web/ws/handler.js';
import { ContractRegistry, type Authority } from '../../src/core/feature-nodes/contracts.js';
import { ConnectionRegistry, type ReadTransport } from '../../src/core/feature-nodes/connections.js';
import { ReadCaller } from '../../src/core/feature-nodes/calls.js';
import { ReadRunner, ReadScheduler } from '../../src/core/feature-nodes/runner.js';
import type { Clock, Outcome, JsonValue } from '../../src/core/feature-nodes/protocol.js';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const page = { id: 'catalog.page', version: 1 };
const count = { id: 'catalog.count', version: 1 };
const contracts = new ContractRegistry();
contracts.register({ capability: page, fingerprint: 'page-v1',
  input: z.strictObject({ offset: z.number().int().min(0).max(200), hold: z.boolean().optional() }),
  output: z.strictObject({ items: z.array(z.strictObject({ id: z.string(), name: z.string() })).max(100), next: z.number().nullable() }),
});
contracts.register({ capability: count, fingerprint: 'count-v1',
  input: z.strictObject({}), output: z.strictObject({ count: z.number().int() }),
});
const authorities = new Map<string, Authority>([
  ['node-a', { nodeId: 'node-a', accountId: 'account-a', permissionVersion: 1,
    grants: [{ capability: page, fingerprint: 'page-v1' }] }],
  ['node-b', { nodeId: 'node-b', accountId: 'account-b', permissionVersion: 1,
    grants: [{ capability: count, fingerprint: 'count-v1' }] }],
]);
const lookup = (nodeId: string, accountId: string) => {
  const value = authorities.get(nodeId);
  return value?.accountId === accountId ? value : undefined;
};
const connections = new ConnectionRegistry(lookup, 'e2e');
const caller = new ReadCaller(connections, contracts, lookup, clock, 'e2e');
const scheduler = new ReadScheduler();
const disposers: Array<() => void | Promise<void>> = [];
const sockets = new Set<WebSocket>();
let server: Server;
let port: number;
let rpcSequence = 0;

function rpc(ws: WebSocket, method: string, payload: unknown): Promise<unknown> {
  const id = `rpc-${++rpcSequence}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('close', closed); };
    const message = (raw: unknown) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'res' || frame.id !== id) return;
      cleanup();
      if (frame.ok) resolve(frame.payload); else reject(new Error('Synthetic RPC failed'));
    };
    const closed = () => { cleanup(); reject(new Error('Synthetic socket closed')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Synthetic RPC deadline')); }, 5000);
    ws.on('message', message);
    ws.on('close', closed);
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}

class ServerTransport implements ReadTransport {
  readonly messages = new Set<(raw: unknown) => void>();
  readonly closes = new Set<() => void>();
  constructor(readonly ws: WebSocket) {}
  state() { return this.ws.readyState === WebSocket.OPEN ? 'open' as const : 'closed' as const; }
  bufferedBytes() { return this.ws.bufferedAmount; }
  send(text: string) { sendToClient(this.ws, 'synthetic:feature', text); return true; }
  onMessage(listener: (raw: unknown) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  onError(listener: () => void) { this.ws.on('error', listener); return () => { this.ws.off('error', listener); }; }
  close() { this.ws.close(); }
  deliver(text: string) { for (const listener of this.messages) listener(text); }
  disconnected() { for (const listener of [...this.closes]) listener(); }
}

const transports = new Map<WebSocket, ServerTransport>();
beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server address missing');
  port = address.port;
  disposers.push(onClientDisconnect((ws) => {
    transports.get(ws)?.disconnected(); transports.delete(ws);
  }).dispose);
  disposers.push(registerOwnedMethod('feature-test', 'synthetic:attach', (payload, ws) => {
    const nodeId = z.enum(['node-a', 'node-b']).parse(payload);
    const authority = authorities.get(nodeId)!;
    const transport = new ServerTransport(ws);
    const result = connections.attach(nodeId, authority.accountId, transport);
    if (result.success) transports.set(ws, transport);
    return result;
  }).dispose);
  disposers.push(registerOwnedMethod('feature-test', 'synthetic:frame', (payload, ws) => {
    const text = z.string().max(64 * 1024).parse(payload);
    const transport = transports.get(ws);
    if (!transport) throw new Error('Synthetic node missing');
    transport.deliver(text);
    return null;
  }).dispose);
  disposers.push(registerOwnedMethod('feature-test', 'synthetic:read', (payload) => caller.read(
    z.strictObject({ nodeId: z.string(), accountId: z.string(), capability: z.strictObject({ id: z.string(), version: z.number() }),
      input: z.unknown(), timeoutMs: z.number().optional() }).parse(payload),
  )).dispose);
});
afterAll(async () => {
  caller.close(); connections.close();
  for (const dispose of disposers.reverse()) await dispose();
  for (const socket of sockets) socket.close();
  await stopServer();
});

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.add(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Synthetic connect deadline')); }, 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', () => { clearTimeout(timer); reject(new Error('Synthetic connect failed')); });
  });
  return ws;
}

async function node(nodeId: string, handler: (input: JsonValue) => unknown | Promise<unknown>) {
  const ws = await connect();
  const attached = await rpc(ws, 'synthetic:attach', nodeId) as Outcome<{ generation: string }>;
  if (!attached.success) throw new Error('Synthetic attach refused');
  const messageListeners = new Set<(raw: unknown) => void>();
  const transport: ReadTransport = {
    state: () => ws.readyState === WebSocket.OPEN ? 'open' : 'closed',
    bufferedBytes: () => ws.bufferedAmount,
    send: (text) => { void rpc(ws, 'synthetic:frame', text).catch(() => runner.close()); return true; },
    onMessage: (listener) => { messageListeners.add(listener); return () => { messageListeners.delete(listener); }; },
    onClose: (listener) => { ws.on('close', listener); return () => { ws.off('close', listener); }; },
    onError: (listener) => { ws.on('error', listener); return () => { ws.off('error', listener); }; },
    close: () => ws.close(),
  };
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'event' && frame.name === 'synthetic:feature') {
      for (const listener of messageListeners) listener(frame.data);
    }
  });
  const authority = authorities.get(nodeId)!;
  const capability = nodeId === 'node-a' ? page : count;
  const runner = new ReadRunner(nodeId, authority.accountId, attached.payload.generation,
    transport, contracts, lookup, clock, scheduler, [{ capability, handle: handler }]);
  expect(runner.start()).toBe(true);
  // Await a real RPC acknowledgement after the manifest on the same socket.
  await rpc(ws, 'synthetic:frame', JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [capability] }));
  return { ws, runner };
}

async function read(ws: WebSocket, nodeId: string, capability = page, input: unknown = { offset: 0 }, timeoutMs?: number) {
  return rpc(ws, 'synthetic:read', { nodeId, accountId: nodeId === 'node-a' ? 'account-a' : 'account-b',
    capability, input, ...(timeoutMs === undefined ? {} : { timeoutMs }) }) as Promise<Outcome>;
}

describe('feature nodes over the isolated server websocket', () => {
  it('reads dense pages and a second contract, then recovers after timeout, revoke and reconnect', async () => {
    const client = await connect();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    const catalog = Array.from({ length: 205 }, (_, i) => ({ id: `item-${i}`, name: `Name ${i} \u754c\u{1f680}` }));
    const handle = async (input: JsonValue) => {
      const args = input as { offset: number; hold?: boolean };
      if (args.hold) { started(); await held; }
      const items = catalog.slice(args.offset, args.offset + 100);
      return { items, next: args.offset + items.length < catalog.length ? args.offset + items.length : null };
    };
    const first = await node('node-a', handle);
    const second = await node('node-b', () => ({ count: catalog.length }));
    try {
      const ids: string[] = [];
      for (const offset of [0, 100, 200]) {
        const result = await read(client, 'node-a', page, { offset });
        expect(result.success).toBe(true);
        if (result.success) ids.push(...(result.payload as { items: Array<{ id: string }> }).items.map((item) => item.id));
      }
      expect(ids).toEqual(catalog.map((item) => item.id));
      expect(await read(client, 'node-b', count, {})).toEqual({ success: true, payload: { count: 205 } });
      expect(await read(client, 'node-b', page)).toEqual({ success: false, code: 'unavailable' });
      const timed = read(client, 'node-a', page, { offset: 0, hold: true }, 500);
      await handlerStarted;
      expect(await timed).toEqual({ success: false, code: 'expired' });
      expect(scheduler.activeCount('node-a')).toBe(1);
      release(); await held;
      expect(await read(client, 'node-a', page, { offset: 200 })).toMatchObject({ success: true });
      authorities.set('node-a', { ...authorities.get('node-a')!, permissionVersion: 2 });
      expect(await read(client, 'node-a')).toEqual({ success: false, code: 'denied' });
      first.runner.close();
      const replacement = await node('node-a', handle);
      try {
        expect(await read(client, 'node-a', page, { offset: 200 })).toMatchObject({ success: true });
        expect(caller.pendingCount).toBe(0);
        expect(caller.pendingBytes).toBe(0);
      } finally { replacement.runner.close(); }
    } finally {
      release(); first.runner.close(); second.runner.close(); client.close();
    }
  });
});
