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
  failBeforeRow: false,
  /** What a failed start throws (default: a plain error). */
  failWith: undefined as unknown,
  /** The setting that refuses a Codex start on the host (codex-engine-source.ts codexStartRefusal); unset: none. */
  codexRefusal: undefined as Error | undefined,
  /** The old session's history cannot be read (a remote host dropped). */
  failHistory: false,
  nextSid: 0,
  /** Each history read, and whether that session was stopped by then. */
  reads: [] as Array<{ sid: string; stopped: boolean }>,
  /** Sessions whose process a stop cannot end. */
  stuck: new Set<string>(),
  history: {} as Record<string, Array<Record<string, unknown>>>,
  gate: undefined as Promise<void> | undefined,
  /** Sessions whose finished turn left a background command running. */
  outlives: new Set<string>(),
  /** What a remote host says it can run (core/agents/host-engines.ts). */
  hostEngines: {} as Record<string, Record<string, { installed: boolean; version: string | null; reason: string | null }>>,
}));
vi.mock('../../../src/providers/claude-code-session.js', async (orig) => {
  const real = await orig<typeof import('../../../src/providers/claude-code-session.js')>();
  // Only the one question the switch asks the live runner: does its finished turn leave work running?
  const sessionRunner = new Proxy(real.sessionRunner, {
    get: (t, k, r) => (k === 'hasWorkOutlivingTurn' ? (sid: string) => edges.outlives.has(sid)
      // A session in `outlives` has ended its model turn; the rest have no runner here.
      : k === 'isInTurn' ? (sid: string) => (edges.outlives.has(sid) ? false : null)
      : Reflect.get(t, k, r)),
  });
  return { ...real, sessionRunner };
});
vi.mock('../../../src/core/agents/host-engines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/agents/host-engines.js')>()),
  hostEngineAvailability: async (host: string, engine: string) => edges.hostEngines[host]?.[engine] ?? null,
}));

