/**
 * Human time tracking (browser side) — the lease state machine and the DOM
 * attribution resolver. Both are pure, so this needs no React and no jsdom:
 * linkedom builds the DOM in-file (closest() + dataset are supported).
 */

import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { resolveAttribution, sameContext, taskIdFromPath } from '@/utils/time-attribution';
import {
  applyExpiry, applySignal, closeLease, flushLease, IDLE_LEASE, leaseExpiryAt,
  sliceLease, trimBatch, LEASE_MS, MAX_BATCH, MIN_SAMPLE_MS,
  type LeaseState, type TimeSample,
} from '@/utils/time-tracking';

const T0 = 1_800_000_000_000; // fixed epoch ms; the machine never reads a clock

const SESSION_ID = 'sess-aaaa-1111-bbbb-2222';

function el(html: string, id: string): Element {
  const { document } = parseHTML(`<body>${html}</body>`);
  const found = document.getElementById(id);
  if (!found) throw new Error(`fixture missing #${id}`);
  return found as unknown as Element;
}

// ── Attribution ──

describe('resolveAttribution', () => {
  it('attributes a click inside a session panel to the SESSION', () => {
    const target = el(
      `<div class="session-panel" data-session-id="${SESSION_ID}">
         <button id="probe">Send</button>
       </div>`,
      'probe',
    );
    expect(resolveAttribution(target, '/')).toEqual({ kind: 'session', sessionId: SESSION_ID });
  });

  it('does NOT bill a task the transcript merely mentions', () => {
    // The markdown renderer emits <a class="task-link" data-task-id=…> for a
    // task REFERENCE. A naive closest('[data-task-id]') would bill it.
    const target = el(
      `<div class="session-panel" data-session-id="${SESSION_ID}">
         <a class="task-link" data-task-id="t_mentioned" id="probe">t_mentioned</a>
       </div>`,
      'probe',
    );
    expect(resolveAttribution(target, '/')).toEqual({ kind: 'session', sessionId: SESSION_ID });
  });

  it('ignores a task anchor even outside a session panel — anchors are not rows', () => {
    const target = el('<div class="notes-body"><a class="task-link" data-task-id="t_mentioned" id="probe">x</a></div>', 'probe');
    expect(resolveAttribution(target, '/notes')).toBeNull();
  });

  it('attributes a task row to TRIAGE', () => {
    const target = el(
      '<div class="todo-panel-item" data-task-id="t_alpha"><span id="probe">title</span></div>',
      'probe',
    );
    expect(resolveAttribution(target, '/')).toEqual({ kind: 'triage', taskId: 't_alpha' });
  });

  it('attributes the triage panel to the task being triaged', () => {
    const target = el('<div class="triage-panel" data-task-id="t_beta"><button id="probe">x</button></div>', 'probe');
    expect(resolveAttribution(target, '/')).toEqual({ kind: 'triage', taskId: 't_beta' });
  });

  it('attributes the main-agent chat to CHAT', () => {
    const target = el('<div class="main-page-chat"><textarea id="probe"></textarea></div>', 'probe');
    expect(resolveAttribution(target, '/')).toEqual({ kind: 'chat' });
    const inner = el('<div class="chat-panel chat-lane-history"><p id="probe">hi</p></div>', 'probe');
    expect(resolveAttribution(inner, '/')).toEqual({ kind: 'chat' });
  });

  it('falls back to the /tasks/:id route for page chrome', () => {
    const target = el('<div class="task-detail-v2"><h1 id="probe">t</h1></div>', 'probe');
    expect(resolveAttribution(target, '/tasks/t_gamma')).toEqual({ kind: 'triage', taskId: 't_gamma' });
    expect(resolveAttribution(null, '/tasks/t_gamma')).toEqual({ kind: 'triage', taskId: 't_gamma' });
  });

  it('prefers a pending panel over nothing but never invents a session id', () => {
    // A pending/draft panel has no data-session-id — there is no session yet.
    const target = el('<div class="session-panel pending-session-panel"><button id="probe">x</button></div>', 'probe');
    expect(resolveAttribution(target, '/')).toBeNull();
  });

  it('returns null for unattributable chrome — that time is not counted', () => {
    const target = el('<div class="sidebar"><button id="probe">Settings</button></div>', 'probe');
    expect(resolveAttribution(target, '/settings')).toBeNull();
  });

  it('parses /tasks/:id and nothing else', () => {
    expect(taskIdFromPath('/tasks/t_alpha')).toBe('t_alpha');
    expect(taskIdFromPath('/tasks/t_alpha?tab=changed')).toBe('t_alpha');
    expect(taskIdFromPath('/tasks')).toBeUndefined();
    expect(taskIdFromPath('/')).toBeUndefined();
    expect(taskIdFromPath('/time')).toBeUndefined();
  });

  it('compares contexts by every field', () => {
    expect(sameContext({ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'a' })).toBe(true);
    expect(sameContext({ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'b' })).toBe(false);
    expect(sameContext({ kind: 'triage', taskId: 'a' }, { kind: 'chat' })).toBe(false);
    expect(sameContext(null, null)).toBe(true);
    expect(sameContext(null, { kind: 'chat' })).toBe(false);
  });
});

