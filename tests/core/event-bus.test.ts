import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EventBus, CoalescingQueue, bus, EventNames, type BusEvent,
  busRecoveryKey, setBusRecoveryPublisher, _resetBusRecoveryForTest, _failedBusPairsForTest,
} from '../../src/core/event-bus.js';

// ── Helper ──

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    name: EventNames.TASK_CREATED,
    data: { id: 'test-1234' },
    destinations: ['*'],
    urgency: 'normal',
    timestamp: Date.now(),
    source: 'test',
    ...overrides,
  };
}

// ── EventBus ──

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('subscribe and receive events — basic emit/subscribe flow', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('ui', (e) => received.push(e));

    eventBus.emit(EventNames.TASK_CREATED, { id: '1' }, ['ui']);

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe(EventNames.TASK_CREATED);
    expect(received[0].data).toEqual({ id: '1' });
  });

  it('named subscriber routing — event only goes to subscribers in destinations', () => {
    const uiReceived: BusEvent[] = [];
    const agentReceived: BusEvent[] = [];

    eventBus.subscribe('ui', (e) => uiReceived.push(e));
    eventBus.subscribe('agent', (e) => agentReceived.push(e));

    eventBus.emit(EventNames.TASK_CREATED, { id: '1' }, ['ui']);

    expect(uiReceived).toHaveLength(1);
    expect(agentReceived).toHaveLength(0);
  });

  it('wildcard ["*"] destination broadcasts to all subscribers', () => {
    const uiReceived: BusEvent[] = [];
    const agentReceived: BusEvent[] = [];
    const loggerReceived: BusEvent[] = [];

    eventBus.subscribe('ui', (e) => uiReceived.push(e));
    eventBus.subscribe('agent', (e) => agentReceived.push(e));
    eventBus.subscribe('logger', (e) => loggerReceived.push(e));

    eventBus.emit(EventNames.SYSTEM_EVENT, { msg: 'hello' }, ['*']);

    expect(uiReceived).toHaveLength(1);
    expect(agentReceived).toHaveLength(1);
    expect(loggerReceived).toHaveLength(1);
  });

  it('unsubscribe removes subscriber — no more events received', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('ui', (e) => received.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['ui']);
    expect(received).toHaveLength(1);

    eventBus.unsubscribe('ui');

    eventBus.emit(EventNames.TASK_CREATED, {}, ['ui']);
    expect(received).toHaveLength(1);
  });

  it('error isolation — one subscriber throwing does not prevent others from receiving', () => {
    const received: BusEvent[] = [];

    eventBus.subscribe('broken', () => {
      throw new Error('handler exploded');
    });
    eventBus.subscribe('healthy', (e) => received.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['*']);

    expect(received).toHaveLength(1);
  });

  it('error isolation — async handler rejection does not affect others', async () => {
    const received: BusEvent[] = [];

    eventBus.subscribe('broken-async', () => Promise.reject(new Error('async boom')));
    eventBus.subscribe('healthy', (e) => received.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['*']);

    expect(received).toHaveLength(1);
  });

  it('filter function — subscriber with filter only receives matching events', () => {
    const received: BusEvent[] = [];

    eventBus.subscribe(
      'filtered',
      (e) => received.push(e),
      (e) => e.name === EventNames.TASK_COMPLETED,
    );

    eventBus.emit(EventNames.TASK_CREATED, {}, ['filtered']);
    eventBus.emit(EventNames.TASK_COMPLETED, {}, ['filtered']);
    eventBus.emit(EventNames.TASK_UPDATED, {}, ['filtered']);

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe(EventNames.TASK_COMPLETED);
  });

  it('multiple subscribers — same event delivered to multiple matching subscribers', () => {
    const sub1: BusEvent[] = [];
    const sub2: BusEvent[] = [];
    const sub3: BusEvent[] = [];

    eventBus.subscribe('sub1', (e) => sub1.push(e));
    eventBus.subscribe('sub2', (e) => sub2.push(e));
    eventBus.subscribe('sub3', (e) => sub3.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['sub1', 'sub2', 'sub3']);

    expect(sub1).toHaveLength(1);
    expect(sub2).toHaveLength(1);
    expect(sub3).toHaveLength(1);
  });

  it('no matching subscribers — emit does not throw', () => {
    expect(() => {
      eventBus.emit(EventNames.TASK_CREATED, {}, ['nonexistent']);
    }).not.toThrow();
  });

  it('event properties — timestamp, source are set correctly', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('ui', (e) => received.push(e));

    const before = Date.now();
    eventBus.emit(EventNames.TASK_CREATED, { id: '1' }, ['ui'], {
      source: 'api',
      urgency: 'urgent',
    });
    const after = Date.now();

    const event = received[0];
    expect(event.source).toBe('api');
    expect(event.urgency).toBe('urgent');
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
    expect(event.destinations).toEqual(['ui']);
  });

  it('event defaults — urgency defaults to normal, source defaults to unknown', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('ui', (e) => received.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['ui']);

    expect(received[0].urgency).toBe('normal');
    expect(received[0].source).toBe('unknown');
  });

  it('has() returns true for registered subscriber and false otherwise', () => {
    expect(eventBus.has('ui')).toBe(false);

    eventBus.subscribe('ui', () => {});

    expect(eventBus.has('ui')).toBe(true);

    eventBus.unsubscribe('ui');

    expect(eventBus.has('ui')).toBe(false);
  });

  it('clear() removes all subscribers', () => {
    eventBus.subscribe('a', () => {});
    eventBus.subscribe('b', () => {});
    eventBus.subscribe('c', () => {});

    expect(eventBus.has('a')).toBe(true);
    expect(eventBus.has('b')).toBe(true);
    expect(eventBus.has('c')).toBe(true);

    eventBus.clear();

    expect(eventBus.has('a')).toBe(false);
    expect(eventBus.has('b')).toBe(false);
    expect(eventBus.has('c')).toBe(false);
  });

  it('subscribe overwrites previous handler for the same name', () => {
    const first: BusEvent[] = [];
    const second: BusEvent[] = [];

    eventBus.subscribe('ui', (e) => first.push(e));
    eventBus.subscribe('ui', (e) => second.push(e));

    eventBus.emit(EventNames.TASK_CREATED, {}, ['ui']);

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  // ── interest-set: skip global subscribers on irrelevant high-frequency events ──

  it('interest — global subscriber only receives events whose name matches a prefix', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('narrow', (e) => received.push(e), {
      global: true,
      interest: ['task:'],
    });

    eventBus.emit(EventNames.SESSION_TEXT_DELTA, {}, ['main-ai']); // skipped (no match)
    eventBus.emit(EventNames.TASK_CREATED, {}, ['main-ai']);       // delivered (prefix match)
    eventBus.emit(EventNames.TASK_COMPLETED, {}, ['main-ai']);     // delivered

    expect(received.map(e => e.name)).toEqual([
      EventNames.TASK_CREATED,
      EventNames.TASK_COMPLETED,
    ]);
  });

  it('interest — exact event-name prefix matches only that event', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('exact', (e) => received.push(e), {
      global: true,
      interest: ['task:completed'],
    });

    eventBus.emit(EventNames.TASK_CREATED, {}, ['*']);
    eventBus.emit(EventNames.TASK_COMPLETED, {}, ['*']);

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe(EventNames.TASK_COMPLETED);
  });

  it('interest — global subscriber WITHOUT interest still receives everything', () => {
    const received: BusEvent[] = [];
    eventBus.subscribe('catch-all', (e) => received.push(e), { global: true });

    eventBus.emit(EventNames.SESSION_TEXT_DELTA, {}, ['someone-else']);
    eventBus.emit(EventNames.TASK_CREATED, {}, ['someone-else']);

    expect(received).toHaveLength(2);
  });

  it('interest — startsWith is a substring match, so a partial prefix matches longer names', () => {
    // Documents the contract: 'session:status' (no full event name) matches
    // 'session:status-changed' because startsWith is prefix/substring, not segment-aware.
    // Callers must pick prefixes deliberately (use full event names for exact matches).
    const received: BusEvent[] = [];
    eventBus.subscribe('partial', (e) => received.push(e), {
      global: true,
      interest: ['session:status'],
    });

    eventBus.emit(EventNames.SESSION_STATUS_CHANGED, {}, ['*']);
    eventBus.emit(EventNames.SESSION_STARTED, {}, ['*']); // does NOT start with 'session:status'

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe(EventNames.SESSION_STATUS_CHANGED);
  });

  it('interest — high-frequency streaming event skips a narrow global subscriber (handler never invoked)', () => {
    let invoked = 0;
    eventBus.subscribe('streaming-irrelevant', () => { invoked++; }, {
      global: true,
      interest: ['audio:'],
    });

    // Simulate a burst of streaming deltas — none should wake this subscriber.
    for (let i = 0; i < 100; i++) {
      eventBus.emit(EventNames.SESSION_TEXT_DELTA, { i }, ['main-ai']);
    }

    expect(invoked).toBe(0);
  });
});

