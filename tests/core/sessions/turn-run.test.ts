/**
 * The session's current turn as one record (src/core/sessions/turn-run.ts): every reader of "is Walnut
 * retrying this turn" asks it, and every retry kind is a reason with a row.
 *
 * 2026-11-03 to 11-11: the endpoint wait, the usage-limit wait, restart and start recovery, the
 * auto-continue retry and the safeguard switch each added their own branch to the turn-end hook
 * (session-hooks/builtins.ts), and their own reads to the phase, the health monitor, the user status
 * and the runner; the context recovery held the card and the phase but not the notices. The guards
 * below fail when a reader asks a retrier directly again, or when a new kind of retry (a module that
 * hears a turn end and sends into the session) has no reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import {
  TURN_RETRY_REASONS, TURN_RETRY_TRAITS, __resetTurnRunForTesting, __setTurnRetrierForTesting, holdTurnEndNotices,
  loadTurnRetriers, noteTurnAttempt, startTurnRun, turnEndKeepsPhase, turnEndTakenBy, turnMidWork, turnRunOf,
  type TurnRetrier, type TurnRetryReason,
} from '../../../src/core/sessions/turn-run.js';
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js';
import type { SessionRecord } from '../../../src/core/types.js';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}
const SRC = (() => { const out: string[] = []; walk(path.join(ROOT, 'src'), out); return out.map((f) => path.relative(ROOT, f).split(path.sep).join('/')); })();

/** The module each reason's row lives in (turn-run.ts ROW_LOADERS). */
function rowModules(): Record<string, string> {
  const text = read('src/core/sessions/turn-run.ts');
  const block = text.slice(text.indexOf('const ROW_LOADERS'), text.indexOf('const rows: Rows'));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+): async \(\) => \(await import\('([^']+)'\)\)\.turnRetrier/g)) {
    out[m[1]] = path.posix.normalize(path.posix.join('src/core/sessions', m[2])).replace(/\.js$/, '.ts');
  }
  return out;
}

/** A row whose sends go out through another module of its own. */
const ROW_SENDERS: Partial<Record<TurnRetryReason, string>> = { restart_recovery: 'src/core/sessions/auto-recover-env.ts' };

const rec = (over: Partial<SessionRecord> = {}) => ({ claudeSessionId: 'sess-turn', process_status: 'error', ...over } as SessionRecord);
const row = <R extends TurnRetryReason>(reason: R, over: Partial<TurnRetrier<R>> = {}): TurnRetrier<R> =>
  ({ reason, sources: ['test-retrier'], takes: () => false, wait: () => null, ...over });

