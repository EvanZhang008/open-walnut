/**
 * A turn that ended on "Prompt is too long" answered nothing, so nothing may treat its end as the end
 * of the work: not a close, not a hand-on, not a quote of it as the answer.
 *
 * 2026-11-06 (task f081a055): Walnut restarted while it compacted a session that had overflowed; the
 * compaction finished in its host meanwhile, the old boot rule failed the recovery, the task was handed
 * back, its asker was told "Prompt is too long" as if that were the reply, and nothing was resent for
 * six hours. The recovery now looks for that compaction in its host (context-full.test.ts), and every
 * place that acts on a turn's end waits while the recovery holds the session.
 *
 * The source guard lists every file that listens for a turn's end and writes a completion, with how it
 * waits; a new one fails until it waits too.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { bus, EventNames } from '../../../src/core/event-bus.js';
import { startContextFullRecovery } from '../../../src/core/sessions/context-full-recovery.js';
import { turnHold } from '../../../src/core/sessions/turn-end-wait.js';
import { startTriageRuns } from '../../../src/core/triage/runs.js';
import { resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js';
import { TRIAGE_PROJECT } from '../../../src/core/triage/bootstrap.js';
import { lastWordsOf, CONTEXT_FULL_NOTICE_WORDS } from '../../../src/core/sessions/session-request-notify.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import type { SessionRecord, Task } from '../../../src/core/types.js';

const ROOT = path.resolve(__dirname, '../../..');
const SID = 'ptl-guard-session';

/** Every file that listens for a turn's end and writes a completion, and how it waits for the recovery. */
const WAITS: Record<string, { how: RegExp; why: string }> = {
  'src/core/triage/runs.ts': { how: /turnEndAnsweredNothing\(/, why: 'a triage run settles on its session result: not on one the recovery holds' },
  'src/core/org/handover-close.ts': { how: /TurnEndWait/, why: 'waits through turnHold, which reads the recovery' },
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

let stops: Array<() => void> = [];
// A run's quiet turn outlives a stopped recovery: each case starts with none.
afterEach(() => { for (const s of stops) s(); stops = []; resetQuietTurnsForTest(); });

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) { if (done()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};
const pause = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10)); };

function startRecovery(opts: { sendFails?: boolean } = {}): void {
  let rec = { claudeSessionId: SID, taskId: 't-run', process_status: 'idle' } as SessionRecord;
  const handle = startContextFullRecovery({
    getSession: async () => rec,
    saveSession: async (_id, updates) => { rec = { ...rec, ...updates }; },
    send: async () => { if (opts.sendFails) throw new Error('queue refused'); },
    stopFence: async () => null,
    taskOpen: async () => true,
    deleteQueued: async () => true,
    emitNote: () => {},
    announce: () => {},
    announceState: () => {},
    gaveUp: async () => {},
    compactedSince: async () => null,
  });
  stops.push(handle.stop);
}

describe('a turn that ended on "Prompt is too long" is not the end of the work', () => {
  it('every turn-end listener that completes a task waits for the recovery', () => {
    const files: string[] = [];
    walk(path.join(ROOT, 'src'), files);
    const members = files
      .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }))
      .filter(({ text }) => /EventNames\.SESSION_RESULT|'session:result'|onTurnComplete|TurnEndWait/.test(text))
      .filter(({ text }) => /phase: 'COMPLETE'|\bcompleteTask\(/.test(text));
    const missing = members.filter((m) => !WAITS[m.rel]).map((m) => m.rel);
    expect(missing, 'wait for the context recovery (turnEndAnsweredNothing, or turnHold / TurnEndWait) and list the file here').toEqual([]);
    for (const m of members) expect(WAITS[m.rel].how.test(m.text), m.rel).toBe(true);
    expect(Object.keys(WAITS).filter((f) => !members.some((m) => m.rel === f))).toEqual([]);
    // turnHold is where the TurnEndWait users (handover-close, team-stop, self-complete-stop,
    // engine-switch, lifecycle waits) read the recovery.
    expect(readFileSync(path.join(ROOT, 'src/core/sessions/turn-end-wait.ts'), 'utf8')).toMatch(/await turnMidWork\(rec\)/);
  });

  it('turnHold reads a session the recovery compacts as mid-turn', async () => {
    startRecovery();
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 't-run', isError: true, result: 'Prompt is too long' }, ['main-ai']);
    await pause();
    expect(await turnHold({ claudeSessionId: SID, process_status: 'idle' } as SessionRecord, { queue: false })).toBe('turn');
    expect(await turnHold({ claudeSessionId: 'another', process_status: 'idle' } as SessionRecord, { queue: false })).toBe('free');
  });

  it('a triage run is not settled on a "Prompt is too long" result, and is on the turn that answers', async () => {
    startRecovery();
    const completed: string[] = [];
    const run = { id: 't-run', title: 'Triage · 14:10', project: TRIAGE_PROJECT, agent_id: 'triage', phase: 'IN_PROGRESS',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as unknown as Task;
    const triage = startTriageRuns({
      home: WALNUT_HOME, listRunTaskIds: async () => ['t-run'], getTask: async () => run,
      completeTask: async (id) => { completed.push(id); }, appendJournal: async () => 'notes/x.md',
      recordOutcome: async () => undefined, withdrawSuperseded: async () => ({ withdrawn: [], kept: 0, failed: 0 }),
    });
    stops.push(() => triage.stop());
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 't-run', isError: true, result: 'Prompt is too long' }, ['main-ai']);
    await pause();
    expect(completed).toEqual([]);
    // The turn that answers (a later session turn, here another session of the run) settles it.
    bus.emit(EventNames.SESSION_RESULT, { sessionId: 'ptl-guard-answer', taskId: 't-run', isError: false, result: 'done' }, ['main-ai']);
    await until(() => completed.length > 0, 'the run to settle');
    expect(completed).toEqual(['t-run']);
  });

  it('a triage run the recovery gave up on settles as that error', async () => {
    startRecovery({ sendFails: true });
    const completed: string[] = [];
    const outcomes: unknown[] = [];
    const run = { id: 't-run', title: 'Triage · 14:10', project: TRIAGE_PROJECT, agent_id: 'triage', phase: 'IN_PROGRESS',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as unknown as Task;
    const triage = startTriageRuns({
      home: WALNUT_HOME, listRunTaskIds: async () => ['t-run'], getTask: async () => run,
      completeTask: async (id) => { completed.push(id); }, appendJournal: async () => 'notes/x.md',
      recordOutcome: async (entry) => { outcomes.push(entry); }, withdrawSuperseded: async () => ({ withdrawn: [], kept: 0, failed: 0 }),
    });
    stops.push(() => triage.stop());
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 't-run', isError: true, result: 'Prompt is too long' }, ['main-ai']);
    await until(() => completed.length > 0, 'the run to settle after the recovery failed');
    expect(completed).toEqual(['t-run']);
  });

  it('a notice never quotes "Prompt is too long" as what the session said', () => {
    const words = lastWordsOf([
      { role: 'user', text: 'reply to my request please' },
      { role: 'assistant', text: 'Prompt is too long' },
    ] as never);
    expect(words?.text).toBe(CONTEXT_FULL_NOTICE_WORDS);
    expect(lastWordsOf([{ role: 'user', text: 'x' }, { role: 'assistant', text: 'here is the result' }] as never)?.text).toBe('here is the result');
  });
});