// ── Subscriber-failure recovery ──
//
// A throwing subscriber logs at error level, which lands a card in the
// notification center — and that card described a CONDITION ("main-ai chokes on
// session:result") that is gone the moment the same pair dispatches cleanly. The
// live feed had a `subscriber "main-ai" threw` card long after its cause was
// fixed, because nothing ever retired it.
//
// The hard constraint: emit() is the hottest path in the app (tens of thousands of
// streaming deltas per session), so a healthy dispatch must cost nothing.

describe('bus subscriber-failure recovery', () => {
  let eventBus: EventBus;
  let signals: string[][];

  beforeEach(() => {
    eventBus = new EventBus();
    signals = [];
    _resetBusRecoveryForTest();
    setBusRecoveryPublisher((keys) => { signals.push(keys); });
  });

  afterEach(() => {
    setBusRecoveryPublisher(null);
  });

  it('busRecoveryKey names the (subscriber, event) pair', () => {
    expect(busRecoveryKey('main-ai', 'session:result')).toBe('bus:main-ai:session:result');
  });

  it('a SYNC throw is remembered, and the next clean dispatch recovers it', () => {
    let boom = true;
    eventBus.subscribe('main-ai', () => { if (boom) throw new Error('handler bug'); });

    eventBus.emit(EventNames.SESSION_RESULT, { x: 1 }, ['main-ai']);
    expect(_failedBusPairsForTest()).toEqual(['bus:main-ai:session:result']);
    expect(signals).toEqual([]);

    boom = false;
    eventBus.emit(EventNames.SESSION_RESULT, { x: 2 }, ['main-ai']);
    expect(signals).toEqual([['bus:main-ai:session:result']]);
    // Map cleaned: the pair is healthy, so there is nothing left to remember.
    expect(_failedBusPairsForTest()).toEqual([]);
  });

  it('recovers ONCE, not on every subsequent healthy dispatch', () => {
    let boom = true;
    eventBus.subscribe('main-ai', () => { if (boom) throw new Error('x'); });
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    boom = false;
    for (let i = 0; i < 50; i++) eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    expect(signals).toHaveLength(1);
  });

  it('an ASYNC rejection is remembered, and a later resolved handler recovers it', async () => {
    let boom = true;
    eventBus.subscribe('projector', async () => {
      if (boom) throw new Error('async bug');
    });

    eventBus.emit(EventNames.SESSION_RESULT, {}, ['projector']);
    await Promise.resolve(); await Promise.resolve();
    expect(_failedBusPairsForTest()).toEqual(['bus:projector:session:result']);

    boom = false;
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['projector']);
    await Promise.resolve(); await Promise.resolve();
    expect(signals).toEqual([['bus:projector:session:result']]);
  });

  it('an async handler is NOT counted as recovered before its promise settles', async () => {
    // The trap: the sync `return` of an async function happens immediately, so
    // treating "handler returned" as success would retire the card while the work
    // is still in flight — and then the rejection would re-add it a tick later.
    let release: (() => void) | null = null;
    let boom = true;
    eventBus.subscribe('slow', () => new Promise<void>((resolve, reject) => {
      release = () => (boom ? reject(new Error('late failure')) : resolve());
    }));

    eventBus.emit(EventNames.SESSION_RESULT, {}, ['slow']);
    expect(_failedBusPairsForTest()).toEqual([]);   // nothing decided yet
    expect(signals).toEqual([]);
    release!();
    await Promise.resolve(); await Promise.resolve();
    expect(_failedBusPairsForTest()).toEqual(['bus:slow:session:result']);

    boom = false;
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['slow']);
    expect(signals).toEqual([]);                   // still in flight → still no signal
    release!();
    await Promise.resolve(); await Promise.resolve();
    expect(signals).toEqual([['bus:slow:session:result']]);
  });

  it('tracks pairs INDEPENDENTLY — a different event or subscriber is a different condition', () => {
    let boom = true;
    eventBus.subscribe('main-ai', (e) => {
      if (boom && e.name === EventNames.SESSION_RESULT) throw new Error('x');
    });
    eventBus.subscribe('other', () => {});

    eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    // A clean dispatch of a DIFFERENT event to the same subscriber says nothing
    // about the failing one, so it must not retire its card.
    eventBus.emit(EventNames.TASK_UPDATED, {}, ['main-ai']);
    // …nor does a different subscriber handling the same event.
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['other']);
    expect(signals).toEqual([]);
    expect(_failedBusPairsForTest()).toEqual(['bus:main-ai:session:result']);

    boom = false;
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    expect(signals).toEqual([['bus:main-ai:session:result']]);
  });

  it('HOT PATH: a box where nothing has ever failed records nothing and signals nothing', () => {
    eventBus.subscribe('stream', () => {}, { global: true });
    for (let i = 0; i < 2000; i++) eventBus.emit(EventNames.SESSION_TEXT_DELTA, { i }, ['*']);
    // No per-(subscriber × event) bookkeeping accumulates — the whole cost of a
    // healthy dispatch is one `.size === 0` check.
    expect(_failedBusPairsForTest()).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('re-arms across repeated failure episodes', () => {
    let boom = true;
    eventBus.subscribe('main-ai', () => { if (boom) throw new Error('x'); });
    for (let episode = 0; episode < 3; episode++) {
      boom = true;
      eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
      boom = false;
      eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    }
    expect(signals).toHaveLength(3);
  });

  it('a throwing PUBLISHER never breaks the bus', () => {
    // Notification bookkeeping must never become the reason a dispatch fails.
    setBusRecoveryPublisher(() => { throw new Error('store exploded'); });
    let boom = true;
    const seen: number[] = [];
    eventBus.subscribe('main-ai', () => {
      if (boom) throw new Error('x');
      seen.push(1);
    });
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    boom = false;
    expect(() => eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai'])).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('with no publisher wired, failures are still tracked but nothing is signalled', () => {
    setBusRecoveryPublisher(null);
    let boom = true;
    eventBus.subscribe('main-ai', () => { if (boom) throw new Error('x'); });
    eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai']);
    boom = false;
    expect(() => eventBus.emit(EventNames.SESSION_RESULT, {}, ['main-ai'])).not.toThrow();
    expect(_failedBusPairsForTest()).toEqual([]); // still cleaned up
  });
});

// ── Singleton ──

describe('bus singleton', () => {
  afterEach(() => {
    bus.clear();
  });

  it('is an instance of EventBus', () => {
    expect(bus).toBeInstanceOf(EventBus);
  });

  it('works as a shared event bus', () => {
    const received: BusEvent[] = [];
    bus.subscribe('test-sub', (e) => received.push(e));

    bus.emit(EventNames.SYSTEM_EVENT, { msg: 'singleton' }, ['test-sub']);

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ msg: 'singleton' });
  });
});

