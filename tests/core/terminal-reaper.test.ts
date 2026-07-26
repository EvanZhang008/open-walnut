import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────
// The reaper dynamically imports these three modules; mock all three so we can
// drive the active-terminal list, the session lookup, and the reap helpers.

let activeTerminals: { sessionId: string; host?: string }[] = [];
vi.mock('../../src/web/terminal/terminal-manager.js', () => ({
  terminalManager: {
    listActive: () => activeTerminals,
  },
}));

// sessionId → record (or undefined to simulate a deleted session).
let sessionRecords = new Map<string, { claudeSessionId: string; process_status: string; host?: string } | undefined>();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sid: string) => sessionRecords.get(sid)),
}));

// Record which sessions conditionalReap was asked to reap; return value is
// driven per-session via `foregroundSessions` (a fg process → 'kept').
const conditionalReapCalls: { sessionId: string; host?: string }[] = [];
let foregroundSessions = new Set<string>();
const reapOrphanDtach = vi.fn(async () => {});
vi.mock('../../src/web/terminal/dtach-lifecycle.js', () => ({
  conditionalReap: vi.fn(async (rec: { claudeSessionId: string; host?: string }) => {
    conditionalReapCalls.push({ sessionId: rec.claudeSessionId, host: rec.host });
    return foregroundSessions.has(rec.claudeSessionId) ? 'kept' : 'killed';
  }),
  reapOrphanDtach,
}));

import { TerminalReaper } from '../../src/core/terminal-reaper.js';

beforeEach(() => {
  activeTerminals = [];
  sessionRecords = new Map();
  conditionalReapCalls.length = 0;
  foregroundSessions = new Set();
  reapOrphanDtach.mockClear();
});

describe('TerminalReaper.reap — active-terminal recheck (policy A)', () => {
  it('keeps a terminal whose backing session is still running (alive)', async () => {
    activeTerminals = [{ sessionId: 's-run' }];
    sessionRecords.set('s-run', { claudeSessionId: 's-run', process_status: 'running' });

    const res = await new TerminalReaper().reap();

    expect(conditionalReapCalls).toEqual([]); // never even considered for reap
    expect(res.reapedActive).toBe(0);
    expect(res.rechecked).toBe(1);
  });

  it('keeps a terminal whose session is idle (alive, between turns)', async () => {
    activeTerminals = [{ sessionId: 's-idle' }];
    sessionRecords.set('s-idle', { claudeSessionId: 's-idle', process_status: 'idle' });

    await new TerminalReaper().reap();

    expect(conditionalReapCalls).toEqual([]);
  });

  it('KEEPS a terminal whose task was closed (stopped) — Policy A: record exists', async () => {
    // 'stopped' is the normal resting state of a returnable session; the record
    // still exists, so ① must NOT reap it (never even calls conditionalReap).
    activeTerminals = [{ sessionId: 's-done', host: 'devbox' }];
    sessionRecords.set('s-done', { claudeSessionId: 's-done', process_status: 'stopped' });

    const res = await new TerminalReaper().reap();

    expect(conditionalReapCalls).toEqual([]);
    expect(res.reapedActive).toBe(0);
  });

  it('KEEPS an error-status session whose record still exists (Policy A)', async () => {
    activeTerminals = [{ sessionId: 's-err' }];
    sessionRecords.set('s-err', { claudeSessionId: 's-err', process_status: 'error' });

    const res = await new TerminalReaper().reap();
    expect(conditionalReapCalls).toEqual([]);
    expect(res.reapedActive).toBe(0);
  });

  it('reaps a terminal whose session was deleted (lookup returns undefined)', async () => {
    activeTerminals = [{ sessionId: 's-gone', host: 'devbox' }];
    // no record set → getSessionByClaudeId returns undefined

    const res = await new TerminalReaper().reap();

    expect(conditionalReapCalls).toEqual([{ sessionId: 's-gone', host: 'devbox' }]);
    expect(res.reapedActive).toBe(1);
  });

  it('mixes: only DELETED sessions are reaped; alive AND stopped-with-record are kept', async () => {
    activeTerminals = [
      { sessionId: 'alive' },
      { sessionId: 'stopped' },
      { sessionId: 'deleted' },
    ];
    sessionRecords.set('alive', { claudeSessionId: 'alive', process_status: 'running' });
    // 'stopped' has a record (returnable) → Policy A keeps it.
    sessionRecords.set('stopped', { claudeSessionId: 'stopped', process_status: 'stopped' });
    // 'deleted' → no record

    const res = await new TerminalReaper().reap();

    expect(new Set(conditionalReapCalls.map((c) => c.sessionId))).toEqual(new Set(['deleted']));
    expect(res.reapedActive).toBe(1);
    expect(res.rechecked).toBe(3);
  });

  it('KEEPS a deleted session whose terminal still runs a foreground build', async () => {
    activeTerminals = [{ sessionId: 's-build' }];
    // no record → deleted, so ① considers it; but a live foreground process
    // means conditionalReap returns 'kept' (never kill a live build).
    foregroundSessions.add('s-build');

    const res = await new TerminalReaper().reap();

    expect(conditionalReapCalls.map((c) => c.sessionId)).toEqual(['s-build']); // considered
    expect(res.reapedActive).toBe(0); // but kept, not reaped
  });
});

