import { z } from 'zod';
import { ContractRegistry, type Authority } from '../../../src/core/feature-nodes/contracts.js';
import { ConnectionRegistry, type ReadTransport } from '../../../src/core/feature-nodes/connections.js';
import { ReadCaller } from '../../../src/core/feature-nodes/calls.js';
import type { Clock, Frame, ReadFrame } from '../../../src/core/feature-nodes/protocol.js';

export const capability = { id: 'catalog.page', version: 1 };
export const fingerprint = 'catalog-v1';

export class FakeClock implements Clock {
  time = 100;
  nowCalls = 0;
  throwNowAt = Infinity;
  throwSet = false;
  throwClear = false;
  synchronous = false;
  private sequence = 0;
  readonly timers = new Map<number, { callback: () => void; due: number }>();
  readonly cleared: unknown[] = [];

  now(): number {
    if (++this.nowCalls >= this.throwNowAt) throw new Error('Clock failed');
    return this.time;
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    if (this.throwSet) throw new Error('Timer setup failed');
    const handle = ++this.sequence;
    this.timers.set(handle, { callback, due: this.time + milliseconds });
    if (this.synchronous) callback();
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle);
    this.timers.delete(handle as number);
    if (this.throwClear) throw new Error('Timer cleanup failed');
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.due <= this.time && this.timers.delete(handle)) timer.callback();
    }
  }
}

export class FakeTransport implements ReadTransport {
  status: 'open' | 'closing' | 'closed' = 'open';
  buffered = 0;
  closeCalls = 0;
  sendHook?: (frame: Frame) => boolean | number;
  readonly sent: Frame[] = [];
  readonly messages = new Set<(raw: unknown) => void>();
  readonly closes = new Set<() => void>();
  readonly errors = new Set<() => void>();

  state(): 'open' | 'closing' | 'closed' { return this.status; }
  bufferedBytes(): number { return this.buffered; }
  send(text: string): boolean | number {
    const frame = JSON.parse(text) as Frame;
    this.sent.push(frame);
    return this.sendHook ? this.sendHook(frame) : true;
  }
  onMessage(listener: (raw: unknown) => void): () => void {
    this.messages.add(listener);
    return () => { this.messages.delete(listener); };
  }
  onClose(listener: () => void): () => void {
    this.closes.add(listener);
    return () => { this.closes.delete(listener); };
  }
  onError(listener: () => void): () => void {
    this.errors.add(listener);
    return () => { this.errors.delete(listener); };
  }
  close(): void {
    this.closeCalls++;
    this.status = 'closed';
    for (const listener of [...this.closes]) listener();
  }
  deliver(frame: unknown): void { this.deliverRaw(JSON.stringify(frame)); }
  deliverRaw(raw: unknown): void { for (const listener of [...this.messages]) listener(raw); }
  fail(): void { for (const listener of [...this.errors]) listener(); }
  get reads(): ReadFrame[] { return this.sent.filter((frame): frame is ReadFrame => frame.type === 'read'); }
  get listenerCount(): number { return this.messages.size + this.closes.size + this.errors.size; }
}

export function authority(nodeId = 'node-a', accountId = 'account-a'): Authority {
  return { nodeId, accountId, permissionVersion: 1, grants: [{ capability: { ...capability }, fingerprint }] };
}

export function fixture() {
  const authorities = new Map<string, Authority>();
  const lookup = (nodeId: string, accountId: string) => {
    const value = authorities.get(nodeId);
    return value?.accountId === accountId ? value : undefined;
  };
  const contracts = new ContractRegistry();
  const unregister = contracts.register({
    capability, fingerprint,
    input: z.strictObject({ query: z.string() }),
    output: z.strictObject({ value: z.string() }),
  });
  const connections = new ConnectionRegistry(lookup, 'registry');
  const clock = new FakeClock();
  const callers: ReadCaller[] = [];
  const attach = (nodeId = 'node-a', transport = new FakeTransport()) => {
    if (!authorities.has(nodeId)) authorities.set(nodeId, authority(nodeId));
    const attached = connections.attach(nodeId, 'account-a', transport);
    if (!attached.success) throw new Error(`Attach failed: ${attached.code}`);
    transport.deliver({ protocolVersion: 1, type: 'manifest', capabilities: [capability] });
    return { connection: attached.payload, transport };
  };
  const caller = (options: { maxPending?: number; maxPendingBytes?: number } = {}) => {
    const instance = new ReadCaller(connections, contracts, lookup, clock, 'caller', options);
    callers.push(instance);
    return instance;
  };
  const call = (nodeId = 'node-a') => ({ nodeId, accountId: 'account-a', capability, input: { query: 'page' } });
  const cleanup = () => { for (const instance of callers) instance.close(); connections.close(); };
  return { authorities, lookup, contracts, unregister, connections, clock, attach, caller, call, cleanup };
}

export function reply(transport: FakeTransport, frame: ReadFrame, payload: unknown = { value: 'page' }): void {
  transport.deliver({ protocolVersion: 1, type: 'result', correlationId: frame.correlationId,
    generation: frame.generation, success: true, payload });
}

export function readFrame(correlationId = 'read:1', overrides: Partial<ReadFrame> = {}): ReadFrame {
  return { protocolVersion: 1, type: 'read', correlationId, generation: 'generation:1',
    nodeId: 'node-a', accountId: 'account-a', capability, fingerprint, permissionVersion: 1,
    expiresAt: 1100, input: { query: 'page' }, ...overrides };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