// ── EventNames ──

describe('EventNames', () => {
  it('contains expected event name constants', () => {
    expect(EventNames.TASK_CREATED).toBe('task:created');
    expect(EventNames.TASK_UPDATED).toBe('task:updated');
    expect(EventNames.TASK_COMPLETED).toBe('task:completed');
    expect(EventNames.AGENT_TEXT_DELTA).toBe('agent:text-delta');
    expect(EventNames.SYNC_PULLED).toBe('sync:pulled');
    expect(EventNames.SESSION_STARTED).toBe('session:started');
    expect(EventNames.CONFIG_CHANGED).toBe('config:changed');
  });
});

// ── CoalescingQueue ──

describe('CoalescingQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueue normal event — not flushed immediately', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal' }));

    expect(flushed).toHaveLength(0);
    expect(queue.size).toBe(1);

    queue.destroy();
  });

  it('enqueue urgent event — flushed after 250ms debounce', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'urgent' }));

    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(250);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(1);

    queue.destroy();
  });

  it('normal events flush after 60s timer', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal' }));
    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_UPDATED }));

    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(60_000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);

    queue.destroy();
  });

  it('urgent flush also flushes normal buffer', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_CREATED }));
    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_UPDATED }));
    queue.enqueue(makeEvent({ urgency: 'urgent', name: EventNames.AGENT_TEXT_DELTA }));

    vi.advanceTimersByTime(250);

    expect(flushed).toHaveLength(1);
    // Should contain all 3 events (2 normal + 1 urgent)
    expect(flushed[0]).toHaveLength(3);

    // Urgent events come first (they're in urgentBuffer), then normal
    expect(flushed[0][0].name).toBe(EventNames.AGENT_TEXT_DELTA);
    expect(flushed[0][1].name).toBe(EventNames.TASK_CREATED);
    expect(flushed[0][2].name).toBe(EventNames.TASK_UPDATED);

    queue.destroy();
  });

  it('FIFO eviction when maxItems (20) exceeded', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      maxItems: 5,
      onFlush: (events) => flushed.push(events),
    });

    // Enqueue 8 normal events
    for (let i = 0; i < 8; i++) {
      queue.enqueue(makeEvent({ urgency: 'normal', data: { i } }));
    }

    // Buffer should be capped at 5 (oldest 3 evicted)
    expect(queue.size).toBe(5);

    const events = queue.flush();
    // The remaining events should be indices 3–7 (FIFO eviction)
    expect(events).toHaveLength(5);
    expect((events[0].data as { i: number }).i).toBe(3);
    expect((events[4].data as { i: number }).i).toBe(7);

    queue.destroy();
  });

  it('manual flush returns all buffered events and clears', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_CREATED }));
    queue.enqueue(makeEvent({ urgency: 'urgent', name: EventNames.AGENT_TEXT_DELTA }));

    expect(queue.size).toBe(2);

    const events = queue.flush();

    expect(events).toHaveLength(2);
    expect(queue.size).toBe(0);
    expect(flushed).toHaveLength(1);

    queue.destroy();
  });

  it('manual flush with empty buffers returns empty and does not call onFlush', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    const events = queue.flush();

    expect(events).toHaveLength(0);
    expect(flushed).toHaveLength(0);

    queue.destroy();
  });

  it('onFlush callback fires with correct event batch', () => {
    const onFlush = vi.fn();
    const queue = new CoalescingQueue({ onFlush });

    const event1 = makeEvent({ urgency: 'urgent', name: EventNames.TASK_CREATED });
    const event2 = makeEvent({ urgency: 'urgent', name: EventNames.TASK_UPDATED });

    queue.enqueue(event1);
    queue.enqueue(event2);

    vi.advanceTimersByTime(250);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: EventNames.TASK_CREATED }),
      expect.objectContaining({ name: EventNames.TASK_UPDATED }),
    ]));

    queue.destroy();
  });

  it('destroy cleans up timers', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'urgent' }));
    queue.enqueue(makeEvent({ urgency: 'normal' }));

    queue.destroy();

    // Advance past all timers — nothing should flush
    vi.advanceTimersByTime(120_000);

    expect(flushed).toHaveLength(0);
  });

  it('destroy prevents further enqueues', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.destroy();

    queue.enqueue(makeEvent({ urgency: 'urgent' }));

    expect(queue.size).toBe(0);

    vi.advanceTimersByTime(250);
    expect(flushed).toHaveLength(0);
  });

  it('multiple urgent events within 250ms — single flush with all events (debounce)', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'urgent', data: { i: 0 } }));
    vi.advanceTimersByTime(100);
    queue.enqueue(makeEvent({ urgency: 'urgent', data: { i: 1 } }));
    vi.advanceTimersByTime(100);
    queue.enqueue(makeEvent({ urgency: 'urgent', data: { i: 2 } }));

    // 200ms after last enqueue — not yet flushed (debounce resets each time)
    vi.advanceTimersByTime(200);
    expect(flushed).toHaveLength(0);

    // 50ms more (total 250ms since last enqueue) — now flushed
    vi.advanceTimersByTime(50);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);

    queue.destroy();
  });

  it('mixed urgent + normal — both in single flush', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_CREATED }));
    queue.enqueue(makeEvent({ urgency: 'normal', name: EventNames.TASK_UPDATED }));
    queue.enqueue(makeEvent({ urgency: 'urgent', name: EventNames.AGENT_RESPONSE }));

    // Urgent debounce fires and flushes everything
    vi.advanceTimersByTime(250);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
    // Urgent first, then normal (urgentBuffer + normalBuffer order)
    expect(flushed[0][0].urgency).toBe('urgent');
    expect(flushed[0][1].urgency).toBe('normal');
    expect(flushed[0][2].urgency).toBe('normal');

    queue.destroy();
  });

  it('custom urgentDebounceMs and normalFlushMs are respected', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      urgentDebounceMs: 500,
      normalFlushMs: 5000,
      onFlush: (events) => flushed.push(events),
    });

    // Normal event should flush after 5000ms, not 60000ms
    queue.enqueue(makeEvent({ urgency: 'normal' }));

    vi.advanceTimersByTime(4999);
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(flushed).toHaveLength(1);

    // Urgent event should flush after 500ms, not 250ms
    queue.enqueue(makeEvent({ urgency: 'urgent' }));

    vi.advanceTimersByTime(499);
    expect(flushed).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(flushed).toHaveLength(2);

    queue.destroy();
  });

  it('normal timer is not rescheduled on subsequent normal enqueues', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      normalFlushMs: 1000,
      onFlush: (events) => flushed.push(events),
    });

    queue.enqueue(makeEvent({ urgency: 'normal', data: { i: 0 } }));

    // Add another normal event 500ms later
    vi.advanceTimersByTime(500);
    queue.enqueue(makeEvent({ urgency: 'normal', data: { i: 1 } }));

    // At t=1000 the original timer fires — both events are flushed
    vi.advanceTimersByTime(500);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);

    queue.destroy();
  });

  it('FIFO eviction applies per-buffer for urgent events', () => {
    const flushed: BusEvent[][] = [];
    const queue = new CoalescingQueue({
      maxItems: 3,
      onFlush: (events) => flushed.push(events),
    });

    for (let i = 0; i < 5; i++) {
      queue.enqueue(makeEvent({ urgency: 'urgent', data: { i } }));
    }

    // Only 3 urgent events should remain (indices 2, 3, 4)
    const events = queue.flush();
    expect(events).toHaveLength(3);
    expect((events[0].data as { i: number }).i).toBe(2);
    expect((events[2].data as { i: number }).i).toBe(4);

    queue.destroy();
  });
});
