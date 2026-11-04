/**
 * The idle compaction scheduler (src/core/sessions/idle-compaction.ts): it arms at a turn end,
 * sends `/compact` as a quiet turn when the cache is about to expire, and stands down whenever the
 * session is not idle on that same request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdleCompaction, IDLE_COMPACT_SOURCE, resolveIdleCompactionConfig, skipReason, type IdleCompactionDeps } from '../../../src/core/sessions/idle-compaction.js';
import {
  isQuietTurn, noteQuietTurnDelivery, noteSessionSend, onQuietTurnEnd, quietTurnRow, resetQuietTurnsForTest,
} from '../../../src/core/sessions/quiet-turn.js';
import { ONE_HOUR_MS, IDLE_COMPACT_LEAD_MS, type PromptCacheFacts } from '../../../src/core/sessions/prompt-cache.js';
import { EventNames, type BusEvent } from '../../../src/core/event-bus.js';
import type { SessionRecord, Task } from '../../../src/core/types.js';

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const SID = 'sess-idle-1';
const facts = (over: Partial<PromptCacheFacts> = {}): PromptCacheFacts => ({
  tokens: 400_000, ttlMs: ONE_HOUR_MS, requestAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + ONE_HOUR_MS).toISOString(), compactsAt: 450_000, compactsAtSource: 'auto-compact', ...over,
});
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: SID, taskId: 'task-1', process_status: 'idle', last_status_change: new Date(T0 + 30_000).toISOString(),
  ...over,
} as SessionRecord);
const task = (over: Partial<Task> = {}): Task => ({ id: 'task-1', phase: 'NEED_ACTION', ...over } as Task);
const ev = (name: string, data: Record<string, unknown>, source = 'session-runner'): BusEvent =>
  ({ name, data, source, destinations: [], timestamp: '' } as unknown as BusEvent);

interface Harness {
  ic: IdleCompaction;
  now: { ms: number };
  timers: Array<{ fn: () => void; at: number; cleared: boolean }>;
  sends: Array<{ sid: string; text: string; source: string }>;
  /** The fake queue: row id → its status. */
  rows: Map<string, 'pending' | 'processing'>;
  lastRow: () => string | undefined;
  notes: string[];
  saved: Array<Partial<SessionRecord>>;
  state: { rec: SessionRecord | null; task: Task | null; live: PromptCacheFacts | undefined; inTurn: boolean | null; queued: number; outliving: boolean };
  runDue: () => Promise<void>;
}