// ── Lease machine ──

const SESSION_CTX = { kind: 'session', sessionId: SESSION_ID } as const;
const TASK_CTX = { kind: 'triage', taskId: 't_alpha' } as const;

function totalMs(samples: TimeSample[]): number {
  return samples.reduce((sum, s) => sum + s.durationMs, 0);
}

describe('lease grant / renew / expire', () => {
  it('grants a lease on the first signal and banks nothing yet', () => {
    const out = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0);
    expect(out.sample).toBeUndefined();
    expect(out.state).toEqual({ ctx: SESSION_CTX, startedAt: T0, lastSignalAt: T0 });
    expect(leaseExpiryAt(out.state)).toBe(T0 + LEASE_MS);
  });

  it('renews without banking and without moving the window start', () => {
    let state = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applySignal(state, SESSION_CTX, T0 + 10_000);
    expect(out.sample).toBeUndefined();
    expect(out.state.startedAt).toBe(T0);
    expect(out.state.lastSignalAt).toBe(T0 + 10_000);
    state = out.state;
    expect(leaseExpiryAt(state)).toBe(T0 + 10_000 + LEASE_MS);
  });

  it('a single signal earns exactly one lease, then the clock STOPS', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    // Long past the expiry: a parked cursor must not keep earning.
    const out = applyExpiry(granted, T0 + 10 * LEASE_MS);
    expect(out.sample!.durationMs).toBe(LEASE_MS);
    expect(out.state.ctx).toBeNull();
  });

  it('does not expire while the lease is still valid', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applyExpiry(granted, T0 + LEASE_MS - 1);
    expect(out.sample).toBeUndefined();
    expect(out.state).toBe(granted);
  });

  it('a signal after the lease lapsed banks only the old runway, then starts fresh', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applySignal(granted, SESSION_CTX, T0 + 300_000);
    expect(out.sample!.durationMs).toBe(LEASE_MS);
    expect(out.sample!.ts).toBe(new Date(T0).toISOString());
    expect(out.state.startedAt).toBe(T0 + 300_000);
  });
});

