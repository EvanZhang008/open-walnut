import { describe, expect, it, vi } from 'vitest';
import { ReadRunner, ReadScheduler, type HandlerContext } from '../../../src/core/feature-nodes/runner.js';
import { z } from 'zod';
import { FakeClock, FakeTransport, fixture, capability, fingerprint, readFrame, deferred, flush } from './fakes.js';

function setup(handle: (input: unknown, context: HandlerContext) => unknown = () => ({ value: 'page' }),
  scheduler = new ReadScheduler(), generation = 'generation:1') {
  const f = fixture(); f.attach();
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const handler = vi.fn(handle);
  const runner = new ReadRunner('node-a', 'account-a', generation, transport,
    f.contracts, f.lookup, clock, scheduler, [{ capability, handle: handler }]);
  const cleanup = () => { runner.close(); f.cleanup(); };
  return { ...f, transport, clock, handler, runner, scheduler, cleanup };
}

describe('feature node runner', () => {
  it('returns validated results and keeps the next read working', async () => {
    const f = setup();
    try {
      expect(f.runner.start()).toBe(true);
      for (const id of ['read:1', 'read:2']) { f.transport.deliver(readFrame(id)); await flush(); }
      expect(f.handler).toHaveBeenCalledTimes(2);
      expect(f.transport.sent.filter((frame) => frame.type === 'result')).toEqual(
        ['read:1', 'read:2'].map((correlationId) => ({ protocolVersion: 1, type: 'result', correlationId,
          generation: 'generation:1', success: true, payload: { value: 'page' } })),
      );
      expect(f.runner.activeCount).toBe(0);
      expect(f.scheduler.activeCount('node-a')).toBe(0);
      expect(f.clock.timers.size).toBe(0);
    } finally { f.cleanup(); }
    expect(f.transport.listenerCount).toBe(0);
  });

  it.each([
    [{ accountId: 'account-b' }, 'denied'],
    [{ nodeId: 'node-b' }, 'denied'],
    [{ fingerprint: 'other' }, 'denied'],
    [{ permissionVersion: 2 }, 'denied'],
    [{ capability: { id: 'unknown', version: 1 } }, 'unavailable'],
    [{ expiresAt: 100 }, 'expired'],
    [{ expiresAt: 20000 }, 'expired'],
    [{ input: { query: 3 } }, 'invalid_input'],
  ] as const)('refuses a changed binding %# without starting a handler', async (overrides, code) => {
    const f = setup();
    try {
      f.runner.start(); f.transport.deliver(readFrame('read:1', overrides)); await flush();
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.transport.sent.at(-1)).toMatchObject({ success: false, code });
      expect(f.scheduler.activeCount('node-a')).toBe(0);
    } finally { f.cleanup(); }
  });

  it.each(['invalid', 'throw', 'revoked', 'unregistered'])('rejects %s output after execution and releases permit', async (kind) => {
    const held = deferred<unknown>();
    const f = setup(() => held.promise);
    try {
      f.runner.start(); f.transport.deliver(readFrame());
      if (kind === 'revoked') f.authorities.set('node-a', { ...f.authorities.get('node-a')!, permissionVersion: 2 });
      if (kind === 'unregistered') f.unregister();
      if (kind === 'throw') held.reject(new Error('Synthetic private exception'));
      else held.resolve(kind === 'invalid' ? { value: 3 } : { value: 'page' });
      await flush();
      expect(f.transport.sent.at(-1)).toMatchObject({ success: false,
        code: kind === 'throw' ? 'internal' : kind === 'invalid' ? 'invalid_output' : 'denied' });
      expect(JSON.stringify(f.transport.sent)).not.toContain('Synthetic private exception');
      expect(f.scheduler.activeCount('node-a')).toBe(0);
    } finally { held.resolve({ value: 'page' }); f.cleanup(); }
  });

  it.each(['timeout', 'cancel', 'disconnect'])('holds ignored %s permits across reconnect until the handler settles', async (reason) => {
    const scheduler = new ReadScheduler();
    const held = Array.from({ length: 4 }, () => deferred<unknown>());
    let index = 0;
    const signals: AbortSignal[] = [];
    const f = setup((_input, context) => { signals.push(context.signal); return held[index++].promise; }, scheduler);
    const next = setup(() => ({ value: 'next' }), scheduler, 'generation:2');
    try {
      f.runner.start();
      for (let i = 0; i < 4; i++) f.transport.deliver(readFrame(`read:${i}`));
      if (reason === 'timeout') f.clock.advance(1000);
      else if (reason === 'disconnect') f.transport.close();
      else for (let i = 0; i < 4; i++) f.transport.deliver({ protocolVersion: 1, type: 'cancel',
        generation: 'generation:1', correlationId: `read:${i}` });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(scheduler.activeCount('node-a')).toBe(4);
      next.runner.start();
      next.transport.deliver(readFrame('next:1', { generation: 'generation:2' }));
      expect(next.handler).not.toHaveBeenCalled();
      expect(next.transport.sent.at(-1)).toMatchObject({ success: false, code: 'busy' });
      held[0].resolve({ value: 'late' }); await flush();
      expect(scheduler.activeCount('node-a')).toBe(3);
      next.transport.deliver(readFrame('next:2', { generation: 'generation:2' })); await flush();
      expect(next.handler).toHaveBeenCalledTimes(1);
      expect(next.transport.sent.at(-1)).toMatchObject({ success: true, payload: { value: 'next' } });
    } finally {
      held.forEach((item) => item.resolve({ value: 'late' })); await flush(); f.cleanup(); next.cleanup();
    }
    expect(scheduler.activeCount('node-a')).toBe(0);
  });

  it.each(['set', 'now', 'clear', 'sync'])('cleans up %s timer faults without orphaned execution', async (fault) => {
    const f = setup();
    try {
      f.runner.start();
      if (fault === 'set') f.clock.throwSet = true;
      if (fault === 'now') f.clock.throwNowAt = 3;
      if (fault === 'clear') f.clock.throwClear = true;
      if (fault === 'sync') f.clock.synchronous = true;
      f.transport.deliver(readFrame()); await flush();
      expect(f.scheduler.activeCount('node-a')).toBe(0);
      expect(f.runner.activeCount).toBe(0);
      expect(f.clock.timers.size).toBe(0);
      if (fault !== 'clear') expect(f.handler).not.toHaveBeenCalled();
      expect(f.transport.sent.at(-1)).toMatchObject({ success: fault === 'clear' });
      f.clock.throwSet = false; f.clock.throwNowAt = Infinity; f.clock.throwClear = false; f.clock.synchronous = false;
      f.transport.deliver(readFrame('read:2')); await flush();
      expect(f.transport.sent.at(-1)).toMatchObject({ success: true });
    } finally { f.cleanup(); }
  });

  it('does not overwrite a reentrantly installed duplicate execution', async () => {
    const f = fixture(); f.attach();
    const transport = new FakeTransport(); const clock = new FakeClock(); const scheduler = new ReadScheduler();
    const held = deferred<unknown>(); let reentered = false;
    f.unregister();
    f.contracts.register({ capability, fingerprint,
      input: z.strictObject({ query: z.string() }).transform((value) => {
        if (!reentered) { reentered = true; transport.deliver(readFrame()); }
        return value;
      }), output: z.strictObject({ value: z.string() }) });
    const handler = vi.fn(() => held.promise);
    const runner = new ReadRunner('node-a', 'account-a', 'generation:1', transport, f.contracts,
      f.lookup, clock, scheduler, [{ capability, handle: handler }]);
    try {
      runner.start(); transport.deliver(readFrame());
      expect(handler).toHaveBeenCalledTimes(1);
      expect(transport.status).toBe('closed');
      expect(scheduler.activeCount('node-a')).toBe(1);
      held.resolve({ value: 'late' }); await flush();
      expect(scheduler.activeCount('node-a')).toBe(0);
      expect(transport.sent.filter((frame) => frame.type === 'result' && frame.success)).toHaveLength(0);
    } finally { held.resolve({ value: 'late' }); runner.close(); f.cleanup(); }
  });

  it('rejects output validation that crosses the deadline', async () => {
    const f = fixture(); f.attach(); const transport = new FakeTransport(); const clock = new FakeClock();
    const scheduler = new ReadScheduler(); f.unregister();
    f.contracts.register({ capability, fingerprint, input: z.strictObject({ query: z.string() }),
      output: z.strictObject({ value: z.string() }).transform((value) => { clock.time = 1100; return value; }) });
    const runner = new ReadRunner('node-a', 'account-a', 'generation:1', transport, f.contracts,
      f.lookup, clock, scheduler, [{ capability, handle: () => ({ value: 'page' }) }]);
    try {
      runner.start(); transport.deliver(readFrame()); await flush();
      expect(transport.sent.at(-1)).toMatchObject({ success: false, code: 'expired' });
      expect(scheduler.activeCount('node-a')).toBe(0);
    } finally { runner.close(); f.cleanup(); }
  });

  it('does not start a handler after reentrant close in the last authority check', async () => {
    const f = fixture(); f.attach(); const transport = new FakeTransport(); const clock = new FakeClock();
    const scheduler = new ReadScheduler(); let lookups = 0;
    const lookup = (nodeId: string, accountId: string) => {
      if (++lookups === 4) runner.close();
      return f.lookup(nodeId, accountId);
    };
    const handler = vi.fn(() => new Promise(() => {}));
    const runner = new ReadRunner('node-a', 'account-a', 'generation:1', transport, f.contracts,
      lookup, clock, scheduler, [{ capability, handle: handler }]);
    try {
      runner.start(); transport.deliver(readFrame()); await flush();
      expect(handler).not.toHaveBeenCalled();
      expect(runner.activeCount).toBe(0);
      expect(scheduler.activeCount('node-a')).toBe(0);
      expect(clock.timers.size).toBe(0);
    } finally { runner.close(); f.cleanup(); }
  });

  it('ignores stale generation and closes on duplicate ids or malformed frames', async () => {
    const held = deferred<unknown>();
    const f = setup(() => held.promise);
    try {
      f.runner.start();
      f.transport.deliver(readFrame('old:1', { generation: 'old' }));
      expect(f.handler).not.toHaveBeenCalled();
      f.transport.deliver(readFrame());
      f.transport.deliver(readFrame());
      expect(f.transport.status).toBe('closed');
      expect(f.runner.listenerCount).toBe(0);
      expect(f.scheduler.activeCount('node-a')).toBe(1);
      held.resolve({ value: 'late' }); await flush();
      expect(f.scheduler.activeCount('node-a')).toBe(0);
    } finally { held.resolve({ value: 'late' }); f.cleanup(); }
    const malformed = setup();
    try {
      malformed.runner.start(); malformed.transport.deliverRaw('{');
      expect(malformed.transport.status).toBe('closed');
      expect(malformed.handler).not.toHaveBeenCalled();
    } finally { malformed.cleanup(); }
  });
});
