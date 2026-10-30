/**
 * The engine switch inside a task (src/core/sessions/engine-switch.ts) over the
 * real task, session, queue and request stores. Only the edges that would start
 * or stop a CLI, or read a host's files, are stubbed; they record what they were
 * asked, so these tests pin what a switch leaves behind: which session is the
 * task's, what the new session's first message carries, where the queued rows
 * and open requests go, and that a failed start puts everything back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const edges = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  stops: [] as string[],
  writes: [] as Array<{ host: string; path: string; content: string }>,
  failStart: false,
  nextSid: 0,
  history: {} as Record<string, Array<Record<string, unknown>>>,
  gate: undefined as Promise<void> | undefined,
  /** What a remote host says it can run (core/agents/host-engines.ts). */
  hostEngines: {} as Record<string, Record<string, { installed: boolean; version: string | null; reason: string | null }>>,
}));
vi.mock('../../../src/core/agents/host-engines.js', () => ({
  hostEngineAvailability: async (host: string, engine: string) => edges.hostEngines[host]?.[engine] ?? null,
}));

vi.mock('../../../src/constants.js', () => createMockConstants('engine-switch'));
vi.mock('../../../src/utils/process.js', () => ({ isProcessAlive: () => true, isProcessAliveAsync: async () => true }));
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    constructor(private host: string) {}
    async writeFile(path: string, content: string) { edges.writes.push({ host: this.host, path, content }); }
    async readFileBytes() { return null; }
  },
}));
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', () => ({
  findTranscript: async () => ({ kind: 'none' }),
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  readProviderSessionHistory: async (sid: string) => ({ messages: edges.history[sid] ?? [] }),
  terminateSession: async (sid: string) => {
    edges.stops.push(sid);
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(sid, { process_status: 'stopped' } as never);
  },
}));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async (params: Record<string, unknown>) => {
    edges.starts.push(params);
    if (edges.gate) await edges.gate;
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    const sid = `new-sid-${++edges.nextSid}`;
    // A start that fails after its row exists: the restore must clear it.
    await createSessionRecord(sid, String(params.taskIdPrefix), 'Marina', String(params.cwd ?? '/work/repo'));
    await updateSessionRecord(sid, {
      engine: params.engine, process_status: 'idle', messageCount: 1,
      // An ACP adapter that can load an old session says so at initialize.
      ...(params.engine !== 'claude' ? { acpCapabilities: { loadSession: params.engine !== 'gemini' } } : {}),
    } as never);
    if (edges.failStart) throw new Error('engine would not start');
    return { started: true, sessionId: sid };
  },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import { requestEngineSwitch, cancelPendingSwitch, activeSessionFor } from '../../../src/core/sessions/engine-switch.js';
import { resumeEngineSwitches } from '../../../src/core/sessions/engine-switch-watch.js';
import { linkSession, updateTaskRaw } from '../../../src/core/task-manager.js';
import { taskConversation } from '../../../src/core/sessions/task-session-claim.js';
import { createSessionRequest, getSessionRequest } from '../../../src/core/session-requests.js';
import { getStore, mutateStore } from '../../../src/core/session-queue-store.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';

beforeEach(async () => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  edges.starts.length = 0; edges.stops.length = 0; edges.writes.length = 0;
  edges.failStart = false; edges.history = {};
  // The queue store keeps a copy in memory: a row an earlier test left (no runner consumes it here) must not make this one busy.
  await mutateStore((st) => { st.queues = {}; }, false, true);
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 30));
  closeTaskDb(); closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

const HISTORY = [
  { role: 'user', text: 'Very old work before the compaction', timestamp: '2026-10-20T09:00:00Z' },
  // The CLI's shape: a compact boundary row, then its summary as an injected user line.
  { role: 'system', systemVariant: 'compact', text: 'Context compacted', timestamp: '2026-10-20T09:30:00Z' },
  { role: 'user', injected: true, text: 'Summary: the parser work is half done.', timestamp: '2026-10-20T09:30:01Z' },
  { role: 'user', text: 'Make the parser accept trailing commas', timestamp: '2026-10-20T10:00:00Z' },
  {
    role: 'assistant', text: 'Done in src/parser.ts; the magic word is PELICAN.', timestamp: '2026-10-20T10:01:00Z',
    tools: [{ name: 'Bash', input: { command: 'bun test parser' }, result: '12 pass' }],
  },
];