describe('last-signal-wins switching', () => {
  it('banks the old context up to the switch instant and starts the new one there', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applySignal(granted, TASK_CTX, T0 + 10_000);
    expect(out.sample).toMatchObject({ durationMs: 10_000, kind: 'session', sessionId: SESSION_ID });
    expect(out.state.ctx).toEqual(TASK_CTX);
    expect(out.state.startedAt).toBe(T0 + 10_000);
  });

  it('only ONE context earns across a switch — no overlap, nothing lost', () => {
    let state: LeaseState = { ...IDLE_LEASE };
    const banked: TimeSample[] = [];
    const step = (ctx: typeof SESSION_CTX | typeof TASK_CTX, at: number) => {
      const out = applySignal(state, ctx, at);
      state = out.state;
      if (out.sample) banked.push(out.sample);
    };
    step(SESSION_CTX, T0);
    step(TASK_CTX, T0 + 20_000);
    step(SESSION_CTX, T0 + 50_000);
    const closed = closeLease(state, T0 + 55_000);
    banked.push(...closed.samples);

    expect(totalMs(banked)).toBe(55_000);
    expect(banked.map((s) => s.durationMs)).toEqual([20_000, 30_000, 5_000]);
    expect(banked.map((s) => s.kind)).toEqual(['session', 'triage', 'session']);
  });

  it('treats two different sessions as different earners', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applySignal(granted, { kind: 'session', sessionId: 'sess-cccc-3333' }, T0 + 5_000);
    expect(out.sample!.sessionId).toBe(SESSION_ID);
    expect(out.state.ctx).toMatchObject({ sessionId: 'sess-cccc-3333' });
  });

  it('drops a sub-threshold fragment rather than emitting noise', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = applySignal(granted, TASK_CTX, T0 + MIN_SAMPLE_MS - 1);
    expect(out.sample).toBeUndefined();
    expect(out.state.ctx).toEqual(TASK_CTX);
  });
});

describe('batching boundaries', () => {
  it('a flush inside a valid lease banks the elapsed part and keeps earning', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = sliceLease(granted, T0 + 30_000);
    expect(out.sample!.durationMs).toBe(30_000);
    expect(out.state.ctx).toEqual(SESSION_CTX);
    expect(out.state.startedAt).toBe(T0 + 30_000);
    expect(out.state.lastSignalAt).toBe(T0); // the lease runway is untouched
  });

  it('30s flushes over one click total exactly one lease, never more', () => {
    let state = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const banked: TimeSample[] = [];
    for (let tick = 1; tick <= 6; tick++) {
      const out = flushLease(state, T0 + tick * 30_000);
      state = out.state;
      banked.push(...out.samples);
    }
    expect(totalMs(banked)).toBe(LEASE_MS);
    expect(state.ctx).toBeNull();
  });

  it('keeps a renewed lease alive across flushes and conserves total time', () => {
    let state = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const banked: TimeSample[] = [];
    const flushAt = (at: number) => {
      const out = flushLease(state, at);
      state = out.state;
      banked.push(...out.samples);
    };
    flushAt(T0 + 30_000);
    state = applySignal(state, SESSION_CTX, T0 + 45_000).state; // renew → expiry T0+105s
    flushAt(T0 + 60_000);
    flushAt(T0 + 90_000);
    flushAt(T0 + 120_000); // past the expiry → closes at T0+105s
    expect(totalMs(banked)).toBe(105_000);
    expect(state.ctx).toBeNull();
  });

  it('a flush on an idle machine emits nothing', () => {
    const out = flushLease({ ...IDLE_LEASE }, T0);
    expect(out.samples).toEqual([]);
    expect(out.state.ctx).toBeNull();
  });

  it('closeLease caps at the expiry — a hidden tab cannot earn the future', () => {
    const granted = applySignal({ ...IDLE_LEASE }, SESSION_CTX, T0).state;
    const out = closeLease(granted, T0 + 10 * LEASE_MS);
    expect(out.samples[0]!.durationMs).toBe(LEASE_MS);
    expect(out.state.ctx).toBeNull();
    expect(closeLease({ ...IDLE_LEASE }, T0).samples).toEqual([]);
  });

  it('trims an overflowing batch by dropping the OLDEST samples', () => {
    const samples: TimeSample[] = [...Array(MAX_BATCH + 10)].map((_, i) => ({
      ts: new Date(T0 + i).toISOString(), durationMs: 1000, kind: 'chat',
    }));
    const out = trimBatch(samples);
    expect(out).toHaveLength(MAX_BATCH);
    expect(out[0]!.ts).toBe(new Date(T0 + 10).toISOString());
    expect(trimBatch(samples.slice(0, 3))).toHaveLength(3);
  });
});