describe('TerminalReaper.reap — orphan sweep (②)', () => {
  it('always runs reapOrphanDtach as the ground-truth safety net', async () => {
    activeTerminals = [];
    await new TerminalReaper().reap();
    expect(reapOrphanDtach).toHaveBeenCalledTimes(1);
  });

  it('still sweeps even if an active-terminal recheck throws', async () => {
    activeTerminals = [{ sessionId: 's-gone' }];
    // deleted session (no record) so ① calls conditionalReap, which throws.
    const { conditionalReap } = await import('../../src/web/terminal/dtach-lifecycle.js');
    (conditionalReap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await new TerminalReaper().reap();
    expect(reapOrphanDtach).toHaveBeenCalledTimes(1); // ② not blocked by ① failure
  });
});

describe('TerminalReaper.reap — overlap guard (③)', () => {
  it('skips a second reap() while the first is still in flight', async () => {
    // Make conditionalReap hang so the first reap() stays in flight, then fire a
    // second reap() concurrently — it must short-circuit (running=true) and not
    // run the orphan sweep again.
    activeTerminals = [{ sessionId: 's-gone' }]; // deleted → ① calls conditionalReap
    let release!: () => void;
    const hang = new Promise<void>((res) => { release = () => res(); });
    const { conditionalReap } = await import('../../src/web/terminal/dtach-lifecycle.js');
    (conditionalReap as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await hang;
      return 'killed';
    });

    const reaper = new TerminalReaper();
    const first = reaper.reap();          // stalls inside conditionalReap
    const second = await reaper.reap();   // should be skipped immediately

    expect(second).toEqual({ rechecked: 0, reapedActive: 0 });
    expect(reapOrphanDtach).not.toHaveBeenCalled(); // ② from the skipped pass never ran

    release();
    await first; // let the first pass complete cleanly
    expect(reapOrphanDtach).toHaveBeenCalledTimes(1); // only the first pass swept
  });
});

describe('TerminalReaper timer lifecycle', () => {
  it('start() is idempotent and stop() is safe to call without start', () => {
    // Counts real timers instead of asserting `expect(true).toBe(true)`, which was
    // the only tautological assertion in the suite: it passed as long as nothing
    // threw, so a start() that leaked a second interval on every call — the exact
    // idempotence bug named in the title — went undetected.
    vi.useFakeTimers();
    try {
      const r = new TerminalReaper();

      r.stop(); // safe before any start
      expect(vi.getTimerCount()).toBe(0);

      r.start();
      // start() arms two timers: the INITIAL_DELAY_MS kick-off and the recurring interval.
      const afterFirstStart = vi.getTimerCount();
      expect(afterFirstStart).toBe(2);

      r.start(); // idempotent — must NOT arm a second pair
      expect(vi.getTimerCount(), 'second start() leaked additional timers').toBe(afterFirstStart);

      r.stop();
      expect(vi.getTimerCount(), 'stop() left a timer armed').toBe(0);

      r.stop(); // double stop safe
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