function harness(over: Partial<IdleCompactionDeps> = {}): Harness {
  const now = { ms: T0 + 60_000 };
  const timers: Harness['timers'] = [];
  const sends: Harness['sends'] = [];
  const notes: string[] = [];
  const saved: Array<Partial<SessionRecord>> = [];
  const rows: Harness['rows'] = new Map();
  let last: string | undefined;
  const state: Harness['state'] = { rec: record(), task: task(), live: facts(), inTurn: false, queued: 0, outliving: false };
  const ic = new IdleCompaction({
    now: () => now.ms,
    setTimer: (fn, ms) => { const t = { fn, at: now.ms + ms, cleared: false }; timers.push(t); return t as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (t) => { (t as unknown as { cleared: boolean }).cleared = true; },
    config: async () => resolveIdleCompactionConfig({ idle_compaction: { enabled: true } }, {}),
    getSession: async () => state.rec,
    listSessions: async () => (state.rec ? [state.rec] : []),
    saveSession: async (_id, updates) => { saved.push(updates); if (state.rec) state.rec = { ...state.rec, ...updates }; },
    getTask: async () => state.task,
    live: () => ({ promptCache: state.live, inTurn: state.inTurn, outliving: state.outliving, cron: false }),
    queued: async () => state.queued,
    orgOffFor: async () => false,
    send: async (sid, text, opts) => {
      if (!opts.stillWanted()) throw new Error('send no longer wanted');
      expect(opts.userUuid).toMatch(/^[0-9a-f-]{36}$/);
      rows.set(opts.messageId, 'pending'); last = opts.messageId;
      sends.push({ sid, text, source: opts.source });
    },
    dropRow: async (_sid, rowId) => (rows.get(rowId) === 'pending' ? rows.delete(rowId) : false),
    rowQueued: async (_sid, rowId) => rows.has(rowId),
    emitNote: (_sid, _task, message) => { notes.push(message); },
    announce: () => {},
    ...over,
  });
  const runDue = async () => {
    for (const t of timers.filter((x) => !x.cleared && x.at <= now.ms)) { t.cleared = true; await (t.fn as () => unknown)(); }
    await new Promise((r) => setTimeout(r, 0));
  };
  onQuietTurnEnd(ic.onQuietEnd);
  return { ic, now, timers, sends, rows, lastRow: () => last, notes, saved, state, runDue };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetQuietTurnsForTest());
afterEach(() => { onQuietTurnEnd(null); resetQuietTurnsForTest(); });

describe('a turn end arms it', () => {
  it('stores the facts and arms one timer for the lead before expiry, once per request', async () => {
    const h = harness();
    await h.ic.onTurnEnd(SID);
    expect(h.saved[0]).toEqual({ promptCache: facts() });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.at).toBe(T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS);
    await h.ic.onTurnEnd(SID);
    expect(h.timers).toHaveLength(1);
  });

  it('a small session arms nothing, and a send from anyone else disarms', async () => {
    const h = harness();
    h.state.live = facts({ tokens: 90_000 });
    await h.ic.onTurnEnd(SID);
    expect(h.timers).toHaveLength(0);
    h.state.live = facts();
    await h.ic.onTurnEnd(SID);
    expect(h.ic.armedFor(SID)).toBe(facts().requestAt);
    h.ic.handleEvent(ev(EventNames.SESSION_SEND, { sessionId: SID }, 'ui'));
    expect(h.ic.armedFor(SID)).toBeUndefined();
    expect(h.timers[0]!.cleared).toBe(true);
  });

  it('a failed or interrupted turn disarms', async () => {
    const h = harness();
    await h.ic.onTurnEnd(SID);
    h.ic.handleEvent(ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true }));
    expect(h.ic.armedFor(SID)).toBeUndefined();
  });
});

