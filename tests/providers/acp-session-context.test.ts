/**
 * An ACP engine with no instructions channel (OpenCode, Goose, Gemini, custom)
 * reads a task session's Walnut context on the FIRST prompt of each new provider
 * thread, as one Walnut hint block, so a Main or a lead there knows its role.
 * Codex keeps its developer instructions, a lane keeps its persona prefix, and a
 * thread that already read it (a loaded or warm one) never gets it again.
 */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-context'));

import { WALNUT_HOME } from '../../src/constants.js';
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../src/core/session-tracker.js';
import { _resetForTesting, addTask } from '../../src/core/task-manager.js';
import { AcpSession, SESSION_CONTEXT_HINT_KIND } from '../../src/providers/acp-session.js';
import { parseHinted } from '../../src/core/hints/hint-format.js';
import type { SessionEngine } from '../../src/core/types.js';

const ARTIFACTS = { workerCmd: ['worker'], adapterCmd: ['adapter'] };
const ROLE = 'You are the lead of the marina project. Assign work, coordinate, unblock.';

function workerState(loadSession = true): unknown {
  return {
    providerSessionId: undefined, adapterPid: 4242, turnActive: false, controlActive: false,
    pendingPermissions: [], initializeResponse: {},
    capabilities: {
      loadSession, promptImages: false, promptAudio: false, promptEmbeddedContext: false, listSessions: false,
      deleteSession: false, additionalDirectories: false, forkSession: false, resumeSession: false, closeSession: false, steering: false,
    },
    sessionResponse: {}, lastAcceptedCommands: {}, journalOffset: 0,
  };
}

type Reply = (command: string, params?: Record<string, unknown>) => Record<string, unknown>;

let taskSeq = 0;
function sessionOn(engine: SessionEngine, reply: Reply, extra: Record<string, unknown> = {}) {
  const session = new AcpSession({
    taskId: `task-marina-${++taskSeq}`, project: 'marina', cwd: '/tmp', mode: 'default', engine,
    developerInstructions: ROLE, artifacts: ARTIFACTS, ...extra,
  } as ConstructorParameters<typeof AcpSession>[0]);
  const send = vi.fn(async (command: string, params?: Record<string, unknown>) => reply(command, params));
  Object.assign(session as object, { conn: { connected: true, send } });
  // The engine env overlay reads config; this test is about the prompt only.
  vi.spyOn(session as unknown as { resolveConfiguredEngineEnv(): Promise<undefined> }, 'resolveConfiguredEngineEnv').mockResolvedValue(undefined);
  const prompts = () => send.mock.calls.filter((c) => c[0] === 'acpSend').map((c) => String((c[1] as { text: string }).text));
  return { session, send, prompts };
}

const fresh = (sid: string): Reply => (command) => command === 'acpStart'
  ? { ok: true, session: { sessionId: sid }, state: workerState() }
  : { ok: true };

