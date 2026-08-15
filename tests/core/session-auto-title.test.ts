/**
 * session-auto-title hook (onMessageSend).
 *
 * A path-first quick start leaves the task titled `Session: <basename(cwd)>`
 * (nothing ever had a prompt to title from). When the user's first real message
 * arrives, the hook asks the session's own CLI for a title over the
 * generate_session_title control protocol and replaces the placeholder on the
 * task + session record. Contract pinned here:
 *   - placeholder + human message → CLI asked, task + record retitled
 *   - non-placeholder title       → never asked (user/agent title wins)
 *   - empty / slash-command sends → never asked
 *   - automated sources (auto-continue, phase-hook) → never asked
 *   - user rename DURING generation → write skipped (re-read guard)
 *   - CLI returns null            → placeholder kept, retries capped
 *
 * Real: hook code, task-manager, session-tracker. Fake: the live CLI session
 * (generateSessionTitle stub on sessionRunner's map — same pattern as
 * turn-complete-self-report.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-auto-title'));

// History reader for the turn-complete safety-net trigger (the payload carries
// no user message — the hook reads it from the session JSONL).
const historyTailMock = vi.fn();
vi.mock('../../src/core/session-history.js', () => ({
  readSessionHistoryTail: (...args: unknown[]) => historyTailMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask, getTask, updateTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { sessionAutoTitleHook, sessionAutoTitleTurnCompleteHook, autoTitleFromObservedMessage, __resetAutoTitleState } from '../../src/core/session-hooks/builtins.js';
import { defaultSessionTaskTitle } from '../../src/core/sessions/quick-start.js';
import type { OnMessageSendPayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

const CWD = '/tmp/demo-project';
const PLACEHOLDER = defaultSessionTaskTitle(CWD); // "Session: demo-project"

let sidCounter = 0;
function nextSid(): string {
  return `auto-title-sid-${++sidCounter}`;
}

function registerFakeSession(
  sid: string,
  impl: (desc: string) => Promise<string | null>,
  sideQuestionImpl?: (question: string) => Promise<string>,
) {
  const fake = {
    sessionId: sid,
    generateSessionTitle: vi.fn(impl),
    ...(sideQuestionImpl ? { askSideQuestion: vi.fn(sideQuestionImpl) } : {}),
    detach: () => {},
    kill: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.set(sid, fake);
  return fake;
}

async function makeTaskAndSession(sid: string, title = PLACEHOLDER): Promise<Task> {
  const { task } = await addTask({ title });
  await updateTask(task.id, { cwd: CWD }, { source: 'test' });
  await createSessionRecord(sid, task.id, 'Quick Start', CWD, { title });
  return getTask(task.id);
}

function payloadFor(sid: string, task: Task, message: string, source = 'ui'): OnMessageSendPayload {
  return {
    sessionId: sid,
    taskId: task.id,
    task,
    timestamp: new Date().toISOString(),
    traceId: 'trace-test',
    message,
    isResume: false,
    source,
  };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  __resetAutoTitleState(10); // shrink the in-dispatch retry pause for tests
  historyTailMock.mockReset();
  historyTailMock.mockResolvedValue(null);
});

afterEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (sessionRunner as any).sessions as Map<string, unknown>;
  for (const key of [...map.keys()]) if (String(key).startsWith('auto-title-sid-')) map.delete(key);
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('sessionAutoTitleHook', () => {
  it('replaces the placeholder on task AND session record with the CLI title', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    const fake = registerFakeSession(sid, async () => 'Fix login redirect loop');

    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'the login page redirects forever, please fix'));

    expect(fake.generateSessionTitle).toHaveBeenCalledOnce();
    expect(fake.generateSessionTitle.mock.calls[0][0]).toContain('login page redirects');
    expect((await getTask(task.id)).title).toBe('Fix login redirect loop');
    expect((await getSessionByClaudeId(sid))?.title).toBe('Fix login redirect loop');
  });

  it('never asks when the task title is not the exact placeholder', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid, 'My real title');
    const fake = registerFakeSession(sid, async () => 'Should never appear');

    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'hello there'));

    expect(fake.generateSessionTitle).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe('My real title');
  });

  it('skips empty and slash-command sends', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    const fake = registerFakeSession(sid, async () => 'Nope');

    await sessionAutoTitleHook.handler(payloadFor(sid, task, '   '));
    await sessionAutoTitleHook.handler(payloadFor(sid, task, '/compact'));

    expect(fake.generateSessionTitle).not.toHaveBeenCalled();
  });

  it('skips automated sources (auto-continue, phase-hook)', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    const fake = registerFakeSession(sid, async () => 'Nope');

    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'continue', 'auto-continue'));
    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'phase boilerplate', 'phase-hook'));

    expect(fake.generateSessionTitle).not.toHaveBeenCalled();
  });

  it('does not clobber a rename that happened while the CLI was thinking', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    registerFakeSession(sid, async () => {
      // Simulate the user renaming mid-generation.
      await updateTask(task.id, { title: 'User picked this' }, { source: 'test' });
      return 'AI title that lost the race';
    });

    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'do the thing'));

    expect((await getTask(task.id)).title).toBe('User picked this');
  });

  it('keeps the placeholder when the CLI cannot produce a title, and caps retries', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    const fake = registerFakeSession(sid, async () => null);

    // Attempts are capped at 3 dispatches; each dispatch asks twice (cold-resume
    // retry) → exactly 6 CLI calls, then the 4th/5th dispatches are no-ops.
    for (let i = 0; i < 5; i++) {
      await sessionAutoTitleHook.handler(payloadFor(sid, task, `try number ${i}`));
    }

    expect(fake.generateSessionTitle.mock.calls.length).toBe(6);
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  it('is a no-op for sessions with no live native CLI (record-only / ACP)', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    // No fake registered — findSessionByClaudeId returns undefined.

    await sessionAutoTitleHook.handler(payloadFor(sid, task, 'hello'));

    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  describe('turn-complete safety net (sends that bypass this server, e.g. phone via cloud)', () => {
    function turnPayload(sid: string, task: Task) {
      return {
        sessionId: sid, taskId: task.id, task,
        timestamp: new Date().toISOString(), traceId: 'trace-test',
        result: 'assistant turn text', turnIndex: 1, isPlanSession: false,
      };
    }

    it('back-fills the title from JSONL history after a turn', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      const fake = registerFakeSession(sid, async () => null, async (question) => {
        expect(question).toContain('why are more transistors faster');
        return 'CPU transistor scaling explained';
      });
      historyTailMock.mockResolvedValue([
        { role: 'user', text: 'why are more transistors faster', timestamp: 't1' },
        { role: 'assistant', text: 'because…', timestamp: 't2' },
      ]);

      await sessionAutoTitleTurnCompleteHook.handler(turnPayload(sid, task));

      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id)).title).toBe('CPU transistor scaling explained');
    });

    it('is a no-op when the task no longer wears the placeholder (already titled)', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid, 'Already titled');
      const fake = registerFakeSession(sid, async () => null, async () => 'Nope');

      await sessionAutoTitleTurnCompleteHook.handler(turnPayload(sid, task));

      expect(fake.askSideQuestion).not.toHaveBeenCalled();
      expect(historyTailMock).not.toHaveBeenCalled();
    });

    it('is a no-op when history has no real user message', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      const fake = registerFakeSession(sid, async () => null, async () => 'Nope');
      historyTailMock.mockResolvedValue([
        { role: 'assistant', text: 'greeting', timestamp: 't1' },
      ]);

      await sessionAutoTitleTurnCompleteHook.handler(turnPayload(sid, task));

      expect(fake.askSideQuestion).not.toHaveBeenCalled();
      expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
    });
  });

  describe('observed-message trigger (JSONL walnut-injected tail — all delivery paths)', () => {
    it('titles from a message observed on the JSONL, mid-turn, regardless of send path', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      const fake = registerFakeSession(sid, async () => null, async (question) => {
        expect(question).toContain('trace the fertility invoice emails');
        return 'Fertility invoice email trace';
      });

      await autoTitleFromObservedMessage(sid, task.id, 'trace the fertility invoice emails');

      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id)).title).toBe('Fertility invoice email trace');
    });

    it('strips the images-attached prefix and skips image-only messages', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      const fake = registerFakeSession(sid, async () => null, async (question) => {
        expect(question).not.toContain('/tmp/imgs/a.png');
        expect(question).toContain('look at this bill');
        return 'Medical bill review';
      });

      // Image-only → nothing to title from.
      await autoTitleFromObservedMessage(sid, task.id,
        '[Images attached — use the Read tool to view them]\n- /tmp/imgs/a.png\n\n');
      expect(fake.askSideQuestion).not.toHaveBeenCalled();

      // Image + text → title from the text alone.
      await autoTitleFromObservedMessage(sid, task.id,
        '[Images attached — use the Read tool to view them]\n- /tmp/imgs/a.png\n\nlook at this bill');
      expect((await getTask(task.id)).title).toBe('Medical bill review');
    });

    it('is a no-op once the task is titled (idempotent with other triggers)', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid, 'Already titled');
      const fake = registerFakeSession(sid, async () => null, async () => 'Nope');

      await autoTitleFromObservedMessage(sid, task.id, 'another message');

      expect(fake.askSideQuestion).not.toHaveBeenCalled();
      expect((await getTask(task.id)).title).toBe('Already titled');
    });
  });

  describe('ACP (codex) provider channel', () => {
    function registerFakeAcpSession(sid: string, impl: (prompt: string) => Promise<string>, activity: 'processing' | 'idle' = 'idle') {
      const fake = {
        sessionId: sid,
        runtimeId: `rt-${sid}`,
        activity,
        requestTurnCompleteSelfReport: vi.fn(impl),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sessionRunner as any).acpSessions.set(sid, fake);
      return fake;
    }
    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (sessionRunner as any).acpSessions as Map<string, unknown>;
      for (const key of [...map.keys()]) if (String(key).startsWith('auto-title-sid-')) map.delete(key);
    });

    it('titles a codex session via the ACP self-report control prompt', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      // No native session registered — provider resolution must find the ACP one.
      const fake = registerFakeAcpSession(sid, async (prompt) => {
        expect(prompt).toContain('rewrite the marketing site copy');
        return 'Marketing site copy rewrite';
      });

      await sessionAutoTitleHook.handler(payloadFor(sid, task, 'rewrite the marketing site copy'));

      expect(fake.requestTurnCompleteSelfReport).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id)).title).toBe('Marketing site copy rewrite');
    });

    it('defers while an ACP turn is active (worker would reject the control prompt)', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      const fake = registerFakeAcpSession(sid, async () => 'Nope', 'processing');

      await sessionAutoTitleHook.handler(payloadFor(sid, task, 'do the thing'));

      expect(fake.requestTurnCompleteSelfReport).not.toHaveBeenCalled();
      expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
    });

    it('keeps the placeholder when the ACP self-report fails (no fallback titler exists)', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid);
      registerFakeAcpSession(sid, async () => { throw new Error('worker gone'); });

      await sessionAutoTitleHook.handler(payloadFor(sid, task, 'do the thing'));

      expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
    });
  });

  describe('plugin content requirement (generic — the plugin authors rule + validator)', () => {
    // A sync plugin that only accepts ASCII titles — stand-in for any external
    // system's content rule (2026-08-06/07/08 incident chain: an English-only
    // plugin rule kept rejecting AI titles after the fact; the requirement now
    // ships in the FIRST generation prompt instead).
    const RULE = 'Titles must be ASCII-only for this tracker.';
    beforeEach(async () => {
      const { registry } = await import('../../src/core/integration-registry.js');
      const noop = async () => {};
      registry.register('ascii-tracker', {
        id: 'ascii-tracker',
        name: 'ASCII tracker (test)',
        config: {},
        sync: {
          createTask: async () => null,
          deleteTask: noop,
          updateTitle: noop, updateDescription: noop, updateSummary: noop,
          updateNote: noop, updateConversationLog: noop, updatePriority: noop,
          updatePhase: noop, updateDueDate: noop,
          updateProject: noop, updateDependencies: noop,
          associateSubtask: noop, disassociateSubtask: noop,
          pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
          syncPoll: noop,
          contentRequirement: (field) => (field === 'title' ? RULE : null),
          validateContent: (_task, field, value) =>
            // eslint-disable-next-line no-control-regex
            field === 'title' && /[^\x00-\x7F]/.test(value) ? RULE : null,
        },
        migrations: [],
        httpRoutes: [],
      });
    });
    afterEach(async () => {
      const { registry } = await import('../../src/core/integration-registry.js');
      registry.clear();
    });

    async function makePluginTaskAndSession(sid: string): Promise<Task> {
      // Inbox is structurally local-only — a provider-sourced task needs a project.
      const { task } = await addTask({ title: PLACEHOLDER, project: 'Tracked', source: 'ascii-tracker' });
      await updateTask(task.id, { cwd: CWD }, { source: 'test' });
      await createSessionRecord(sid, task.id, 'Quick Start', CWD, { title: PLACEHOLDER });
      return getTask(task.id);
    }

    it('ships the requirement in the FIRST side-question prompt and writes the answer', async () => {
      const sid = nextSid();
      const task = await makePluginTaskAndSession(sid);
      const fake = registerFakeSession(
        sid,
        async () => { throw new Error('CLI titler must not be consulted when side_question works'); },
        async (question) => {
          expect(question).toContain(RULE); // requirement rides the FIRST call
          expect(question).toContain('登录页面一直重定向'); // with the user's message
          return '"Fix login redirect loop"\n(extra commentary stripped)';
        },
      );

      await sessionAutoTitleHook.handler(payloadFor(sid, task, '登录页面一直重定向'));

      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1);
      expect(fake.generateSessionTitle).not.toHaveBeenCalled();
      expect((await getTask(task.id)).title).toBe('Fix login redirect loop');
    });

    it('falls back to the CLI titler (requirement included) when the side question fails', async () => {
      const sid = nextSid();
      const task = await makePluginTaskAndSession(sid);
      const fake = registerFakeSession(
        sid,
        async (desc) => {
          expect(desc).toContain(RULE); // requirement also rides the fallback
          return 'Fix login issue';
        },
        async () => { throw new Error('side question timed out'); },
      );

      await sessionAutoTitleHook.handler(payloadFor(sid, task, '登录页面一直重定向'));

      // A throwing side question is retried once (cold-spawn FIFO write can
      // fail) before falling through to the CLI titler.
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(2);
      expect(fake.generateSessionTitle).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id)).title).toBe('Fix login issue');
    });

    it('never writes a rule-violating title (pre-write validation, no loop)', async () => {
      const sid = nextSid();
      const task = await makePluginTaskAndSession(sid);
      const fake = registerFakeSession(
        sid,
        async () => '还是中文标题', // fallback ignores the rule too
        async () => '中文标题', // side question ignores the shipped rule
      );

      await sessionAutoTitleHook.handler(payloadFor(sid, task, '登录页面一直重定向'));

      // side_question answered (non-empty) → its candidate is validated and
      // dropped; no second channel, no retry loop — one attempt, clean exit.
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1);
      expect(fake.generateSessionTitle).not.toHaveBeenCalled();
      expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
    });

    it('local tasks (no plugin rule) get no requirement text in the prompt', async () => {
      const sid = nextSid();
      const task = await makeTaskAndSession(sid); // plain local task
      const fake = registerFakeSession(
        sid,
        async () => null,
        async (question) => {
          expect(question).not.toContain('MANDATORY RULE');
          return 'Investigate login loop';
        },
      );

      await sessionAutoTitleHook.handler(payloadFor(sid, task, 'the login page redirects forever'));

      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id)).title).toBe('Investigate login loop');
    });
  });
});
