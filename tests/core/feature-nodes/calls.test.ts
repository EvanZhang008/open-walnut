import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../../../src/core/feature-nodes/connections.js';
import { z } from 'zod';
import { ReadCaller } from '../../../src/core/feature-nodes/calls.js';
import { fixture, reply, FakeTransport, capability, fingerprint } from './fakes.js';

async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try { await run(f); } finally { f.cleanup(); }
}

describe('feature node caller', () => {
  it('validates inputs, output and account without leaving resources', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    const caller = f.caller();
    expect(await caller.read({ ...f.call(), accountId: 'other' })).toEqual({ success: false, code: 'denied' });
    expect(await caller.read({ ...f.call(), input: { query: 3 } })).toEqual({ success: false, code: 'invalid_input' });
    const pending = caller.read(f.call());
    reply(transport, transport.reads[0], { value: 3 });
    expect(await pending).toEqual({ success: false, code: 'invalid_output' });
    const next = caller.read(f.call());
    reply(transport, transport.reads[1]);
    expect(await next).toEqual({ success: true, payload: { value: 'page' } });
    expect(caller.pendingCount).toBe(0);
    expect(caller.pendingBytes).toBe(0);
    expect(f.clock.timers.size).toBe(0);
  }));

  it('shares the four read limit and unique correlation ids across same named callers', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    const callers = Array.from({ length: 5 }, () => f.caller());
    const pending = callers.slice(0, 4).map((caller) => caller.read(f.call()));
    expect(new Set(transport.reads.map((frame) => frame.correlationId)).size).toBe(4);
    expect(await callers[4].read(f.call())).toEqual({ success: false, code: 'busy' });
    reply(transport, transport.reads[0]);
    expect((await pending[0]).success).toBe(true);
    const replacement = callers[4].read(f.call());
    reply(transport, transport.reads[4]);
    expect((await replacement).success).toBe(true);
    for (const caller of callers) caller.close();
    expect(await Promise.all(pending.slice(1))).toEqual(Array(3).fill({ success: false, code: 'cancelled' }));
    expect(f.clock.timers.size).toBe(0);
  }));

  it('shares global count across nodes and tightens a caller local limit', async () => withFixture(async (f) => {
    const first = f.caller({ maxPending: 1 });
    f.attach();
    const one = first.read(f.call());
    expect(await first.read(f.call())).toEqual({ success: false, code: 'busy' });
    first.close();
    expect(await one).toEqual({ success: false, code: 'cancelled' });
    const callers = Array.from({ length: 17 }, () => f.caller());
    const pending = [];
    for (let i = 0; i < 16; i++) {
      f.attach(`node-${i}`);
      for (let j = 0; j < 4; j++) pending.push(callers[i].read(f.call(`node-${i}`)));
    }
    f.attach('node-last');
    expect(await callers[16].read(f.call('node-last'))).toEqual({ success: false, code: 'busy' });
    for (const caller of callers) caller.close();
    expect(await Promise.all(pending)).toEqual(Array(64).fill({ success: false, code: 'cancelled' }));
  }));

  it('shares the byte budget across callers on different nodes', async () => withFixture(async (f) => {
    const pending = [];
    for (let i = 0; i < 17; i++) {
      f.attach(`node-${i}`);
      pending.push(f.caller().read({ ...f.call(`node-${i}`), input: { query: 'x'.repeat(62_000) } }));
    }
    f.attach('node-extra');
    expect(await f.caller().read({ ...f.call('node-extra'), input: { query: 'x'.repeat(62_000) } }))
      .toEqual({ success: false, code: 'busy' });
    f.cleanup();
    expect((await Promise.all(pending)).every((result) => !result.success)).toBe(true);
  }));

  it('keeps the first validated synchronous reply even when send returns false', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    transport.sendHook = (frame) => {
      if (frame.type === 'read') reply(transport, frame);
      return false;
    };
    const caller = f.caller();
    expect(await caller.read(f.call())).toEqual({ success: true, payload: { value: 'page' } });
    expect(caller.pendingCount).toBe(0);
    expect(f.connections.size).toBe(0);
  }));

  it('ignores old generations and ends old pending reads on replacement', async () => withFixture(async (f) => {
    const old = f.attach();
    const caller = f.caller();
    const pending = caller.read(f.call());
    const next = f.attach();
    expect(await pending).toEqual({ success: false, code: 'offline' });
    const replacement = caller.read(f.call());
    reply(next.transport, { ...next.transport.reads[0], generation: old.connection.generation });
    expect(caller.pendingCount).toBe(1);
    reply(next.transport, next.transport.reads[0]);
    expect((await replacement).success).toBe(true);
    const reconstructed = new ConnectionRegistry(f.lookup, 'registry');
    const result = reconstructed.attach('node-a', 'account-a', new FakeTransport());
    expect(result.success).toBe(true);
    if (result.success) expect(result.payload.generation).not.toBe(old.connection.generation);
    reconstructed.close();
  }));

  it.each(['permission', 'contract'])('rejects a result after %s revocation', async (change) => withFixture(async (f) => {
    const { transport } = f.attach();
    const caller = f.caller();
    const pending = caller.read(f.call());
    if (change === 'permission') f.authorities.set('node-a', { ...f.authorities.get('node-a')!, permissionVersion: 2 });
    else f.unregister();
    reply(transport, transport.reads[0]);
    expect(await pending).toEqual({ success: false, code: 'denied' });
    expect(caller.pendingBytes).toBe(0);
  }));

  it('cancels and times out with cleanup, then reads again', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    const caller = f.caller();
    const controller = new AbortController();
    const cancelled = caller.read({ ...f.call(), signal: controller.signal });
    controller.abort();
    expect(await cancelled).toEqual({ success: false, code: 'cancelled' });
    const expired = caller.read({ ...f.call(), timeoutMs: 100 });
    f.clock.advance(100);
    expect(await expired).toEqual({ success: false, code: 'expired' });
    const next = caller.read(f.call());
    reply(transport, transport.reads[2]);
    expect((await next).success).toBe(true);
    expect(transport.sent.filter((frame) => frame.type === 'cancel')).toHaveLength(2);
    expect(f.clock.timers.size).toBe(0);
  }));

  it.each(['now', 'set', 'clear', 'synchronous'])('cleans up with %s clock faults', async (fault) => withFixture(async (f) => {
    const { transport } = f.attach();
    const caller = f.caller();
    if (fault === 'now') f.clock.throwNowAt = 2;
    if (fault === 'set') f.clock.throwSet = true;
    if (fault === 'clear') f.clock.throwClear = true;
    if (fault === 'synchronous') f.clock.synchronous = true;
    const pending = caller.read(f.call());
    if (fault === 'clear') reply(transport, transport.reads[0]);
    expect(await pending).toEqual(fault === 'clear'
      ? { success: true, payload: { value: 'page' } }
      : { success: false, code: fault === 'synchronous' ? 'expired' : 'internal' });
    expect(caller.pendingCount).toBe(0);
    expect(caller.pendingBytes).toBe(0);
    expect(f.clock.timers.size).toBe(0);
    f.clock.throwNowAt = Infinity; f.clock.throwSet = false; f.clock.throwClear = false; f.clock.synchronous = false;
    const next = caller.read(f.call());
    reply(transport, transport.reads.at(-1)!);
    expect((await next).success).toBe(true);
  }));

  it('rechecks permission after injected timer setup before sending input', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    const original = f.clock.setTimeout.bind(f.clock);
    f.clock.setTimeout = (callback, ms) => {
      f.authorities.set('node-a', { ...f.authorities.get('node-a')!, permissionVersion: 2 });
      return original(callback, ms);
    };
    const caller = f.caller();
    expect(await caller.read(f.call())).toEqual({ success: false, code: 'denied' });
    expect(transport.reads).toHaveLength(0);
    expect(caller.pendingCount).toBe(0);
    expect(f.clock.timers.size).toBe(0);
  }));

  it('rechecks tightened local limits after reentrant authority lookup', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    let count = 0;
    let nested: Promise<unknown> | undefined;
    const lookup = (nodeId: string, accountId: string) => {
      if (++count === 2) nested = caller.read(f.call());
      return f.lookup(nodeId, accountId);
    };
    const caller = new ReadCaller(f.connections, f.contracts, lookup, f.clock, 'reentrant', { maxPending: 1 });
    try {
      expect(await caller.read(f.call())).toEqual({ success: false, code: 'busy' });
      expect(caller.pendingCount).toBe(1);
      reply(transport, transport.reads[0]);
      expect(await nested).toEqual({ success: true, payload: { value: 'page' } });
    } finally { caller.close(); }
  }));

  it('rejects output when validation crosses the deadline', async () => withFixture(async (f) => {
    f.unregister();
    f.contracts.register({ capability, fingerprint, input: z.strictObject({ query: z.string() }),
      output: z.strictObject({ value: z.string() }).transform((value) => { f.clock.time += 1000; return value; }) });
    const { transport } = f.attach();
    const caller = f.caller();
    const pending = caller.read({ ...f.call(), timeoutMs: 100 });
    reply(transport, transport.reads[0]);
    expect(await pending).toEqual({ success: false, code: 'expired' });
    expect(caller.pendingCount).toBe(0);
  }));

  it('rejects malformed frames and closing or backpressured connections', async () => withFixture(async (f) => {
    const { transport } = f.attach();
    const caller = f.caller();
    const pending = caller.read(f.call());
    transport.deliverRaw('{');
    expect(await pending).toEqual({ success: false, code: 'malformed' });
    const closing = new FakeTransport(); closing.status = 'closing';
    expect(f.connections.attach('node-a', 'account-a', closing)).toEqual({ success: false, code: 'offline' });
    const blocked = new FakeTransport(); blocked.buffered = 1;
    expect(f.connections.attach('node-a', 'account-a', blocked)).toEqual({ success: false, code: 'offline' });
    expect(f.connections.listenerCount).toBe(1);
    caller.close();
    expect(f.connections.listenerCount).toBe(0);
    expect(transport.listenerCount).toBe(0);
  }));
});