beforeEach(async () => {
  _resetForTesting();
  _resetSessionTrackerForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('first prompt of a new provider thread', () => {
  it.each(['opencode', 'goose', 'gemini', 'custom'] as const)('%s: carries the context once, as a hint the display takes off', async (engine) => {
    const { session, prompts } = sessionOn(engine, fresh(`${engine}-thread-1`));
    await session.sendAccepted('Fix the flaky auth test', 'qm-1');
    await session.sendAccepted('and add a regression test', 'qm-2');
    const [first, second] = prompts();
    expect(first.startsWith(`<system-reminder>\nWalnut (${SESSION_CONTEXT_HINT_KIND}): `)).toBe(true);
    expect(first).toContain(ROLE);
    const parsed = parseHinted(first);
    expect(parsed.text).toBe('Fix the flaky auth test');
    expect(parsed.hints.map((h) => h.kind)).toEqual([SESSION_CONTEXT_HINT_KIND]);
    expect(second).toBe('and add a regression test');
  });

  it('codex: never (its developer instructions carry it)', async () => {
    const { session, prompts } = sessionOn('codex', fresh('codex-thread'));
    vi.spyOn(session as unknown as { buildAdapterEnv(): Promise<undefined> }, 'buildAdapterEnv').mockResolvedValue(undefined);
    await session.sendAccepted('hello', 'qm-1');
    expect(prompts()).toEqual(['hello']);
  });

  it('a lane (the Personal AI): never, its persona rides the message already', async () => {
    const { session, prompts } = sessionOn('opencode', fresh('lane-thread'), { lane: 'main' });
    await session.sendAccepted('hello', 'qm-1');
    expect(prompts()).toEqual(['hello']);
  });

  it('a session with no task: never', async () => {
    const { session, prompts } = sessionOn('opencode', fresh('no-task'), { taskId: '' });
    await session.sendAccepted('hello', 'qm-1');
    expect(prompts()).toEqual(['hello']);
  });

  it('a thread that loads (resume after a restart): never, it already read it', async () => {
    await createSessionRecord('old-thread', 'task-old', 'marina', '/tmp', { initialProcessStatus: 'idle', engine: 'opencode', acpRuntimeId: 'acp-old', messageCount: 4 });
    const { session, prompts } = sessionOn('opencode', fresh('old-thread'), { providerSessionId: 'old-thread', runtimeId: 'acp-old', taskId: 'task-old' });
    await session.sendAccepted('continue', 'qm-1');
    expect(prompts()).toEqual(['continue']);
  });

  it('a thread established but never prompted (a restart in between, or another instance attached): still owed', async () => {
    await createSessionRecord('unprompted-thread', 'task-unprompted', 'marina', '/tmp', { initialProcessStatus: 'idle', engine: 'opencode', acpRuntimeId: 'acp-unprompted', messageCount: 0 });
    const { session, prompts } = sessionOn('opencode', fresh('unprompted-thread'), { providerSessionId: 'unprompted-thread', runtimeId: 'acp-unprompted', taskId: 'task-unprompted' });
    await session.sendAccepted('go', 'qm-1');
    expect(parseHinted(prompts()[0]).hints.map((h) => h.kind)).toEqual([SESSION_CONTEXT_HINT_KIND]);
  });

  it('a thread that failed to load and was replaced: the new one gets it', async () => {
    const { task } = await addTask({ title: 'marina lead', project: 'marina' });
    await createSessionRecord('lost-thread', task.id, 'marina', '/tmp', { initialProcessStatus: 'idle', engine: 'opencode', acpRuntimeId: 'acp-lost' });
    const { session, prompts } = sessionOn('opencode', (command) => {
      if (command === 'acpStart') return { ok: false, errorKind: 'load_failed', error: 'gone' };
      if (command === 'acpNewSession') return { ok: true, result: { sessionId: 'replacement-thread' } };
      return { ok: true };
    }, { providerSessionId: 'lost-thread', runtimeId: 'acp-lost', taskId: task.id });
    await session.sendAccepted('continue', 'qm-1');
    expect(parseHinted(prompts()[0]).hints.map((h) => h.kind)).toEqual([SESSION_CONTEXT_HINT_KIND]);
  });

  it('a refused send keeps it owed: the retry still carries it', async () => {
    let refuse = true;
    const { session, prompts } = sessionOn('opencode', (command) => {
      if (command === 'acpStart') return { ok: true, session: { sessionId: 'thread-r' }, state: workerState() };
      if (command === 'acpSend' && refuse) { refuse = false; return { ok: false, error: 'busy' }; }
      return { ok: true };
    });
    await expect(session.sendAccepted('first', 'qm-1')).rejects.toThrow(/acpSend failed/);
    await session.sendAccepted('first again', 'qm-2');
    const [a, b] = prompts();
    expect(a).toContain(ROLE);
    expect(b).toContain(ROLE);
    expect(parseHinted(b).text).toBe('first again');
  });

  it('a user message with a typed <system-reminder> keeps it as typed', async () => {
    const { session, prompts } = sessionOn('opencode', fresh('thread-esc'));
    const typed = 'what does &lt;system-reminder> do?';
    await session.sendAccepted(typed, 'qm-1');
    expect(parseHinted(prompts()[0]).text).toBe('what does <system-reminder> do?');
  });
});