async function taskOn(engine: string, opts: { status?: string; host?: string } = {}): Promise<{ taskId: string; sid: string }> {
  const { task } = await addTask({ title: 'Fix the parser', project: 'Marina', cwd: '/work/repo' } as never);
  const sid = `old-${engine}-sid`;
  await createSessionRecord(sid, task.id, 'Marina', '/work/repo');
  await updateSessionRecord(sid, {
    engine: engine === 'claude' ? undefined : engine, process_status: opts.status ?? 'idle', messageCount: 4,
    ...(opts.host ? { host: opts.host } : {}),
  } as never);
  edges.history[sid] = HISTORY;
  return { taskId: task.id, sid };
}

describe('engine switch inside a task', () => {
  it('Claude Code to Codex: a new session in the same task carries the context; the old one is history', async () => {
    const { taskId, sid } = await taskOn('claude');
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Run the tests first.', source: 'test' });

    expect(res).toMatchObject({ state: 'done', fromSessionId: sid, engine: 'codex', host: '__local__', trimmedTurns: 0 });
    const newSid = res.sessionId!;
    expect(edges.stops).toEqual([sid]);
    const [start] = edges.starts;
    expect(start).toMatchObject({ taskIdPrefix: taskId, engine: 'codex', cwd: '/work/repo', source: 'engine-switch' });
    const message = String(start.message);
    // Only what the old session held: the summary and every turn after it, tools included.
    expect(message).toContain('Summary: the parser work is half done.');
    expect(message).toContain('the magic word is PELICAN');
    expect(message).toContain('bun test parser');
    expect(message).not.toContain('Very old work before the compaction');
    expect(message).toContain('Walnut (engine-switch)');
    expect(message.trimEnd().endsWith('Run the tests first.')).toBe(true);
    // The whole task's transcript, before the compaction too, is written beside it.
    const transcript = edges.writes.find((w) => w.path.endsWith('/transcript.md'))!;
    expect(transcript.path).toContain(`-transfers/${res.switchId}/`);
    expect(transcript.content).toContain('Very old work before the compaction');
    expect(message).toContain(transcript.path);

    const old = await getSessionByClaudeId(sid);
    expect(old).toMatchObject({ taskId, archived: true, archive_reason: 'engine_switched:codex', supersededBy: newSid });
    const fresh = await getSessionByClaudeId(newSid);
    expect(fresh?.engineSwitch).toMatchObject({ fromSessionId: sid, carriedTurns: 1, trimmedTurns: 0, compacted: true });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(newSid);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', session_id: newSid, carried_turns: 1 });
    // A message addressed to the replaced session reaches the task's active one.
    expect(await activeSessionFor(sid)).toBe(newSid);
  });

  it('a round trip back to Claude Code resumes the first session with only the turns it missed', async () => {
    const { taskId, sid } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'test' });
    expect((await getSessionByClaudeId(sid))?.leftContext?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    edges.history[first.sessionId!] = [
      { role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] },
      { role: 'assistant', text: 'Codex ran the suite: green.', timestamp: '2026-10-20T11:05:00Z' },
    ];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back to Claude Code.', displayText: 'Back to Claude Code.', by: undefined, source: 'test' } as never);

    expect(back).toMatchObject({ state: 'done', engine: 'claude', fromSessionId: first.sessionId, sessionId: sid, resumed: true, carriedTurns: 1 });
    expect(edges.starts).toHaveLength(1); // no new session: the first one resumes
    const resumed = await getSessionByClaudeId(sid);
    expect(resumed?.archived).toBeFalsy();
    expect(resumed?.resumedBySwitch).toMatchObject({ fromSessionId: first.sessionId, carriedTurns: 1 });
    expect((await getSessionByClaudeId(first.sessionId!))).toMatchObject({ archive_reason: 'engine_switched:claude', supersededBy: sid });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', resumed: true, session_id: sid });
    // Its message carries Codex's own turns only, never what it already holds.
    const row = (await getStore()).queues[sid]?.at(-1);
    expect(row?.message).toContain('Codex ran the suite: green.');
    expect(row?.message).not.toContain('carried: the magic word is PELICAN');
    expect(row?.message.trimEnd().endsWith('Back to Claude Code.')).toBe(true);
    expect(await activeSessionFor(first.sessionId!)).toBe(sid);
  });

  it('ping-pong: each switch back resumes that engine\'s session, given only the turns since it left', async () => {
    const { taskId, sid } = await taskOn('claude');
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'test' })).sessionId!;
    edges.history[codex] = [
      { role: 'user', text: 'On Codex.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'claude context' }] },
      { role: 'assistant', text: 'codex turn one', timestamp: '2026-10-20T11:01:00Z' },
    ];
    expect((await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back on Claude.', source: 'test' })).sessionId).toBe(sid);
    // The resumed session takes its message (no runner here: the row is consumed by hand).
    await mutateStore((st) => { delete st.queues[sid]; }, false, true);
    // What the resumed Claude session now holds: its old context, the resume message, a new turn.
    edges.history[sid] = [
      ...HISTORY,
      { role: 'user', text: 'Back on Claude.', timestamp: '2026-10-20T12:00:00Z', hints: [{ kind: 'engine-switch', text: 'codex turn one' }] },
      { role: 'assistant', text: 'claude turn two', timestamp: '2026-10-20T12:01:00Z' },
    ];
    const again = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Codex again.', source: 'test' });
    expect(again).toMatchObject({ resumed: true, sessionId: codex, carriedTurns: 1 });
    // (The earlier resume message, never consumed here, moved along as a held row.)
    const row = (await getStore()).queues[codex]?.find((r) => r.message.includes('Codex again.'))?.message ?? '';
    expect(row).toContain('claude turn two');
    expect(row).toContain('Back on Claude.');
    expect(row).not.toContain('the magic word is PELICAN'); // Codex already holds it
    expect(edges.starts).toHaveLength(1);
  });

  it('an engine that cannot load an old session (Gemini) gets a new session on the way back', async () => {
    const { taskId } = await taskOn('claude');
    const gem = (await requestEngineSwitch({ taskId, engine: 'gemini', message: 'On Gemini.', source: 'test' })).sessionId!;
    edges.history[gem] = [{ role: 'user', text: 'On Gemini.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'gemini ok', timestamp: '2026-10-20T11:01:00Z' }];
    await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back.', source: 'test' });
    const again = await requestEngineSwitch({ taskId, engine: 'gemini', message: 'Gemini again.', source: 'test' });
    expect(again.resumed).toBeUndefined();
    expect(again.sessionId).not.toBe(gem);
  });

  it('a session whose message is still queued counts as in a turn: the switch waits', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-w', sessionId: sid, message: 'not delivered yet', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'After it.', source: 'test' });
    expect(res.state).toBe('pending');
    expect(edges.starts).toHaveLength(0);
  });

  it('a restart in the middle of a resume still sends its message, once', async () => {
    const { taskId, sid } = await taskOn('claude');
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'test' })).sessionId!;
    // The state a crash left: the earlier session is the task's again, its message not queued.
    await updateSessionRecord(codex, { archived: true, archive_reason: 'engine_switched:claude' } as never);
    await updateSessionRecord(sid, { archived: false, archive_reason: undefined, supersededBy: undefined } as never);
    await linkSession(taskId, sid);
    await updateTaskRaw(taskId, {
      engine_switch: {
        id: 'es-crash', state: 'switching', at: new Date().toISOString(), from_session_id: codex, to: { engine: 'claude', host: '__local__' },
        message: 'Back.', resume_session_id: sid, resume_message: 'HINTED Back.', by: 'human',
      },
    } as never, { source: 'test' });
    await resumeEngineSwitches();
    await resumeEngineSwitches();
    const rows = ((await getStore()).queues[sid] ?? []).filter((r) => r.message.includes('HINTED Back.'));
    expect(rows).toHaveLength(1);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', resumed: true, session_id: sid });
  });

  it('a session whose history changed since the task left it is not resumed: a new session carries the context', async () => {
    const { taskId, sid } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'test' });
    edges.history[first.sessionId!] = [{ role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'Codex ran the suite: green.', timestamp: '2026-10-20T11:05:00Z' }];
    edges.history[sid] = [...HISTORY, { role: 'user', text: 'someone wrote here later', timestamp: '2026-10-20T12:00:00Z' }];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back to Claude Code.', source: 'test' });
    expect(back.resumed).toBeUndefined();
    expect(back.sessionId).not.toBe(sid);
    expect(edges.starts).toHaveLength(2);
    expect(String(edges.starts[1].message)).toContain('Codex ran the suite: green.');
  });

  it('a later compaction, or another model, starts a new session instead of resuming', async () => {
    const { taskId } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'test' });
    edges.history[first.sessionId!] = [{ role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'ok', timestamp: '2026-10-20T11:05:00Z' }];
    await updateSessionRecord('old-claude-sid', { cliModel: 'claude-opus-5-5' } as never);
    const other = await requestEngineSwitch({ taskId, engine: 'claude', model: 'claude-sonnet-5-5', message: 'Back.', source: 'test' });
    expect(other.resumed).toBeUndefined();

    // A Claude session that compacted after it took over is not a prefix any more either.
    const { task } = await addTask({ title: 'Compacted', project: 'Marina', cwd: '/work/repo' } as never);
    await createSessionRecord('codex-a', task.id, 'Marina', '/work/repo');
    await updateSessionRecord('codex-a', { engine: 'codex', process_status: 'idle', messageCount: 2 } as never);
    edges.history['codex-a'] = [{ role: 'user', text: 'start on codex', timestamp: '2026-10-20T09:00:00Z' }, { role: 'assistant', text: 'ok', timestamp: '2026-10-20T09:01:00Z' }];
    const toClaude = await requestEngineSwitch({ taskId: task.id, engine: 'claude', message: 'On Claude.', source: 'test' });
    edges.history[toClaude.sessionId!] = HISTORY; // holds a compaction
    const backToCodex = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Back to Codex.', source: 'test' });
    expect(backToCodex.resumed).toBeUndefined();
    expect(backToCodex.sessionId).not.toBe('codex-a');
  });

  it('a message for the old session while the switch runs waits and lands in the new session', async () => {
    const { taskId, sid } = await taskOn('claude');
    let release!: () => void;
    edges.gate = new Promise<void>((r) => { release = r; });
    const run = requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'test' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1));
    const addressed = activeSessionFor(sid);
    // A second pick while it runs is refused, never dropped silently.
    await expect(requestEngineSwitch({ taskId, engine: 'gemini', message: 'x', source: 'test' })).rejects.toMatchObject({ code: 'switch_in_progress' });
    release();
    const res = await run;
    expect(await addressed).toBe(res.sessionId);
    edges.gate = undefined;
  });

  it('queued rows and open requests move to the new session', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      // A row parked on it (a delivery that failed): it waits for the session, not in it.
      s.queues[sid] = [{ id: 'qm-1', sessionId: sid, message: 'queued while idle', status: 'parked', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const asked = await createSessionRequest({ fromSessionId: 'leader-sid', toSessionId: sid, text: 'Reply when done' });
    const owed = await createSessionRequest({ fromSessionId: sid, toSessionId: 'worker-sid', text: 'Check the build' });

    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'test' });
    const store = await getStore();
    expect(store.queues[sid]).toBeUndefined();
    expect(store.queues[res.sessionId!]?.map((r) => r.message)).toEqual(['queued while idle']);
    expect((await getSessionRequest(asked.id))?.toSessionId).toBe(res.sessionId);
    expect((await getSessionRequest(owed.id))?.fromSessionId).toBe(res.sessionId);
  });

  it('a failed start puts everything back: the old session is the task\'s session again, with its rows', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-2', sessionId: sid, message: 'keep me', status: 'parked', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    edges.failStart = true;
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'test' }))
      .rejects.toMatchObject({ code: 'start_failed', status: 502 });

    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect(old?.archive_reason).toBeUndefined();
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    expect((await getStore()).queues[sid]?.map((r) => r.message)).toEqual(['keep me']);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed' });
    expect(String((await getTask(taskId)).engine_switch?.error)).toContain('engine would not start');
  });

  it('a pick made mid-turn waits for the turn to end, then runs by itself', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'After this turn.', displayText: 'After this turn.', source: 'test' });
    expect(res.state).toBe('pending');
    expect(edges.starts).toHaveLength(0);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'pending', from_session_id: sid, message: 'After this turn.' });

    await updateSessionRecord(sid, { process_status: 'idle' } as never);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: sid, process_status: 'idle' }, ['test'], { source: 'test' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1), { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => expect((await getTask(taskId)).engine_switch?.state).toBe('done'), { timeout: 5_000, interval: 100 });
    expect(String(edges.starts[0].message).trimEnd().endsWith('After this turn.')).toBe(true);
    expect((await getTask(taskId)).engine_switch?.message).toBeUndefined();
  }, 20_000);

  it('a pending switch can be cancelled, and a cancelled one never runs when the turn ends', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Later.', source: 'test' });
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Again.', source: 'test' })).rejects.toMatchObject({ code: 'switch_pending' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: true });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', error: 'cancelled' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: false });
    await updateSessionRecord(sid, { process_status: 'idle' } as never);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: sid, process_status: 'idle' }, ['test'], { source: 'test' });
    await new Promise((r) => setTimeout(r, 4_000));
    expect(edges.starts).toHaveLength(0);
  }, 15_000);

  it('a failed switch keeps the message until the user sends it here or lets it go', async () => {
    const { taskId } = await taskOn('claude');
    edges.failStart = true;
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Keep this.', source: 'test' }).catch(() => {});
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', message: 'Keep this.' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: true });
    expect((await getTask(taskId)).engine_switch?.message).toBeUndefined();
  });

  it('refuses the same engine, and an engine the task\'s host cannot run; a switch never moves the work', async () => {
    const local = await taskOn('claude');
    await expect(requestEngineSwitch({ taskId: local.taskId, engine: 'claude', message: 'x', source: 'test' }))
      .rejects.toMatchObject({ code: 'same_engine', status: 400 });
    await expect(requestEngineSwitch({ taskId: local.taskId, engine: 'codex', message: '  ', source: 'test' }))
      .rejects.toMatchObject({ code: 'message_required' });

    const { task } = await addTask({ title: 'Remote work', project: 'Marina', cwd: '/home/me/repo' } as never);
    await createSessionRecord('remote-sid', task.id, 'Marina', '/home/me/repo');
    await updateSessionRecord('remote-sid', { process_status: 'idle', host: 'devbox', messageCount: 2 } as never);
    edges.hostEngines = { devbox: { codex: { installed: false, version: null, reason: 'codex is not installed' } } };
    await expect(requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'x', source: 'test' }))
      .rejects.toMatchObject({ code: 'engine_not_on_host', status: 409, message: expect.stringContaining('not available on devbox: codex is not installed') });
    await expect(requestEngineSwitch({ taskId: task.id, engine: 'custom', message: 'x', source: 'test' }))
      .rejects.toMatchObject({ code: 'engine_not_on_host', status: 409 });
    expect(edges.starts).toHaveLength(0);

    // The host has it: the new session starts THERE, in the same directory.
    edges.hostEngines = { devbox: { codex: { installed: true, version: '1', reason: null } } };
    const res = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Go on.', source: 'test' });
    expect(res).toMatchObject({ state: 'done', host: 'devbox' });
    expect(edges.starts[0]).toMatchObject({ engine: 'codex', host: 'devbox', cwd: '/home/me/repo' });
    edges.hostEngines = {};
  });

  it('a task with no conversation yet just starts on the engine', async () => {
    const { task } = await addTask({ title: 'Fresh', project: 'Marina' } as never);
    const res = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Hello', source: 'test' });
    expect(res.state).toBe('done');
    expect(edges.starts[0]).toMatchObject({ engine: 'codex', message: 'Hello' });
  });
});
