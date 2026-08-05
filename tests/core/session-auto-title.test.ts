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

import { WALNUT_HOME } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { addTask, getTask, updateTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { sessionAutoTitleHook, __resetAutoTitleState } from '../../src/core/session-hooks/builtins.js';
import { defaultSessionTaskTitle } from '../../src/core/sessions/quick-start.js';
import type { OnMessageSendPayload } from '../../src/core/session-hooks/types.js';
import type { Task } from '../../src/core/types.js';

const CWD = '/tmp/demo-project';
const PLACEHOLDER = defaultSessionTaskTitle(CWD); // "Session: demo-project"

let sidCounter = 0;
function nextSid(): string {
  return `auto-title-sid-${++sidCounter}`;
}

function registerFakeSession(sid: string, impl: (desc: string) => Promise<string | null>) {
  const fake = {
    sessionId: sid,
    generateSessionTitle: vi.fn(impl),
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
});