vi.mock('../../../src/providers/codex-engine-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/codex-engine-source.js')>()),
  codexStartRefusal: async () => edges.codexRefusal ?? null,
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
  // The transcript, written in parts under the run's link wait.
  writeFileInParts: async (host: string, path: string, bytes: Buffer) => { edges.writes.push({ host, path, content: bytes.toString('utf8') }); },
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  readProviderSessionHistory: async (sid: string) => {
    if (edges.failHistory) throw new Error('the host dropped the connection');
    edges.reads.push({ sid, stopped: edges.stops.includes(sid) });
    return { messages: edges.history[sid] ?? [] };
  },
  // The real result shape: a confirmed stop reads `terminated`; a stuck one stays `pending`.
  terminateSession: async (sid: string) => {
    edges.stops.push(sid);
    if (edges.stuck.has(sid)) return { status: 'pending', sessionId: sid };
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(sid, { process_status: 'stopped' } as never);
    return { status: 'terminated', sessionId: sid };
  },
}));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async (params: Record<string, unknown>) => {
    edges.starts.push(params);
    if (edges.gate) await edges.gate;
    if (edges.failBeforeRow) throw new Error('engine would not start');
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    const sid = `new-sid-${++edges.nextSid}`;
    // A start that fails after its row exists: the restore must clear it.
    await createSessionRecord(sid, String(params.taskIdPrefix), 'Marina', String(params.cwd ?? '/work/repo'));
    await updateSessionRecord(sid, {
      engine: params.engine, process_status: 'idle', messageCount: 1,
      // An ACP adapter that can load an old session says so at initialize.
      ...(params.engine !== 'claude' ? { acpCapabilities: { loadSession: params.engine !== 'gemini' } } : {}),
    } as never);
    if (edges.failStart) throw edges.failWith ?? new Error('engine would not start');
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
import { requestEngineSwitch, cancelPendingSwitch, activeSessionFor, runEngineSwitch } from '../../../src/core/sessions/engine-switch.js';
import {
  resumeEngineSwitches, watchPendingSwitch, pendingVerdict,
  SWITCH_BACKGROUND_GRACE_MS, SWITCH_PENDING_MAX_MS,
} from '../../../src/core/sessions/engine-switch-watch.js';
import { BACKGROUND_CUT_NOTE, TURN_CUT_NOTE } from '../../../src/core/sessions/engine-switch.js';
import { sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { parseHinted } from '../../../src/core/hints/hint-format.js';
import { transcriptSentBy } from '../../../src/core/sessions/transcript-sent-by.js';
import { frameStartText } from '../../../src/core/sessions/send-frame.js';
import { linkSession, updateTaskRaw } from '../../../src/core/task-manager.js';
import { taskConversation } from '../../../src/core/sessions/task-session-claim.js';
import { createSessionRequest, getSessionRequest } from '../../../src/core/session-requests.js';
import { getStore, mutateStore, readQueueFileFresh } from '../../../src/core/session-queue-store.js';
import { takeQueuedRows } from '../../../src/core/sessions/engine-switch-io.js';
import { resetTransitState, settleStrandedTransits } from '../../../src/core/session-queue-transit.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { __setOwnerViewForTesting, type OwnerView } from '../../../src/core/sessions/replaced-session.js';

/** What each session's owning daemon says of its CLI; absent = no answer (the record decides). */
const owner = new Map<string, OwnerView>();

beforeEach(async () => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  edges.starts.length = 0; edges.stops.length = 0; edges.writes.length = 0;
  edges.reads.length = 0; edges.stuck.clear(); edges.failStart = false; edges.failWith = undefined; edges.failBeforeRow = false; edges.failHistory = false; edges.history = {}; edges.outlives.clear(); edges.codexRefusal = undefined;
  // The queue store keeps a copy in memory: a row an earlier test left (no runner consumes it here) must not make this one busy.
  await mutateStore((st) => { st.queues = {}; }, false, true);
  owner.clear();
  __setOwnerViewForTesting(async (rec) => owner.get(rec.claudeSessionId) ?? null);
});

afterEach(async () => {
  __setOwnerViewForTesting(null);
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
  it.each(['task-move', 'automation:ticket-import', 'new-automation'])('a generated handoff from %s is never a person', async (source) => {
    const { taskId } = await taskOn('claude');
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Your task moved. Carry on.', source });
    const text = String(edges.starts[0].message);
    expect(transcriptSentBy({ role: 'user', text: parseHinted(text).text })).toBe('agent');
    expect(text).toContain(source.startsWith('automation:') ? source.replace('automation:', 'automation: ') : source.replace(/[_-]+/g, ' '));
  });

  it('delivering a failed automation switch never grants the queued row person authority', async () => {
    const { taskId, sid } = await taskOn('claude');
    const message = frameStartText('Approved by the script.', { source: 'automation:ticket-import' });
    await updateTaskRaw(taskId, { engine_switch: {
      id: 'es-script', state: 'failed', at: new Date().toISOString(), from_session_id: sid,
      to: { engine: 'codex' }, message, display_text: 'Approved by the script.', by: 'automation:ticket-import',
    } } as never);
    await cancelPendingSwitch(taskId, { deliver: true });
    const row = (await getStore()).queues[sid]![0];
    expect(row.sentBy).toBe('agent');
    expect(row.closesPrompt).not.toBe(true);
    expect(transcriptSentBy({ role: 'user', text: row.message })).toBe('agent');
  });

  it('a user-typed switch stays person even with the carried context in front', async () => {
    const { taskId } = await taskOn('claude');
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Run the tests first.', source: 'ui' });
    expect(transcriptSentBy({ role: 'user', text: String(edges.starts[0].message) })).toBe('person');
  });

  it('a pending agent handoff keeps the original session after the caller switches sessions', async () => {
    const { task: lead } = await addTask({ title: 'Parser lead', project: 'Marina', cwd: '/work/repo' } as never);
    await createSessionRecord('lead-original', lead.id, 'Marina', '/work/repo');
    await linkSession(lead.id, 'lead-original');
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on.', source: 'api-agent', callerSid: 'lead-original' });
    const pending = (await getTask(taskId)).engine_switch!;
    expect(pending.message).toContain('from-session="lead-original"');
    await updateSessionRecord('lead-original', { archived: true, archive_reason: 'engine_switched:codex' } as never);
    await createSessionRecord('lead-replacement', lead.id, 'Marina', '/work/repo');
    await linkSession(lead.id, 'lead-replacement');
    await updateSessionRecord(sid, { process_status: 'idle' } as never);
    await runEngineSwitch(taskId, pending);
    const text = String(edges.starts[0].message);
    expect(text).toContain('from-session="lead-original"');
    expect(text).not.toContain('from-session="lead-replacement"');
    expect(transcriptSentBy({ role: 'user', text: parseHinted(text).text })).toBe('agent');
  });
  it('Claude Code to Codex: a new session in the same task carries the context; the old one is history', async () => {
    const { taskId, sid } = await taskOn('claude');
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Run the tests first.', source: 'ui' });

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
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'ui' });
    expect((await getSessionByClaudeId(sid))?.leftContext?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    edges.history[first.sessionId!] = [
      { role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] },
      { role: 'assistant', text: 'Codex ran the suite: green.', timestamp: '2026-10-20T11:05:00Z' },
    ];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back to Claude Code.', displayText: 'Back to Claude Code.', by: undefined, source: 'ui' } as never);

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
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'ui' })).sessionId!;
    edges.history[codex] = [
      { role: 'user', text: 'On Codex.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'claude context' }] },
      { role: 'assistant', text: 'codex turn one', timestamp: '2026-10-20T11:01:00Z' },
    ];
    expect((await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back on Claude.', source: 'ui' })).sessionId).toBe(sid);
    // The resumed session takes its message (no runner here: the row is consumed by hand).
    await mutateStore((st) => { delete st.queues[sid]; }, false, true);
    // What the resumed Claude session now holds: its old context, the resume message, a new turn.
    edges.history[sid] = [
      ...HISTORY,
      { role: 'user', text: 'Back on Claude.', timestamp: '2026-10-20T12:00:00Z', hints: [{ kind: 'engine-switch', text: 'codex turn one' }] },
      { role: 'assistant', text: 'claude turn two', timestamp: '2026-10-20T12:01:00Z' },
    ];
    const again = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Codex again.', source: 'ui' });
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
    const gem = (await requestEngineSwitch({ taskId, engine: 'gemini', message: 'On Gemini.', source: 'ui' })).sessionId!;
    edges.history[gem] = [{ role: 'user', text: 'On Gemini.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'gemini ok', timestamp: '2026-10-20T11:01:00Z' }];
    await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back.', source: 'ui' });
    const again = await requestEngineSwitch({ taskId, engine: 'gemini', message: 'Gemini again.', source: 'ui' });
    expect(again.resumed).toBeUndefined();
    expect(again.sessionId).not.toBe(gem);
  });

  it('a session left in an error is not resumed on the way back: a new one carries the context', async () => {
    // 2026-11-05: a Pi thread failed every first message ("invalid encrypted view"), and each switch back resumed it.
    const { taskId } = await taskOn('claude');
    const pi = (await requestEngineSwitch({ taskId, engine: 'pi', message: 'On Pi.', source: 'ui' })).sessionId!;
    edges.history[pi] = [{ role: 'user', text: 'On Pi.', timestamp: '2026-10-20T11:00:00Z' }];
    await updateSessionRecord(pi, { process_status: 'error', errorMessage: 'protocol: ACP provider protocol operation failed' } as never);
    await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back.', source: 'ui' });
    const again = await requestEngineSwitch({ taskId, engine: 'pi', message: 'Pi again.', source: 'ui' });
    expect(again.resumed).toBeUndefined();
    expect(again.sessionId).not.toBe(pi);
  });

  it('a session whose message is still queued counts as in a turn: the switch waits', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-w', sessionId: sid, message: 'not delivered yet', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'After it.', source: 'ui', when: 'turn_end' });
    expect(res.state).toBe('pending');
    expect(edges.starts).toHaveLength(0);
  });

  it('a person\'s pick runs at once over a queued message, which moves to the new session', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-n', sessionId: sid, message: 'not delivered yet', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Now.', source: 'ui' });
    expect(res.state).toBe('done');
    expect((await getStore()).queues[res.sessionId!]?.map((r) => r.message)).toEqual(['not delivered yet']);
  });

  it('a restart in the middle of a resume still sends its message, once', async () => {
    const { taskId, sid } = await taskOn('claude');
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'ui' })).sessionId!;
    // The state a crash left: the earlier session is the task's again, its message not queued.
    await updateSessionRecord(codex, { archived: true, archive_reason: 'engine_switched:claude' } as never);
    await updateSessionRecord(sid, { archived: false, archive_reason: undefined, supersededBy: undefined } as never);
    await linkSession(taskId, sid);
    await updateTaskRaw(taskId, {
      engine_switch: {
        id: 'es-crash', state: 'switching', at: new Date().toISOString(), from_session_id: codex, to: { engine: 'claude', host: '__local__' },
        message: 'Back.', resume_session_id: sid, resume_message: 'HINTED Back.', by: 'human',
      },
    } as never, { source: 'ui' });
    await resumeEngineSwitches();
    await resumeEngineSwitches();
    const rows = ((await getStore()).queues[sid] ?? []).filter((r) => r.message.includes('HINTED Back.'));
    expect(rows).toHaveLength(1);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', resumed: true, session_id: sid });
  });

  it('a session whose history changed since the task left it is not resumed: a new session carries the context', async () => {
    const { taskId, sid } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'ui' });
    edges.history[first.sessionId!] = [{ role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'Codex ran the suite: green.', timestamp: '2026-10-20T11:05:00Z' }];
    edges.history[sid] = [...HISTORY, { role: 'user', text: 'someone wrote here later', timestamp: '2026-10-20T12:00:00Z' }];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back to Claude Code.', source: 'ui' });
    expect(back.resumed).toBeUndefined();
    expect(back.sessionId).not.toBe(sid);
    expect(edges.starts).toHaveLength(2);
    expect(String(edges.starts[1].message)).toContain('Codex ran the suite: green.');
  });

  it('a later compaction, or another model, starts a new session instead of resuming', async () => {
    const { taskId } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Continue on Codex.', source: 'ui' });
    edges.history[first.sessionId!] = [{ role: 'user', text: 'Continue on Codex.', timestamp: '2026-10-20T11:00:00Z' }, { role: 'assistant', text: 'ok', timestamp: '2026-10-20T11:05:00Z' }];
    await updateSessionRecord('old-claude-sid', { cliModel: 'claude-opus-5-5' } as never);
    const other = await requestEngineSwitch({ taskId, engine: 'claude', model: 'claude-sonnet-5-5', message: 'Back.', source: 'ui' });
    expect(other.resumed).toBeUndefined();

    // A Claude session that compacted after it took over is not a prefix any more either.
    const { task } = await addTask({ title: 'Compacted', project: 'Marina', cwd: '/work/repo' } as never);
    await createSessionRecord('codex-a', task.id, 'Marina', '/work/repo');
    await updateSessionRecord('codex-a', { engine: 'codex', process_status: 'idle', messageCount: 2 } as never);
    edges.history['codex-a'] = [{ role: 'user', text: 'start on codex', timestamp: '2026-10-20T09:00:00Z' }, { role: 'assistant', text: 'ok', timestamp: '2026-10-20T09:01:00Z' }];
    const toClaude = await requestEngineSwitch({ taskId: task.id, engine: 'claude', message: 'On Claude.', source: 'ui' });
    edges.history[toClaude.sessionId!] = HISTORY; // holds a compaction
    const backToCodex = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Back to Codex.', source: 'ui' });
    expect(backToCodex.resumed).toBeUndefined();
    expect(backToCodex.sessionId).not.toBe('codex-a');
  });

  it('a message for the old session while the switch runs waits and lands in the new session', async () => {
    const { taskId, sid } = await taskOn('claude');
    let release!: () => void;
    edges.gate = new Promise<void>((r) => { release = r; });
    const run = requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1));
    const addressed = activeSessionFor(sid);
    // An agent's second pick while it runs is refused, never dropped silently.
    await expect(requestEngineSwitch({ taskId, engine: 'gemini', message: 'x', source: 'ui', callerSid: 'agent-sid' })).rejects.toMatchObject({ code: 'switch_in_progress' });
    release();
    const res = await run;
    expect(await addressed).toBe(res.sessionId);
    edges.gate = undefined;
  });

  it('two picks queued behind a running switch: only the newest runs, the older is told it was replaced', async () => {
    // Review round 6: both passed the in-flight check, and the newer was answered with the older's switch.
    const { taskId } = await taskOn('claude');
    let release!: () => void;
    edges.gate = new Promise<void>((r) => { release = r; });
    const first = requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1));
    const older = requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' }).then((r) => ({ r }), (e: unknown) => ({ e }));
    const newest = requestEngineSwitch({ taskId, engine: 'opencode', source: 'ui' });
    edges.gate = undefined;
    release();
    await first;
    const last = await newest;
    expect(await older).toMatchObject({ e: { code: 'switch_superseded' } });
    expect(last).toMatchObject({ state: 'done', engine: 'opencode' });
    expect(edges.starts).toHaveLength(2);
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(last.sessionId);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', session_id: last.sessionId });
  });

  it('a pick of the engine the task is on, queued behind a switch, turns it back; once there, it reads as done', async () => {
    const { taskId, sid } = await taskOn('claude');
    let release!: () => void;
    edges.gate = new Promise<void>((r) => { release = r; });
    const first = requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1));
    const back = requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    edges.gate = undefined;
    release();
    await first;
    expect(await back).toMatchObject({ state: 'done', engine: 'claude', sessionId: sid, resumed: true });
    // Asked again while the task already runs there, after waiting on a pick: done, not a refusal.
    let release2!: () => void;
    edges.gate = new Promise<void>((r) => { release2 = r; });
    const toPi = requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    await vi.waitFor(() => expect(edges.starts.length).toBeGreaterThan(1));
    const piAgain = requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    edges.gate = undefined;
    release2();
    const onPi = await toPi;
    expect(await piAgain).toMatchObject({ state: 'done', engine: 'pi', sessionId: onPi.sessionId });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', session_id: onPi.sessionId });
  });

  it('a person\'s second pick while a switch runs follows it: claude, then codex, then pi', async () => {
    const { taskId, sid } = await taskOn('claude');
    let release!: () => void;
    edges.gate = new Promise<void>((r) => { release = r; });
    const first = requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1));
    const second = requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    edges.gate = undefined;
    release();
    const a = await first;
    const b = await second;
    expect(a).toMatchObject({ state: 'done', engine: 'codex', fromSessionId: sid });
    expect(b).toMatchObject({ state: 'done', engine: 'pi', fromSessionId: a.sessionId });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(b.sessionId);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', session_id: b.sessionId });
  });

  it('queued rows and open requests move to the new session', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      // A row parked on it (a delivery that failed): it waits for the session, not in it.
      s.queues[sid] = [{ id: 'qm-1', sessionId: sid, message: 'queued while idle', status: 'parked', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const asked = await createSessionRequest({ fromSessionId: 'leader-sid', toSessionId: sid, text: 'Reply when done' });
    const owed = await createSessionRequest({ fromSessionId: sid, toSessionId: 'worker-sid', text: 'Check the build' });

    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui' });
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
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui' }))
      .rejects.toMatchObject({ code: 'start_failed', status: 502 });

    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect(old?.archive_reason).toBeUndefined();
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    expect((await getStore()).queues[sid]?.map((r) => r.message)).toEqual(['keep me']);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed' });
    expect(String((await getTask(taskId)).engine_switch?.error)).toContain('engine would not start');
  });

  it('a start refused for want of the engine\'s sign-in says so, for every engine with one, and puts everything back', async () => {
    const { ENGINE_SIGN_INS } = await import('../../../src/providers/acp-engine-sign-in.js');
    const { EngineSignInRequiredError } = await import('../../../src/providers/delivery-failure.js');
    const { QuickStartError } = await import('../../../src/core/sessions/quick-start.js');
    const { notSignedInSentence, parseNotSignedIn } = await import('../../../src/core/agents/engine-sign-in-words.js');
    const engines = Object.keys(ENGINE_SIGN_INS);
    expect(engines.length).toBeGreaterThan(0);
    for (const engine of engines) {
      const { taskId, sid } = await taskOn('claude');
      const words = notSignedInSentence(engine as never, 'this Mac');
      // The way task-start hands it on: its own sentence around it, the refusal as the cause.
      edges.failStart = true;
      edges.failWith = Object.assign(new QuickStartError(`Task ${taskId} could not start: ${words}`, 502), {
        cause: new EngineSignInRequiredError(words, engine, '__local__', 'this Mac'),
      });
      await expect(requestEngineSwitch({ taskId, engine: engine as never, message: 'Go on.', source: 'ui' })).rejects.toMatchObject({
        status: 409, code: 'sign_in_required', message: words, detail: { signIn: { engine, host: '__local__', hostName: 'this Mac' } },
      });
      expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
      expect((await getSessionByClaudeId(sid))?.archived).toBeFalsy();
      const failed = (await getTask(taskId)).engine_switch;
      expect(failed?.state).toBe('failed');
      // The words the chat reads back to offer the sign-in, exactly.
      expect(parseNotSignedIn(failed?.error)).toMatchObject({ engine, hostName: 'this Mac' });
    }
  });

  it('a pick made mid-turn waits for the turn to end, then runs by itself', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'After this turn.', displayText: 'After this turn.', source: 'ui', when: 'turn_end' });
    expect(res.state).toBe('pending');
    expect(edges.starts).toHaveLength(0);
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'pending', from_session_id: sid, message: 'After this turn.' });

    await updateSessionRecord(sid, { process_status: 'idle' } as never);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: sid, process_status: 'idle' }, ['test'], { source: 'ui' });
    await vi.waitFor(() => expect(edges.starts).toHaveLength(1), { timeout: 10_000, interval: 100 });
    await vi.waitFor(async () => expect((await getTask(taskId)).engine_switch?.state).toBe('done'), { timeout: 5_000, interval: 100 });
    expect(String(edges.starts[0].message).trimEnd().endsWith('After this turn.')).toBe(true);
    expect((await getTask(taskId)).engine_switch?.message).toBeUndefined();
  }, 20_000);

  it('a person\'s pick mid-turn stops the turn and switches at once, the old session retired before the stop', async () => {
    // 2026-11-05, the user: "it shoud directly go, after user choose model and then exist the model selection".
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    // The turn's own message still reads `processing` (the real queue shape of a running turn).
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-p', sessionId: sid, message: 'the running turn', status: 'processing', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const interrupts: Array<{ sid: string; archived: boolean }> = [];
    bus.subscribe('test-interrupt', async (e) => {
      if (e.name !== EventNames.SESSION_INTERRUPT) return;
      const id = (e.data as { sessionId: string }).sessionId;
      interrupts.push({ sid: id, archived: !!(await getSessionByClaudeId(id))?.archived });
      // The CLI ends its turn on the interrupt.
      await updateSessionRecord(id, { process_status: 'idle' } as never);
      await mutateStore((st) => { delete st.queues[id]; }, false, true);
    }, { global: true });
    try {
      const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
      expect(res.state).toBe('done');
      expect(interrupts).toEqual([{ sid, archived: true }]);
      expect(edges.stops).toContain(sid);
      // No words of the user's: the new session starts with no turn, and the carried context (saying
      // the turn was cut) waits on its record for the next message.
      expect(edges.starts[0].message).toBe('');
      const ctx = (await getSessionByClaudeId(res.sessionId!))?.switchContext;
      expect(ctx?.switchId).toBe(res.switchId);
      expect(parseHinted(`${ctx!.text}\n\nx`).hints.map((h) => h.kind)).toEqual(['engine-switch']);
      expect(ctx!.text).toContain(TURN_CUT_NOTE);
      expect((await taskConversation(taskId))?.claudeSessionId).toBe(res.sessionId);
    } finally {
      bus.unsubscribe('test-interrupt');
    }
  }, 20_000);

  it('a switch with no message runs no turn: the next message carries the context, once', async () => {
    // 2026-11-05 review: a "ready" turn per switch cost a model call, a line in the chat and the task's place on the user's list.
    const { taskId, sid } = await taskOn('claude');
    const res = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    expect(res.state).toBe('done');
    expect(edges.starts[0].message).toBe('');
    // Never the task's description or a "Working on task" line, which would start its work again.
    expect(edges.starts[0].idle).toBe(true);
    const ctx = (await getSessionByClaudeId(res.sessionId!))?.switchContext;
    expect(ctx?.text).toContain('PELICAN');
    expect(ctx!.text).not.toContain(TURN_CUT_NOTE);
    // A message to the old session's id lands on the new one, behind the context; the display reads the words alone.
    await sendMessageToSession(sid, 'What was the magic word?', { source: 'ui', taskId });
    const row = (await getStore()).queues[res.sessionId!]?.[0];
    expect(row?.message).toContain(ctx!.text);
    const shown = parseHinted(row!.message);
    expect(shown.text).toBe('What was the magic word?');
    expect(shown.hints.map((h) => h.kind)).toContain('engine-switch');
    expect((await getSessionByClaudeId(res.sessionId!))?.switchContext).toBeUndefined();
    await sendMessageToSession(res.sessionId!, 'And again?', { source: 'ui', taskId });
    expect((await getStore()).queues[res.sessionId!]?.[1]?.message).not.toContain('PELICAN');
  });

  it('a round trip with no message resumes the first session without a turn; its next message carries the missed turns', async () => {
    const { taskId, sid } = await taskOn('claude');
    const first = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    edges.history[first.sessionId!] = [
      { role: 'user', text: 'Run the suite.', timestamp: '2026-10-20T11:00:00Z' },
      { role: 'assistant', text: 'Codex ran the suite: green.', timestamp: '2026-10-20T11:05:00Z' },
    ];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    expect(back).toMatchObject({ state: 'done', sessionId: sid, resumed: true });
    expect((await getStore()).queues[sid] ?? []).toHaveLength(0);
    expect((await getSessionByClaudeId(sid))?.switchContext?.text).toContain('Codex ran the suite: green.');
    await sendMessageToSession(first.sessionId!, 'Did it pass?', { source: 'ui', taskId });
    const row = (await getStore()).queues[sid]?.[0];
    expect(parseHinted(row!.message).text).toBe('Did it pass?');
    expect(row!.message).toContain('Codex ran the suite: green.');
  });

  it('a switch with no message and a queued row: the row carries the context', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-w', sessionId: sid, message: 'waiting words', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    expect(res.state).toBe('done');
    const rows = (await getStore()).queues[res.sessionId!] ?? [];
    expect(rows).toHaveLength(1);
    expect(parseHinted(rows[0].message).text).toBe('waiting words');
    expect(rows[0].message).toContain('PELICAN');
    expect((await getSessionByClaudeId(res.sessionId!))?.switchContext).toBeUndefined();
  });

  it('a second switch with no message carries the context the first one left unread', async () => {
    // Review round 3: Claude -> Pi -> Codex with nothing typed. Pi ran no turn, so its own history
    // is empty; the context Claude's conversation left on Pi goes on to Codex.
    const { taskId } = await taskOn('claude');
    const pi = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    expect((await getSessionByClaudeId(pi.sessionId!))?.switchContext?.text).toContain('PELICAN');
    const codex = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    expect(codex.state).toBe('done');
    const ctx = (await getSessionByClaudeId(codex.sessionId!))?.switchContext?.text ?? '';
    expect(ctx).toContain('PELICAN');
    expect(parseHinted(`${ctx}\n\nhello`).text).toBe('hello');
    expect(edges.starts.every((p) => p.idle === true)).toBe(true);
  });

  it('deleting the queued message that carried the context puts the context back for the next send', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-x', sessionId: sid, message: 'soon deleted', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    const row = ((await getStore()).queues[res.sessionId!] ?? [])[0];
    expect(row.message).toContain('PELICAN');
    const { deleteMessage } = await import('../../../src/core/session-message-queue.js');
    expect(await deleteMessage(res.sessionId!, row.id)).toBe(true);
    expect((await getSessionByClaudeId(res.sessionId!))?.switchContext?.text).toContain('PELICAN');
  });

  it('deleting it with another message queued moves the context onto that one', async () => {
    const { taskId, sid } = await taskOn('claude');
    const at = new Date().toISOString();
    await mutateStore((st) => {
      st.queues[sid] = [
        { id: 'qm-a', sessionId: sid, message: 'first', status: 'pending', enqueuedAt: at },
        { id: 'qm-b', sessionId: sid, message: 'second', status: 'pending', enqueuedAt: at },
      ] as never;
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    const { deleteMessage } = await import('../../../src/core/session-message-queue.js');
    expect(await deleteMessage(res.sessionId!, 'qm-a')).toBe(true);
    const rows = (await getStore()).queues[res.sessionId!] ?? [];
    expect(rows.map((r) => parseHinted(r.message).text)).toEqual(['second']);
    expect(rows[0].message).toContain('PELICAN');
    expect((await getSessionByClaudeId(res.sessionId!))?.switchContext).toBeUndefined();
  });

  it('a moved slash command stays as typed: the context rides the next message, or the record', async () => {
    const { taskId, sid } = await taskOn('claude');
    const at = new Date().toISOString();
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-c', sessionId: sid, message: '/compact', status: 'pending', enqueuedAt: at }] as never;
    }, false, true);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    expect(((await getStore()).queues[res.sessionId!] ?? []).map((r) => r.message)).toEqual(['/compact']);
    expect((await getSessionByClaudeId(res.sessionId!))?.switchContext?.text).toContain('PELICAN');
  });

  it('a task with no session yet: a switch with no message starts the engine idle', async () => {
    const { task } = await addTask({ title: 'Fresh task', project: 'Marina', cwd: '/work/repo' } as never);
    const res = await requestEngineSwitch({ taskId: task.id, engine: 'pi', source: 'ui' });
    expect(res.state).toBe('done');
    expect(edges.starts[0]).toMatchObject({ engine: 'pi', idle: true, message: '' });
  });

  it('a turn that ignores the Stop: its process is stopped before the context is read', async () => {
    // Review round 3: the read ran while the old turn went on, so a step it finished then was missing.
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    expect(res.state).toBe('done');
    const reads = edges.reads.filter((r) => r.sid === sid);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.stopped)).toBe(true);
    expect(String((await getSessionByClaudeId(res.sessionId!))?.switchContext?.text)).toContain('turn was stopped');
  }, 40_000);

  it('a turn its process cannot be stopped under: the switch fails and the task stays on its session', async () => {
    // Review round 4: a timed-out stop counted as stopped, and the read and the new start went ahead.
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    edges.stuck.add(sid);
    await expect(requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' })).rejects.toMatchObject({ code: 'turn_not_stopped' });
    expect(edges.starts).toHaveLength(0);
    expect(edges.reads.filter((r) => r.sid === sid)).toHaveLength(0);
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed' });
  }, 40_000);

  // 2026-11-08: a daemon restart left a live CLI behind a record that said `stopped`; a move then
  // ran over its turn and sent it no stop, and the old CLI worked on beside the new session.
  it('a record that says stopped over a live CLI: the switch waits for its turn, then stops it through its owner', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'stopped' });
    owner.set(sid, { alive: true, hold: 'turn' });
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui', when: 'turn_end' });
    expect(res).toMatchObject({ state: 'pending', fromSessionId: sid });
    expect(edges.starts).toHaveLength(0);
    expect(edges.stops).toHaveLength(0);
    // The turn ends (the daemon's fold says idle): the switch runs, and the old CLI is stopped first.
    owner.set(sid, { alive: true, hold: 'idle' });
    const done = await runEngineSwitch(taskId, (await getTask(taskId)).engine_switch!);
    expect(done).toMatchObject({ state: 'done', fromSessionId: sid });
    expect(edges.stops).toEqual([sid]);
    expect(edges.starts).toHaveLength(1);
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(done.sessionId);
  }, 40_000);

  it('a stop its owner does not confirm while the old CLI runs: no second session starts, the task stays', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'stopped' });
    owner.set(sid, { alive: true, hold: 'idle' });
    edges.stuck.add(sid);
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui' }))
      .rejects.toMatchObject({ status: 409, code: 'old_session_live', message: expect.stringContaining('no second session was started') });
    expect(edges.starts).toHaveLength(0);
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    expect((await getSessionByClaudeId(sid))?.archived).toBeFalsy();
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', error: expect.stringContaining('could not be stopped') });
  }, 40_000);

  it('a session resumed with a context it never read keeps it through the next round trip', async () => {
    // Review round 5: Claude -> Codex (work) -> Claude resumed with nothing typed -> Pi -> Claude:
    // the resume replaced Claude's unread context (Codex's work) with an empty delta.
    const { taskId, sid } = await taskOn('claude');
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'ui' })).sessionId!;
    edges.history[codex] = [
      { role: 'user', text: 'On Codex.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'claude context' }] },
      { role: 'assistant', text: 'Codex found OSPREY in the logs.', timestamp: '2026-10-20T11:05:00Z' },
    ];
    const back = await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    expect(back).toMatchObject({ sessionId: sid, resumed: true });
    expect((await getSessionByClaudeId(sid))?.switchContext?.text).toContain('OSPREY');
    const pi = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    expect((await getSessionByClaudeId(pi.sessionId!))?.switchContext?.text).toContain('OSPREY');
    const again = await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    expect(again).toMatchObject({ sessionId: sid, resumed: true });
    expect((await getSessionByClaudeId(sid))?.switchContext?.text).toContain('OSPREY');
  });

  it('what the next message carries is budgeted as one: over the window, the transcript is named instead', async () => {
    // Review round 5: the history and an unread context each fit, together they did not.
    const { taskId, sid } = await taskOn('claude');
    const big = (word: string) => Array.from({ length: 9000 }, (_, i) => `${word} line ${i} of the long investigation notes.`).join('\n');
    edges.history[sid] = [...HISTORY, { role: 'assistant', text: big('ALPHA'), timestamp: '2026-10-20T10:02:00Z' }];
    const codex = (await requestEngineSwitch({ taskId, engine: 'codex', message: 'On Codex.', source: 'ui' })).sessionId!;
    edges.history[codex] = [
      { role: 'user', text: 'On Codex.', timestamp: '2026-10-20T11:00:00Z' },
      { role: 'assistant', text: big('BRAVO'), timestamp: '2026-10-20T11:05:00Z' },
    ];
    await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    const pi = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    const ctx = (await getSessionByClaudeId(pi.sessionId!))?.switchContext?.text ?? '';
    expect(ctx).toContain('too long for this engine');
    expect(ctx).toMatch(/transcript is at \S+/);
    expect(ctx).not.toContain('BRAVO line 8000');
  });

  /** The CLI ends its turn on the Stop a switch sends. */
  const endTurnOnInterrupt = (name: string) => bus.subscribe(name, async (e) => {
    if (e.name !== EventNames.SESSION_INTERRUPT) return;
    const id = (e.data as { sessionId: string }).sessionId;
    await updateSessionRecord(id, { process_status: 'idle' } as never);
    await mutateStore((st) => { delete st.queues[id]; }, false, true);
  }, { global: true });

  it('a mid-turn switch whose context read fails puts the old session back as the task\'s, unlocked', async () => {
    // Review 2026-11-05: the old session is retired before its turn is stopped; a read failing after
    // that left the task on a session that read as replaced (rail locked, sends held, never asked).
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    endTurnOnInterrupt('test-interrupt-fail');
    edges.failHistory = true;
    try {
      await expect(requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' })).rejects.toBeTruthy();
      const old = await getSessionByClaudeId(sid);
      expect(old?.archived).toBeFalsy();
      expect(old?.archive_reason).toBeUndefined();
      expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
      expect(await activeSessionFor(sid)).toBe(sid);
      expect((await getTask(taskId)).engine_switch?.state).toBe('failed');
      expect(edges.starts).toHaveLength(0);
    } finally {
      bus.unsubscribe('test-interrupt-fail');
    }
  }, 20_000);

  it('a person\'s pick over a switch waiting for the turn takes that switch\'s message along', async () => {
    const { taskId } = await taskOn('claude', { status: 'running' });
    const waiting = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Run the parser tests next.', source: 'ui', when: 'turn_end' });
    expect(waiting.state).toBe('pending');
    endTurnOnInterrupt('test-interrupt-carry');
    try {
      const res = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
      expect(res).toMatchObject({ state: 'done', engine: 'pi' });
      expect(edges.starts).toHaveLength(1);
      expect(parseHinted(String(edges.starts[0].message)).text).toContain('Run the parser tests next.');
    } finally {
      bus.unsubscribe('test-interrupt-carry');
    }
  }, 20_000);

  it('a person\'s pick over an agent\'s waiting switch is the person\'s: no agent name, no agent message (2026-11-15)', async () => {
    const { task: lead } = await addTask({ title: 'Walnut VP', project: 'Marina', cwd: '/work/repo' } as never);
    await createSessionRecord('vp-sid', lead.id, 'Marina', '/work/repo');
    await linkSession(lead.id, 'vp-sid');
    const { taskId } = await taskOn('claude', { status: 'running' });
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on as the VP said.', reason: 'to try Codex', source: 'api-agent', callerSid: 'vp-sid' });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'pending', by: `task:${lead.id}`, by_name: 'Walnut VP', reason: 'to try Codex' });
    endTurnOnInterrupt('test-interrupt-person-over-agent');
    try {
      const res = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
      expect(res).toMatchObject({ state: 'done', engine: 'pi' });
      const sw = (await getTask(taskId)).engine_switch!;
      expect(sw.by).toBe('human');
      expect(sw.by_name).toBeUndefined();
      expect(String(edges.starts.at(-1)?.message ?? '')).not.toContain('Carry on as the VP said.');
    } finally {
      bus.unsubscribe('test-interrupt-person-over-agent');
    }
  }, 20_000);

  it('a task moving itself is not named as another task', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    await linkSession(taskId, sid);
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on.', source: 'api-agent', callerSid: sid });
    const sw = (await getTask(taskId)).engine_switch!;
    expect(sw).toMatchObject({ state: 'pending', by: `task:${taskId}` });
    expect(sw.by_name).toBeUndefined();
  });

  it('an agent\'s switch message reaches the new session in that agent\'s peer note', async () => {
    const { task: lead } = await addTask({ title: 'Parser lead', project: 'Marina', cwd: '/work/repo' } as never);
    await createSessionRecord('lead-sid-1', lead.id, 'Marina', '/work/repo');
    await updateSessionRecord('lead-sid-1', { process_status: 'idle' } as never);
    await linkSession(lead.id, 'lead-sid-1');
    const { taskId } = await taskOn('claude');
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on with the trailing commas.', source: 'ui', callerSid: 'lead-sid-1' });
    expect(res.state).toBe('done');
    const first = parseHinted(String(edges.starts[0].message));
    expect(first.hints.map((h) => h.kind)).toEqual(['engine-switch']);
    expect(first.text).toContain('Carry on with the trailing commas.');
    expect(first.text).toMatch(/^<walnut-message kind="peer-note"/);
    expect(first.text).toContain('lead-sid');
    expect(first.text).not.toContain('Walnut (engine switch)');
  });

  it('the user\'s sequence: send, Stop, model change, switch to Codex, then Pi, then messages reach Pi', async () => {
    // 2026-11-05 in the Mac app: the model change's echo line read as a turn (fold-local-command-echo.test.ts),
    // so the Codex switch went pending and the old Claude Code session looked like it carried on.
    const { taskId, sid } = await taskOn('claude');
    await updateSessionRecord(sid, { model: 'sonnet', cliModel: 'sonnet' } as never);
    const codex = await requestEngineSwitch({ taskId, engine: 'codex', model: 'gpt-5.5', source: 'ui' });
    expect(codex).toMatchObject({ state: 'done', engine: 'codex' });
    const pi = await requestEngineSwitch({ taskId, engine: 'pi', source: 'ui' });
    expect(pi).toMatchObject({ state: 'done', engine: 'pi', fromSessionId: codex.sessionId });
    // A message addressed to any earlier session of the task goes to Pi's.
    expect(await activeSessionFor(sid)).toBe(pi.sessionId);
    expect(await activeSessionFor(codex.sessionId!)).toBe(pi.sessionId);
    expect(edges.stops).toEqual(expect.arrayContaining([sid, codex.sessionId]));
    // Nothing restarted the old ones.
    expect(edges.starts.map((p) => p.engine)).toEqual(['codex', 'pi']);
  });

  it('the replaced session asking for its own switch waits for its turn (it cannot cut its own turn)', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Mine.', source: 'ui', callerSid: sid, when: 'now' });
    expect(res.state).toBe('pending');
    expect(edges.starts).toHaveLength(0);
  });

  it('a pending switch always ends: free runs, background runs after its grace, a turn past the limit fails', () => {
    const at = 1_000_000;
    expect(pendingVerdict({ hold: 'free', askedAt: at, now: at })).toBe('run');
    expect(pendingVerdict({ hold: 'turn', askedAt: at, now: at + SWITCH_PENDING_MAX_MS - 1 })).toBe('wait');
    expect(pendingVerdict({ hold: 'turn', askedAt: at, now: at + SWITCH_PENDING_MAX_MS })).toBe('expire');
    expect(pendingVerdict({ hold: 'queue', askedAt: at, now: at + SWITCH_PENDING_MAX_MS })).toBe('expire');
    expect(pendingVerdict({ hold: 'background', askedAt: at, backgroundSince: at, now: at + SWITCH_BACKGROUND_GRACE_MS - 1 })).toBe('wait');
    expect(pendingVerdict({ hold: 'background', askedAt: at, backgroundSince: at, now: at + SWITCH_BACKGROUND_GRACE_MS })).toBe('run-over-background');
    // Past the limit, background work never holds it either.
    expect(pendingVerdict({ hold: 'background', askedAt: at, backgroundSince: at + SWITCH_PENDING_MAX_MS, now: at + SWITCH_PENDING_MAX_MS })).toBe('run-over-background');
    // An unreadable ask time is no reason to wait forever.
    expect(pendingVerdict({ hold: 'turn', askedAt: Number.NaN, now: at })).toBe('expire');
  });

  it('a move held only by its finished turn\'s background command runs after the grace and tells the new session', async () => {
    // 2026-11-03: the turn that asked for the move had started a test run; the session read running for 1 h 50 min.
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    edges.outlives.add(sid);
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on.', source: 'ui', when: 'turn_end' });
    expect(res.state).toBe('pending');
    await new Promise((r) => setTimeout(r, 300));
    expect(edges.starts).toHaveLength(0);
    // The grace has run out (the clock is the task's own `at`, so a restart keeps it).
    await updateTaskRaw(taskId, (cur) => ({ engine_switch: { ...cur.engine_switch!, at: new Date(Date.now() - SWITCH_PENDING_MAX_MS - 1).toISOString() } }), { source: 'ui' });
    watchPendingSwitch(taskId, sid);
    await vi.waitFor(async () => expect((await getTask(taskId)).engine_switch?.state).toBe('done'), { timeout: 10_000, interval: 100 });
    expect(edges.stops).toContain(sid);
    expect(String(edges.starts[0].message)).toContain(BACKGROUND_CUT_NOTE);
    expect((await getTask(taskId)).engine_switch?.background_cut).toBe(true);
  }, 20_000);

  it('a switch whose turn never ends fails at the limit with its reason; the message stays and the session is told', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Keep me.', source: 'ui', when: 'turn_end' });
    await updateTaskRaw(taskId, (cur) => ({ engine_switch: { ...cur.engine_switch!, at: new Date(Date.now() - SWITCH_PENDING_MAX_MS - 1).toISOString() } }), { source: 'ui' });
    watchPendingSwitch(taskId, sid);
    await vi.waitFor(async () => expect((await getTask(taskId)).engine_switch?.state).toBe('failed'), { timeout: 10_000, interval: 100 });
    const sw = (await getTask(taskId)).engine_switch!;
    expect(sw.error).toContain('still in a turn');
    expect(sw.message).toBe('Keep me.');
    expect(edges.starts).toHaveLength(0);
    expect(edges.stops).toHaveLength(0);
    // The notice asks nothing, so it rides the session's next message (sessions/wake-policy.ts).
    await vi.waitFor(async () => {
      const { pendingHeldNotices } = await import('../../../src/core/sessions/held-notices.js');
      const held = await pendingHeldNotices(sid);
      held?.release();
      expect(held?.text ?? '').toContain('switch-expired');
    }, { timeout: 5_000, interval: 100 });
  }, 20_000);

  it('a pending switch can be cancelled, and a cancelled one never runs when the turn ends', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Later.', source: 'ui', when: 'turn_end' });
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Again.', source: 'ui', when: 'turn_end' })).rejects.toMatchObject({ code: 'switch_pending' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: true });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', error: 'cancelled' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: false });
    await updateSessionRecord(sid, { process_status: 'idle' } as never);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: sid, process_status: 'idle' }, ['test'], { source: 'ui' });
    await new Promise((r) => setTimeout(r, 4_000));
    expect(edges.starts).toHaveLength(0);
  }, 15_000);

  it('a failed switch keeps the message until the user sends it here or lets it go', async () => {
    const { taskId } = await taskOn('claude');
    edges.failStart = true;
    await requestEngineSwitch({ taskId, engine: 'codex', message: 'Keep this.', source: 'ui' }).catch(() => {});
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', message: 'Keep this.' });
    expect(await cancelPendingSwitch(taskId)).toEqual({ cancelled: true });
    expect((await getTask(taskId)).engine_switch?.message).toBeUndefined();
  });

  it('refuses the same engine, and an engine the task\'s host cannot run; a switch never moves the work', async () => {
    const local = await taskOn('claude');
    await expect(requestEngineSwitch({ taskId: local.taskId, engine: 'claude', message: 'x', source: 'ui' }))
      .rejects.toMatchObject({ code: 'same_engine', status: 400 });

    const { task } = await addTask({ title: 'Remote work', project: 'Marina', cwd: '/home/me/repo' } as never);
    await createSessionRecord('remote-sid', task.id, 'Marina', '/home/me/repo');
    await updateSessionRecord('remote-sid', { process_status: 'idle', host: 'devbox', messageCount: 2 } as never);
    edges.hostEngines = { devbox: { codex: { installed: false, version: null, reason: 'codex is not installed' } } };
    await expect(requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'x', source: 'ui' }))
      .rejects.toMatchObject({ code: 'engine_not_on_host', status: 409, message: expect.stringContaining('not available on devbox: codex is not installed') });
    await expect(requestEngineSwitch({ taskId: task.id, engine: 'custom', message: 'x', source: 'ui' }))
      .rejects.toMatchObject({ code: 'engine_not_on_host', status: 409 });
    expect(edges.starts).toHaveLength(0);

    // The host has it: the new session starts THERE, in the same directory.
    edges.hostEngines = { devbox: { codex: { installed: true, version: '1', reason: null } } };
    const res = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Go on.', source: 'ui' });
    expect(res).toMatchObject({ state: 'done', host: 'devbox' });
    expect(edges.starts[0]).toMatchObject({ engine: 'codex', host: 'devbox', cwd: '/home/me/repo' });
    edges.hostEngines = {};
  });

  // 2026-11-23, the user: a message is never lost, a restart or crash included. The switch's held
  // rows wait in the queue file (session-queue-transit.ts), never only in the switch's memory.
  it('a restart between taking the old session\'s rows and putting them anywhere loses none', async () => {
    const { taskId, sid } = await taskOn('claude');
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-cut', sessionId: sid, message: 'typed before the crash', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    // The switch retired the old session and took its rows; then the server died.
    await updateSessionRecord(sid, { archived: true, archive_reason: 'engine_switched:codex' } as never);
    await takeQueuedRows(sid, 'es-cut');
    await updateTaskRaw(taskId, { engine_switch: { id: 'es-cut', state: 'switching', at: new Date().toISOString(), from_session_id: sid, to: { engine: 'codex' } } } as never);
    expect((await readQueueFileFresh()).queues[sid]).toBeUndefined();
    resetTransitState();

    await resumeEngineSwitches();
    // The old session is the task's again, with its row (the switch, pending again, may then run
    // and carry it on): the row is in exactly one queue, and nothing waits on the way.
    await vi.waitFor(async () => {
      const disk = await readQueueFileFresh();
      expect(disk.transit).toBeUndefined();
      expect(Object.values(disk.queues).flat().map((r) => r.message)).toEqual(['typed before the crash']);
      expect((await getTask(taskId)).engine_switch?.state).not.toBe('switching');
    }, { timeout: 5_000 });
  });

  it('rows a finished switch left on the way go to the session that holds the task now', async () => {
    const { taskId, sid } = await taskOn('claude');
    const res = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Go on.', source: 'ui' });
    // A put the switch could not write (or a crash before it): its rows still wait under the switch's id.
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-late', sessionId: sid, message: 'stranded on the old session', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    await takeQueuedRows(sid, 'es-stranded');
    resetTransitState();
    await settleStrandedTransits({ switches: true });
    const disk = await readQueueFileFresh();
    expect(disk.transit).toBeUndefined();
    expect(disk.queues[sid]).toBeUndefined();
    expect(disk.queues[res.sessionId!]?.map((r) => r.message)).toEqual(['stranded on the old session']);
  });

  // 2026-11-24: Claude Code to Pi, Pi failed its first turn, and every switch after it started a
  // bare session (the failed Pi session read as "no conversation"), detached the Pi session the
  // panel showed, and the panel's engine picker stayed locked on it.
  it('a switched-to session whose first turn failed still holds the conversation: the way back resumes Claude Code', async () => {
    const { taskId, sid } = await taskOn('claude');
    const pi = (await requestEngineSwitch({ taskId, engine: 'pi', message: 'On Pi.', source: 'ui' })).sessionId!;
    edges.history[pi] = [{ role: 'user', text: 'On Pi.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] }];
    await updateSessionRecord(pi, { process_status: 'error', status_reason: 'api_error', messageCount: 1, errorMessage: 'protocol: ACP provider protocol operation failed' } as never);
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(pi);

    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'continue', source: 'ui' });
    expect(back).toMatchObject({ state: 'done', fromSessionId: pi, sessionId: sid, resumed: true });
    expect(edges.starts).toHaveLength(1);
    expect(await getSessionByClaudeId(pi)).toMatchObject({ taskId, archive_reason: 'engine_switched:claude', supersededBy: sid });
  });

  // 2026-11-24: the user's "continue", "this is crazy", "continue" reached a Pi session whose every
  // turn failed; the switches after it ran no turn, so nobody answered them for nine hours.
  it('a switch with no message from a session whose last turn failed answers the user\'s words at once', async () => {
    const { taskId, sid } = await taskOn('claude');
    const pi = (await requestEngineSwitch({ taskId, engine: 'pi', message: 'On Pi.', source: 'ui' })).sessionId!;
    edges.history[pi] = [
      { role: 'user', text: 'On Pi.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] },
      { role: 'system', systemVariant: 'error', text: 'protocol: ACP provider protocol operation failed', timestamp: '2026-10-20T11:00:01Z' },
      { role: 'user', text: 'this is crazy', timestamp: '2026-10-20T11:01:00Z' },
      { role: 'system', systemVariant: 'error', text: 'protocol: ACP provider protocol operation failed', timestamp: '2026-10-20T11:01:01Z' },
    ];
    await updateSessionRecord(pi, { process_status: 'error', status_reason: 'api_error', messageCount: 2 } as never);
    const back = await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    expect(back).toMatchObject({ state: 'done', sessionId: sid, resumed: true });
    const row = (await getStore()).queues[sid]?.at(-1)?.message ?? '';
    expect(row).toContain('got no answer');
    expect(row).toContain('"this is crazy"');
    // Walnut's line, never the user's own words: no person authority for what it quotes.
    expect(transcriptSentBy({ role: 'user', text: parseHinted(row).text })).toBe('agent');
  });

  it('a person\'s pick over a turn the switch cuts answers the question that turn never answered', async () => {
    const { taskId, sid } = await taskOn('claude', { status: 'running' });
    edges.history[sid] = [...HISTORY,
      { role: 'user', text: 'did u finish it', timestamp: '2026-10-20T12:00:00Z' },
      { role: 'assistant', text: '', timestamp: '2026-10-20T12:00:05Z', tools: [{ name: 'Bash', input: { command: 'git log -1' }, result: 'abc' }] },
    ];
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-p', sessionId: sid, message: 'did u finish it', status: 'processing', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    bus.subscribe('test-interrupt-owed', async (e) => {
      if (e.name !== EventNames.SESSION_INTERRUPT) return;
      const id = (e.data as { sessionId: string }).sessionId;
      await updateSessionRecord(id, { process_status: 'idle' } as never);
      await mutateStore((st) => { delete st.queues[id]; }, false, true);
    }, { global: true });
    try {
      const res = await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
      expect(res.state).toBe('done');
      const start = edges.starts.at(-1)!;
      expect(String(start.message)).toContain('"did u finish it');
      expect(start.idle).toBeUndefined();
    } finally {
      bus.unsubscribe('test-interrupt-owed');
    }
  }, 20_000);

  it('a turn the user stopped himself is not owed: a switch with no message after it runs no turn', async () => {
    const { taskId, sid } = await taskOn('claude');
    edges.history[sid] = [...HISTORY,
      { role: 'user', text: 'delete these branches', timestamp: '2026-10-20T12:00:00Z' },
      { role: 'assistant', text: '', timestamp: '2026-10-20T12:00:05Z', tools: [{ name: 'Bash', input: { command: 'git branch' }, result: 'a b' }] },
      { role: 'user', text: '[Request interrupted by user]', timestamp: '2026-10-20T12:00:06Z' },
    ];
    await requestEngineSwitch({ taskId, engine: 'codex', source: 'ui' });
    expect(edges.starts.at(-1)?.message).toBe('');
    expect(edges.starts.at(-1)?.idle).toBe(true);
  });

  it('owed words whose own turn failed again on the next engine are owed on the switch after it', async () => {
    const { owedLine, unansweredPersonWords } = await import('../../../src/core/sessions/engine-switch-context.js');
    const line = await owedLine('this is "crazy" <ok>', true);
    const failedAgain = [{ role: 'user', text: line, timestamp: 'a' }, { role: 'system', systemVariant: 'error', text: 'failed', timestamp: 'b' }];
    expect(await unansweredPersonWords(failedAgain as never)).toBe('this is "crazy" <ok>');
    // Answered on that engine: nothing is owed any more.
    expect(await unansweredPersonWords([...failedAgain, { role: 'assistant', text: 'done', timestamp: 'c' }] as never)).toBeUndefined();
  });

  it('a switch with no message from a session that answered runs no turn; a notice is not the user\'s words', async () => {
    const { unansweredPersonWords } = await import('../../../src/core/sessions/engine-switch-context.js');
    expect(await unansweredPersonWords(HISTORY as never)).toBeUndefined();
    expect(await unansweredPersonWords([...HISTORY, { role: 'user', text: '<walnut-message kind="notification" from="Walnut" note="n">\nthreads due\n</walnut-message>', timestamp: 'x' }] as never)).toBeUndefined();
    expect(await unansweredPersonWords([{ role: 'user', text: 'continue', timestamp: 'x' }, { role: 'system', systemVariant: 'error', text: 'failed', timestamp: 'y' }] as never)).toBe('continue');
    // No failure and no cut (the turn simply ended without text): not owed.
    expect(await unansweredPersonWords([{ role: 'user', text: 'continue', timestamp: 'x' }] as never)).toBeUndefined();
    // A local slash command is not a question.
    expect(await unansweredPersonWords([{ role: 'user', text: '/context', timestamp: 'x' }, { role: 'system', systemVariant: 'error', text: 'failed', timestamp: 'y' }] as never)).toBeUndefined();
  });

  it('a failed switched-to session handed to a third engine carries the task\'s context there', async () => {
    const { taskId } = await taskOn('claude');
    const pi = (await requestEngineSwitch({ taskId, engine: 'pi', message: 'On Pi.', source: 'ui' })).sessionId!;
    // What Pi's journal holds after its first turn failed (read from the real session): the first
    // message with the context it carried, then the error line.
    edges.history[pi] = [
      { role: 'user', text: 'On Pi.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] },
      { role: 'system', text: 'protocol: ACP provider protocol operation failed', timestamp: '2026-10-20T11:00:05Z' },
    ];
    await updateSessionRecord(pi, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    const res = await requestEngineSwitch({ taskId, engine: 'opencode', message: 'continue', source: 'ui' });
    expect(res).toMatchObject({ state: 'done', fromSessionId: pi });
    expect(String(edges.starts.at(-1)?.message)).toContain('the magic word is PELICAN');
    expect(await getSessionByClaudeId(pi)).toMatchObject({ taskId, archive_reason: 'engine_switched:opencode', supersededBy: res.sessionId });
  });

  it('a task an older Walnut left on a bare start (its failed switched-to session taken off it) still resumes Claude Code', async () => {
    const { taskId, sid } = await taskOn('claude');
    const pi = (await requestEngineSwitch({ taskId, engine: 'pi', message: 'On Pi.', source: 'ui' })).sessionId!;
    edges.history[pi] = [{ role: 'user', text: 'On Pi.', timestamp: '2026-10-20T11:00:00Z', hints: [{ kind: 'engine-switch', text: 'carried: the magic word is PELICAN' }] }];
    await updateSessionRecord(pi, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    // What the old rule did on the next switch (to OpenCode): Pi's row taken off the task, a bare start in its place.
    const { detachTaskSession } = await import('../../../src/core/sessions/task-session-claim.js');
    await detachTaskSession(taskId, pi, 'no conversation, replaced by a new start');
    await new Promise((r) => setTimeout(r, 5));
    // It ran in the task's own directory, not where the work was.
    await createSessionRecord('bare-opencode', taskId, 'Marina', '/state/tasks/t1');
    await updateSessionRecord('bare-opencode', { engine: 'opencode', process_status: 'idle', status_reason: 'turn_completed', messageCount: 1, acpCapabilities: { loadSession: true } } as never);
    await linkSession(taskId, 'bare-opencode').catch(() => {});
    edges.history['bare-opencode'] = [{ role: 'user', text: 'continue', timestamp: '2026-10-20T11:10:00Z' }];
    expect((await taskConversation(taskId))?.claudeSessionId).toBe('bare-opencode');

    const back = await requestEngineSwitch({ taskId, engine: 'claude', message: 'Back to Claude Code.', source: 'ui' });
    expect(back).toMatchObject({ state: 'done', fromSessionId: 'bare-opencode', sessionId: sid, resumed: true });
    const row = (await getStore()).queues[sid]?.at(-1)?.message ?? '';
    expect(row).toContain('On Pi.');
    expect(row).toContain('continue');
    expect(row).not.toContain('PELICAN'); // Claude Code already holds it
  });

  it('a task whose only session failed its start: the switch replaces it as a switch does, still the task\'s', async () => {
    const { taskId, sid } = await taskOn('pi');
    await updateSessionRecord(sid, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    expect(await taskConversation(taskId)).toBeUndefined();
    const res = await requestEngineSwitch({ taskId, engine: 'claude', message: 'continue', source: 'ui' });
    expect(res.state).toBe('done');
    // Kept on its task and marked replaced: a panel open on it follows the task to the new session.
    expect(await getSessionByClaudeId(sid)).toMatchObject({ taskId, archived: true, archive_reason: 'engine_switched:claude', supersededBy: res.sessionId });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', from_session_id: sid, session_id: res.sessionId, to: { engine: 'claude' } });
    expect((await getTask(taskId)).legacy_session_ids ?? []).not.toContain(sid);
    // The new session runs where the replaced one was set to run, on its host.
    expect(edges.starts.at(-1)).toMatchObject({ cwd: '/work/repo', host: '__local__' });
  });

  it('a failed start of the replacing session: its failed row is the task\'s, the empty row points at it (one-session guard armed)', async () => {
    const { getDb } = await import('../../../src/core/session-db.js');
    const { ensureOneSessionPerTaskGuard } = await import('../../../src/core/sessions/one-session-per-task.js');
    const { taskId, sid } = await taskOn('pi');
    await updateSessionRecord(sid, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    expect(ensureOneSessionPerTaskGuard(getDb())).toBe(true);
    edges.failStart = true; // the start makes its row, then fails
    await expect(requestEngineSwitch({ taskId, engine: 'claude', message: 'continue', source: 'ui' })).rejects.toThrow();
    const made = `new-sid-${edges.nextSid}`;
    expect(await getSessionByClaudeId(sid)).toMatchObject({ taskId, archive_reason: 'engine_switched:claude', supersededBy: made });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(made);
  });

  it('a switch with no message from a failed start runs the message that start never answered', async () => {
    const { taskId, sid } = await taskOn('pi');
    edges.history[sid] = [{ role: 'user', text: 'hello there', timestamp: '2026-10-20T11:00:00Z' }, { role: 'system', systemVariant: 'error', text: 'protocol: ACP provider protocol operation failed', timestamp: '2026-10-20T11:00:01Z' }];
    await updateSessionRecord(sid, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    await requestEngineSwitch({ taskId, engine: 'claude', source: 'ui' });
    const start = edges.starts.at(-1)!;
    expect(String(start.message)).toContain('"hello there"');
    expect(start.idle).toBeUndefined();
  });

  it('a failed start that made no row gives the empty row back to its task, unmarked', async () => {
    const { taskId, sid } = await taskOn('pi');
    await updateSessionRecord(sid, { process_status: 'error', status_reason: 'api_error', messageCount: 1 } as never);
    edges.failBeforeRow = true;
    await expect(requestEngineSwitch({ taskId, engine: 'claude', message: 'continue', source: 'ui' })).rejects.toThrow();
    const row = await getSessionByClaudeId(sid);
    expect(row?.archive_reason).toBeUndefined();
    expect(row?.archived).toBeFalsy();
    expect(row?.taskId).toBe(taskId);
  });

  it('a task with no conversation yet just starts on the engine', async () => {
    const { task } = await addTask({ title: 'Fresh', project: 'Marina' } as never);
    const res = await requestEngineSwitch({ taskId: task.id, engine: 'codex', message: 'Hello', source: 'ui' });
    expect(res.state).toBe('done');
    expect(edges.starts[0]).toMatchObject({ engine: 'codex', message: 'Hello' });
  });
});

describe('a switch a setting refuses (engines.codex: no provider reaches the host)', () => {
  const words = 'engines.codex: provider "local-proxy" is at http://127.0.0.1:8402/v1, so it reaches nothing on host "devbox". See "A provider per host" in docs/reference/codex-engine.md.';

  it('an agent\'s pick during a turn is refused at once, not parked until the turn ends; its message stays on the task', async () => {
    const { taskId, sid } = await taskOn('claude', { host: 'devbox' });
    edges.hostEngines.devbox = { codex: { installed: true, version: '1', reason: null } };
    const { CodexEngineConfigError } = await import('../../../src/providers/codex-engine-config.js');
    edges.codexRefusal = new CodexEngineConfigError(words.replace(/^engines\.codex: /, ''));
    await mutateStore((s) => {
      s.queues[sid] = [{ id: 'qm-busy', sessionId: sid, message: 'not delivered yet', status: 'pending', enqueuedAt: new Date().toISOString() } as never];
    }, false, true);
    const err = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on in Codex.', source: 'ui', when: 'turn_end' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'engine_config' });
    expect((err as Error).message).toMatch(/^The switch to Codex did not start: engines\.codex: provider "local-proxy"/);
    const task = await getTask(taskId);
    expect(task.engine_switch).toMatchObject({ state: 'failed', message: expect.stringContaining('Carry on in Codex.') });
    expect(task.engine_switch?.error).toMatch(/^engines\.codex: provider "local-proxy".*codex-engine\.md$/);
    // Nothing changed: no start, the old session untouched, its queued row still its own.
    expect(edges.starts).toHaveLength(0);
    expect(edges.stops).toHaveLength(0);
    expect((await getSessionByClaudeId(sid))?.archived).toBeFalsy();
    expect((await getStore()).queues[sid]?.map((r) => r.id)).toEqual(['qm-busy']);
  });

  it('a pick run now is refused before the old session is retired or stopped', async () => {
    const { taskId, sid } = await taskOn('claude', { host: 'devbox' });
    edges.hostEngines.devbox = { codex: { installed: true, version: '1', reason: null } };
    const { CodexEngineConfigError } = await import('../../../src/providers/codex-engine-config.js');
    edges.codexRefusal = new CodexEngineConfigError(words.replace(/^engines\.codex: /, ''));
    await expect(requestEngineSwitch({ taskId, engine: 'codex', message: 'Now.', source: 'ui' })).rejects.toMatchObject({ status: 422, code: 'engine_config' });
    expect(edges.starts).toHaveLength(0);
    expect(edges.stops).toHaveLength(0);
    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect(old?.archive_reason).toBeFalsy();
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
  });

  it('a start the setting refuses after the check (it changed meanwhile) answers 422 engine_config, and the task is back on its session', async () => {
    const { taskId, sid } = await taskOn('claude', { host: 'devbox' });
    edges.hostEngines.devbox = { codex: { installed: true, version: '1', reason: null } };
    const { CodexEngineConfigError } = await import('../../../src/providers/codex-engine-config.js');
    const { QuickStartError } = await import('../../../src/core/sessions/quick-start.js');
    const cause = new CodexEngineConfigError(words.replace(/^engines\.codex: /, ''));
    edges.failStart = true;
    edges.failWith = Object.assign(new QuickStartError(`Task ${taskId} could not start: ${cause.message}. A setting stops it; then retry task_start with the same id.`, 422, { code: 'engine_config' }), { cause });
    const err = await requestEngineSwitch({ taskId, engine: 'codex', message: 'Now.', source: 'ui' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'engine_config' });
    expect((err as Error).message).not.toContain('task_start');
    expect((await getTask(taskId)).engine_switch?.error).toMatch(/^engines\.codex: provider "local-proxy"/);
    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
  });
});