describe('when it fires', () => {
  it('sends the bare /compact as a quiet turn, with a note, and records it', async () => {
    const h = harness();
    await h.ic.onTurnEnd(SID);
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    await h.runDue();
    expect(h.sends).toEqual([{ sid: SID, text: '/compact', source: IDLE_COMPACT_SOURCE }]);
    expect(isQuietTurn(SID)).toBe(true);
    expect(h.notes[0]).toBe('Compacting this idle session before its prompt cache expires in about 3 min: 400K tokens, past 85% (383K) of the 450K auto-compaction window this session uses.');
    expect(h.state.rec?.idleCompaction).toMatchObject({ priorTurnEnd: new Date(T0 + 30_000).toISOString(), tokens: 400_000 });
    // Its history row says why: kept by the command line's uuid.
    expect(h.state.rec?.idleCompactionLog).toEqual([{
      lineUuid: expect.stringMatching(/^cc0a1d1e-/), sentAt: new Date(h.now.ms).toISOString(),
      tokens: 400_000, threshold: 382_500, limitPercent: 85, compactsAt: 450_000, source: 'auto-compact',
    }]);
  });

  it('a second fire for the same request sends nothing: one compaction per request', async () => {
    const h = harness();
    await h.ic.onTurnEnd(SID);
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    await h.runDue();
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('already-compacted');
    expect(h.sends).toHaveLength(1);
  });

  it('stands down when the session is not idle on that same request', async () => {
    const cases: Array<[string, (h: Harness) => void]> = [
      ['turn-running', (h) => { h.state.inTurn = true; }],
      ['status-running', (h) => { h.state.rec = record({ process_status: 'running' }); }],
      ['newer-request', (h) => { h.state.live = facts({ requestAt: new Date(T0 + 1000).toISOString(), expiresAt: new Date(T0 + 1000 + ONE_HOUR_MS).toISOString() }); }],
      ['messages-queued', (h) => { h.state.queued = 1; }],
      ['work-outlives-turn', (h) => { h.state.outliving = true; }],
      ['prompt-open', (h) => { h.state.rec = record({ pendingPermission: { requestId: 'r', toolName: 'Bash' } as SessionRecord['pendingPermission'] }); }],
      ['task-complete', (h) => { h.state.task = task({ phase: 'COMPLETE' }); }],
      ['not-a-claude-session', (h) => { h.state.rec = record({ lane: 'chat:general:c1' }); }],
      ['not-a-claude-session', (h) => { h.state.rec = record({ engine: 'codex' } as Partial<SessionRecord>); }],
      ['session-gone', (h) => { h.state.rec = null; }],
      ['superseded', (h) => { h.state.rec = record({ supersededBy: 'sess-new' }); }],
    ];
    for (const [why, arrange] of cases) {
      resetQuietTurnsForTest();
      const h = harness();
      arrange(h);
      h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
      expect(await h.ic.fire(SID, facts().requestAt), why).toBe(why.startsWith('status-') ? 'status-running' : why);
      expect(h.sends, why).toEqual([]);
      expect(isQuietTurn(SID), why).toBe(false);
    }
  });

  it('a stopped session is left alone: the user stopped it, or a resume would rebuild its prompt and miss the cache', async () => {
    for (const reason of ['user_terminated', 'idle_timeout']) {
      resetQuietTurnsForTest();
      const h = harness();
      h.state.rec = record({ process_status: 'stopped', status_reason: reason } as Partial<SessionRecord>);
      h.state.live = undefined;
      h.state.rec.promptCache = facts();
      h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
      expect(await h.ic.fire(SID, facts().requestAt), reason).toBe('status-stopped');
      expect(h.sends, reason).toEqual([]);
    }
  });

  it('the row has its own id; a person writing before it went out takes it back, and the record says it ended', async () => {
    const h = harness();
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('sent');
    const row = h.lastRow()!;
    expect(row).toMatch(/^qm-quiet-idle-compact-/);
    expect(quietTurnRow(SID)).toBe(row);
    expect(h.state.rec?.idleCompaction?.rowId).toBe(row);
    noteSessionSend(SID, 'ui');
    await settle(); await settle();
    expect(h.rows.has(row)).toBe(false);
    expect(isQuietTurn(SID)).toBe(false);
    expect(h.state.rec?.idleCompaction?.endedAt).toBeTruthy();
  });

  it('a person writing while it is being sent: nothing is stored, no note, nothing stays quiet', async () => {
    const h = harness();
    const realSend = h.ic['deps'].send;
    h.ic['deps'].send = async (sid, text, opts) => { noteSessionSend(SID, 'ui'); return realSend(sid, text, opts); };
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('superseded');
    expect(h.sends).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(isQuietTurn(SID)).toBe(false);
    expect(h.state.rec?.idleCompaction).toBeUndefined();
  });

  it('a turn or a message that began during its checks wins', async () => {
    let calls = 0;
    const h = harness({ queued: async () => (calls++ === 0 ? 0 : 1) });
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('busy');
    expect(h.sends).toEqual([]);
    expect(isQuietTurn(SID)).toBe(false);
  });

  it('a line that fails takes the row back, so it never runs in front of the next message', async () => {
    const h = harness();
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    await h.ic.fire(SID, facts().requestAt);
    const row = h.lastRow()!;
    noteQuietTurnDelivery(SID, [row]);
    // The failed line is back in the queue as pending.
    h.ic.handleEvent(ev(EventNames.SESSION_ERROR, { sessionId: SID, errorKind: 'delivery_failed' }));
    await settle(); await settle();
    expect(h.rows.has(row)).toBe(false);
  });

  it('another line going out first ends it and takes its row back', async () => {
    const h = harness();
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    await h.ic.fire(SID, facts().requestAt);
    const row = h.lastRow()!;
    noteQuietTurnDelivery(SID, ['qm-person']);
    await settle(); await settle();
    expect(isQuietTurn(SID)).toBe(false);
    expect(h.rows.has(row)).toBe(false);
  });

  it('a failed send ends the quiet turn at once', async () => {
    const h = harness({ send: async () => { throw new Error('daemon down'); } });
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('send-failed');
    expect(isQuietTurn(SID)).toBe(false);
  });

  it('tells the open panels when it runs and when it ended, a person\'s send included', async () => {
    const told: boolean[] = [];
    const h = harness({ announce: (_sid, active) => { told.push(active); } });
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('sent');
    expect(told).toEqual([true]);
    noteSessionSend(SID, 'ui');
    expect(told).toEqual([true, false]);
  });

  it('a person writing once the line went out leaves the panels saying it compacts (its result clears them)', async () => {
    const told: boolean[] = [];
    const h = harness({ announce: (_sid, active) => { told.push(active); } });
    h.now.ms = T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS;
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('sent');
    noteQuietTurnDelivery(SID, [h.lastRow()!]);
    noteSessionSend(SID, 'ui');
    expect(isQuietTurn(SID)).toBe(false);
    expect(told).toEqual([true]);
  });

  // 2026-11-04 on the Mac: under memory pressure the idle reap ends a CLI after 15 minutes, long before
  // its compaction time, and a reaped session is never compacted. The reap's warning sends it then.
  it('an idle reap about to end the CLI sends the armed compaction now; an unarmed session is left alone', async () => {
    const h = harness();
    h.ic.handleEvent(ev(EventNames.SESSION_WILL_REAP, { sessionId: SID, remainingMs: 240_000 }, 'session-health-monitor'));
    await h.runDue();
    expect(h.sends).toEqual([]);
    await h.ic.onTurnEnd(SID);
    h.now.ms = T0 + 10 * 60_000;
    // The reap's own tick (no time left) would cut it off: nothing then.
    h.ic.handleEvent(ev(EventNames.SESSION_WILL_REAP, { sessionId: SID, remainingMs: 0 }, 'session-health-monitor'));
    await h.runDue();
    expect(h.sends).toEqual([]);
    h.ic.handleEvent(ev(EventNames.SESSION_WILL_REAP, { sessionId: SID, remainingMs: 240_000 }, 'session-health-monitor'));
    for (let i = 0; i < 50 && h.sends.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.sends).toEqual([{ sid: SID, text: '/compact', source: IDLE_COMPACT_SOURCE }]);
    expect(h.timers[0]!.cleared).toBe(true);
    expect(h.ic.armedFor(SID)).toBeUndefined();
  });

  // 2026-11-04 review: switched back on, or the threshold lowered, and a big session already idle
  // was not compacted until its next turn. A config change arms (and disarms) every session now.
  it('a settings change re-arms the idle sessions under the new switch and threshold', async () => {
    // 400K of a 450K window is 89%.
    const cfg = { enabled: true, min: 95 };
    const h = harness({ config: async () => resolveIdleCompactionConfig({ idle_compaction: { enabled: cfg.enabled, limit_percent: cfg.min } }, {}) });
    await h.ic.onTurnEnd(SID);
    expect(h.ic.armedFor(SID)).toBeUndefined();
    const changed = async () => {
      h.ic.handleEvent(ev(EventNames.CONFIG_CHANGED, {}, 'config'));
      h.now.ms += 1_000;
      await h.runDue();
      for (let i = 0; i < 20; i++) await settle();
    };
    cfg.min = 85;
    await changed();
    expect(h.ic.armedFor(SID)).toBe(facts().requestAt);
    cfg.enabled = false;
    await changed();
    expect(h.ic.armedFor(SID)).toBeUndefined();
    cfg.enabled = true;
    await changed();
    expect(h.ic.armedFor(SID)).toBe(facts().requestAt);
    cfg.min = 90;
    await changed();
    expect(h.ic.armedFor(SID)).toBeUndefined();
    // Already sent for this request: a change does not arm it again.
    cfg.min = 85;
    h.state.rec = record({ idleCompaction: { sentAt: new Date(T0 + 50 * 60_000).toISOString(), rowId: 'qm-quiet-idle-compact-b' } });
    await changed();
    expect(h.ic.armedFor(SID)).toBeUndefined();
  });

  it('a session disarmed by a stopped turn stays disarmed through a settings change, until its next clean turn', async () => {
    const cfg = { min: 95 };
    const h = harness({ config: async () => resolveIdleCompactionConfig({ idle_compaction: { limit_percent: cfg.min } }, {}) });
    const changed = async () => {
      h.ic.handleEvent(ev(EventNames.CONFIG_CHANGED, {}, 'config'));
      h.now.ms += 1_000;
      await h.runDue();
      for (let i = 0; i < 20; i++) await settle();
    };
    h.ic.handleEvent(ev(EventNames.SESSION_RESULT, { sessionId: SID, interrupted: true }));
    cfg.min = 85;
    await changed();
    expect(h.ic.armedFor(SID)).toBeUndefined();
    await h.ic.onTurnEnd(SID);
    expect(h.ic.armedFor(SID)).toBe(facts().requestAt);
    // A change of another key (same idle compaction settings) re-arms nothing.
    h.ic.cancel(SID, 'no-window');
    await changed();
    expect(h.ic.armedFor(SID)).toBeUndefined();
  });

  it('a timer for a newer request is not replaced by older facts', async () => {
    const h = harness();
    const newer = facts({ requestAt: new Date(T0 + 120_000).toISOString(), expiresAt: new Date(T0 + 120_000 + ONE_HOUR_MS).toISOString() });
    await h.ic.schedule(SID, newer);
    await h.ic.schedule(SID, facts());
    expect(h.ic.armedFor(SID)).toBe(newer.requestAt);
  });

  it('off in config, off everywhere', async () => {
    const h = harness({ config: async () => resolveIdleCompactionConfig({ idle_compaction: { enabled: false } }, {}) });
    await h.ic.onTurnEnd(SID);
    expect(h.timers).toHaveLength(0);
    expect(await h.ic.fire(SID, facts().requestAt)).toBe('off');
  });
});