describe('every retry kind is a reason with a row', () => {
  it('the reason type and the list agree, and every reason has traits', () => {
    const union = read('src/core/types.ts').match(/export type TurnRetryReason = ([^;]+);/)![1];
    expect(union.split('|').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...TURN_RETRY_REASONS].sort());
    for (const reason of TURN_RETRY_REASONS) expect(TURN_RETRY_TRAITS[reason], reason).toBeDefined();
  });

  it('every reason loads its own row, which names its sources; one that hands the phase back keeps the notices', async () => {
    __resetTurnRunForTesting();
    await loadTurnRetriers();
    const mods = rowModules();
    expect(Object.keys(mods).sort()).toEqual([...TURN_RETRY_REASONS].sort());
    for (const reason of TURN_RETRY_REASONS) {
      const mod = await import(path.join(ROOT, mods[reason]));
      const r = mod.turnRetrier as TurnRetrier;
      expect(r.reason, mods[reason]).toBe(reason);
      expect(r.sources.length, reason).toBeGreaterThan(0);
      if (!TURN_RETRY_TRAITS[reason].keepsPhase) expect(typeof r.keep, `${reason} hands the phase back: its row must keep the turn-end notices`).toBe('function');
    }
  });

  it('every row notes its attempts with its own reason where it sends', () => {
    const mods = rowModules();
    for (const reason of TURN_RETRY_REASONS) {
      const file = ROW_SENDERS[reason] ?? mods[reason];
      expect(read(file), `${file} must note its continue: noteTurnAttempt(sid, '${reason}')`).toMatch(new RegExp(`noteTurnAttempt\\([^)]*'${reason}'\\)`));
    }
  });

  it('a module that hears a turn end and sends into the session is a retry kind with a reason, or says why not', () => {
    // A turn end heard, then a message sent into a session: what every retrier does.
    const NOT_RETRIES: Record<string, string> = {
      'src/providers/claude-code-session.ts': 'the runner itself: it delivers what others send',
      'src/web/routes/session-stream-v1.ts': 'the stream route: a client sends through it',
      'src/core/sessions/lane-turn.ts': 'a side conversation redelivers its own question, not the task turn',
      'src/core/sessions/idle-compaction.ts': 'a quiet compaction of an idle session: no turn failed',
    };
    const mods = new Set([...Object.values(rowModules()), ...Object.values(ROW_SENDERS)]);
    const senders = SRC.filter((f) => {
      const t = read(f);
      return /EventNames\.SESSION_(RESULT|ERROR)\b|'session:(result|error)'/.test(t) && /sendMessageToSession\(|deps\.send\(|enqueueMessage\(/.test(t);
    });
    const unexplained = senders.filter((f) => !mods.has(f) && !NOT_RETRIES[f]);
    expect(unexplained, 'a new retry kind: add its TurnRetryReason and its row (sessions/turn-run.ts), or say here why it is none').toEqual([]);
    expect(Object.keys(NOT_RETRIES).filter((f) => !senders.includes(f)), 'listed but no longer a sender').toEqual([]);
  });
});

describe('readers ask the turn, never a retrier', () => {
  /** A retrier's own answers: only turn-run.ts, the retriers themselves and the files named here may call them. */
  const PREDICATES = /\b(holdsHandBack|recordInEndpointWait|recordInUsageLimit|holdUntilRetried|safeguardSwitchHolds|endpointWaitTakes|usageLimitTakes|willResume|usageLimitOfRecord|ownsStartDeath)\(|\.retryAt\(|contextFullRecovery\(\)\??\.(holds|takes)\(/;
  const ALLOWED: Record<string, string> = {
    // The retriers keep out of each other's turns: auto-continue leaves what the endpoint wait takes.
    'src/core/session-auto-continue.ts': 'a retrier',
    'src/core/sessions/endpoint-wait.ts': 'a retrier',
    'src/core/sessions/endpoint-wait-takes.ts': 'the endpoint wait\'s pure rule',
    'src/core/sessions/usage-limit-wait.ts': 'a retrier',
    'src/core/sessions/usage-limit-model.ts': 'the usage-limit wait\'s pure rule',
    'src/core/session-auto-recover.ts': 'a retrier',
    'src/core/sessions/safeguard-switch.ts': 'a retrier',
    'src/core/sessions/context-full-recovery.ts': 'a retrier',
    'src/core/sessions/turn-run.ts': 'the one reader',
    'src/core/agents/engine-limit-source.ts': 'which engine is out of usage now (a launch falls back to another), not whether a turn is retried',
    'src/core/sessions/task-start.ts': 'a start\'s own handshake with recovery: did it take this start\'s death, before any turn exists',
  };
  it('no reader asks a retrier directly', () => {
    const offenders: string[] = [];
    for (const f of SRC) {
      if (ALLOWED[f]) continue;
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (PREDICATES.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, 'ask sessions/turn-run.ts (turnWaitOf, turnEndTakenBy, holdTurnEndNotices, ...) instead').toEqual([]);
    for (const f of Object.keys(ALLOWED)) expect(SRC, f).toContain(f);
  });

  it('the turn-end hook holds in one place, with no retry kind named', () => {
    const hook = read('src/core/session-hooks/builtins.ts');
    expect(hook).toMatch(/holdTurnEndNotices\(record,/);
    expect(hook).not.toMatch(/turn-end notices held: the (endpoint|usage-limit)|restart recovery continues this session|Walnut retries this turn|the safeguard switch moves/);
  });
});

describe('the turn record answers every reader the same way', () => {
  afterEach(async () => {
    for (const reason of TURN_RETRY_REASONS) await __setTurnRetrierForTesting(reason, null);
  });

  it.each(TURN_RETRY_REASONS)('%s: held notices, the kept phase and mid-work follow its traits', async (reason) => {
    const replays: Array<() => void> = [];
    await __setTurnRetrierForTesting(reason, row(reason, {
      takes: (end) => end.isError,
      wait: () => ({ reason } as never),
      keep: (_sid, replay) => { replays.push(replay); return true; },
    }));
    const t = TURN_RETRY_TRAITS[reason];
    expect((await turnRunOf(rec(), { failed: true })).wait?.reason).toBe(reason);
    expect(await holdTurnEndNotices(rec(), { failed: true }, () => {})).toBe(reason);
    expect(replays.length).toBe(t.keepsPhase ? 0 : 1);
    expect(await turnEndTakenBy({ event: 'result', sessionId: 'sess-turn', isError: true })).toBe(reason);
    expect(await turnEndTakenBy({ event: 'result', sessionId: 'sess-turn', isError: false })).toBeNull();
    expect(await turnEndKeepsPhase({ event: 'result', sessionId: 'sess-turn', isError: true })).toBe(t.keepsPhase ? reason : null);
    expect(await turnMidWork(rec())).toBe(t.midWork ? reason : null);
  });

  it('a row that hands the phase back and cannot keep the notice holds nothing', async () => {
    await __setTurnRetrierForTesting('auto_continue', row('auto_continue', { wait: () => ({ reason: 'auto_continue', retryAt: new Date().toISOString() }), keep: () => false }));
    expect(await holdTurnEndNotices(rec(), {}, () => {})).toBeNull();
  });

  it('two at once: the first reason answers, and every one is listed', async () => {
    await __setTurnRetrierForTesting('restart_recovery', row('restart_recovery', { wait: () => ({ reason: 'restart_recovery' }) }));
    await __setTurnRetrierForTesting('usage_limit', row('usage_limit', { wait: () => ({ reason: 'usage_limit', usageLimit: { state: 'waiting', engine: 'claude', since: 'x', resumes: 0, tries: 0 } }) }));
    const run = await turnRunOf(rec(), { failed: true });
    expect(run.wait?.reason).toBe('usage_limit');
    expect(run.waits.map((w) => w.reason)).toEqual(['usage_limit', 'restart_recovery']);
  });

  it('a row that throws holds nothing and does not stop the others', async () => {
    await __setTurnRetrierForTesting('usage_limit', row('usage_limit', { wait: () => { throw new Error('boom'); }, takes: () => { throw new Error('boom'); } }));
    await __setTurnRetrierForTesting('endpoint_wait', row('endpoint_wait', { takes: () => true }));
    expect((await turnRunOf(rec())).wait).toBeNull();
    expect(await turnEndTakenBy({ event: 'result', sessionId: 'sess-turn', isError: true })).toBe('endpoint_wait');
  });
});

describe('the attempts of a turn', () => {
  beforeEach(async () => {
    _resetSessionTrackerForTesting();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
  });
  afterEach(() => { __resetTurnRunForTesting(); _resetSessionTrackerForTesting(); });

  it('a retrier\'s continue is an attempt; a send by anyone else starts a new turn', async () => {
    await createSessionRecord('sess-attempts', '', 'demo');
    const handle = await startTurnRun();
    try {
      await noteTurnAttempt('sess-attempts', 'endpoint_wait', '2026-11-14T08:00:00.000Z');
      await noteTurnAttempt('sess-attempts', 'auto_continue', '2026-11-14T08:05:00.000Z');
      const after = await getSessionByClaudeId('sess-attempts');
      expect(after?.turn).toEqual({ since: '2026-11-14T08:00:00.000Z', attempts: [
        { reason: 'endpoint_wait', at: '2026-11-14T08:00:00.000Z' }, { reason: 'auto_continue', at: '2026-11-14T08:05:00.000Z' },
      ] });
      expect((await turnRunOf(after!)).attempts).toHaveLength(2);

      // The retrier's own send (its source) is not a new turn.
      bus.emit(EventNames.SESSION_SEND, { sessionId: 'sess-attempts', message: 'continue' }, ['session-runner'], { source: 'auto-continue' });
      await new Promise((r) => setTimeout(r, 30));
      expect((await getSessionByClaudeId('sess-attempts'))?.turn?.attempts).toHaveLength(2);

      // A person's message starts a new turn.
      bus.emit(EventNames.SESSION_SEND, { sessionId: 'sess-attempts', message: 'hi' }, ['session-runner'], { source: 'ui' });
      for (let i = 0; i < 50 && (await getSessionByClaudeId('sess-attempts'))?.turn; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await getSessionByClaudeId('sess-attempts'))?.turn).toBeUndefined();
    } finally {
      handle.stop();
    }
  });

  it('never throws, even for a session that is not there', async () => {
    await expect(noteTurnAttempt('sess-none', 'usage_limit')).resolves.toBeUndefined();
  });
});