describe('at boot', () => {
  it('rebuilds a timer from the stored facts', async () => {
    const h = harness();
    h.state.live = undefined;
    h.state.rec = record({ promptCache: facts() });
    expect(await h.ic.rebuild()).toBe(1);
    expect(h.ic.armedFor(SID)).toBe(facts().requestAt);
  });

  it('a compaction a restart cut off is not resumed: its waiting row is taken back and its end stored', async () => {
    for (const rowThere of [true, false]) {
      resetQuietTurnsForTest();
      const h = harness();
      if (rowThere) h.rows.set('qm-quiet-idle-compact-a', 'pending');
      h.state.rec = record({ idleCompaction: { sentAt: new Date(h.now.ms - 60_000).toISOString(), rowId: 'qm-quiet-idle-compact-a' } });
      await h.ic.rebuild();
      expect(isQuietTurn(SID)).toBe(false);
      expect(h.rows.has('qm-quiet-idle-compact-a')).toBe(false);
      expect(h.state.rec?.idleCompaction?.endedAt).toBeTruthy();
    }
  });
});

describe('the settings', () => {
  it('reads enabled, the threshold and the test lead', () => {
    expect(resolveIdleCompactionConfig(undefined, {})).toEqual({ enabled: true, limitPercent: 85, leadMs: IDLE_COMPACT_LEAD_MS });
    expect(resolveIdleCompactionConfig({ idle_compaction: { limit_percent: 90 } }, { WALNUT_IDLE_COMPACT_LEAD_MS: '3590000' }))
      .toEqual({ enabled: true, limitPercent: 90, leadMs: 3_590_000 });
    expect(resolveIdleCompactionConfig({ idle_compaction: { limit_percent: 20 } }, {}).limitPercent).toBe(85);
    expect(resolveIdleCompactionConfig({ idle_compaction: { enabled: false } }, {}).enabled).toBe(false);
    expect(resolveIdleCompactionConfig({}, { WALNUT_IDLE_COMPACTION: '0' }).enabled).toBe(false);
  });

  it('skipReason is the one decision, pure', () => {
    const cfg = resolveIdleCompactionConfig({ idle_compaction: { enabled: true } }, {});
    const base = {
      rec: record(), task: task(), facts: facts(), scheduledFor: facts().requestAt,
      live: { inTurn: false, outliving: false, cron: false }, queued: 0, orgOff: false, nowMs: T0 + ONE_HOUR_MS - 60_000, cfg,
    };
    expect(skipReason(base)).toBeNull();
    expect(skipReason({ ...base, nowMs: T0 + ONE_HOUR_MS - 10_000 })).toBe('too-late');
    expect(skipReason({ ...base, orgOff: true })).toBe('org-off');
    expect(skipReason({ ...base, live: { ...base.live, cron: true } })).toBe('cron-armed');
  });
});
