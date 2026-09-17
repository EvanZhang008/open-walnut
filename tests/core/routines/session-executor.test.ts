/**
 * The `session` executor: where a fire actually lands.
 *
 * The four answers it must get right, in this order:
 *   live session on the task     → send into it;
 *   only a stopped one           → send anyway (a cold --resume keeps the transcript);
 *   no resumable session, task open → start a new session ON THAT TASK;
 *   task gone or completed       → error + notify, and never a new task.
 *
 * The delivery seam is injected (same shape as the watcher's toolDeps) so these
 * assert the RESOLUTION, not four modules' internals.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-executor'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { createSessionExecutor, type SessionDelivery } from '../../../src/core/routines/executors/session.js';
import { buildTriggerMessage } from '../../../src/core/routines/trigger-envelope.js';
import { parseWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import type { CronJob } from '../../../src/core/cron/types.js';

type Sessions = Awaited<ReturnType<SessionDelivery['sessionsForTask']>>;

function fakeDelivery(over: Partial<SessionDelivery> = {}) {
  const calls = {
    sent: [] as Array<{ sessionId: string; message: string; taskId: string }>,
    started: [] as Array<{ message: string; taskId: string; cwd: string; host?: string; title?: string }>,
    notified: [] as Array<{ title: string; body?: string; dedupKey: string; taskId?: string }>,
  };
  const delivery: SessionDelivery = {
    sessionsForTask: async () => [] as Sessions,
    sendToSession: async (sessionId, message, taskId) => { calls.sent.push({ sessionId, message, taskId }); },
    getTask: async () => null,
    startSession: async (params) => { calls.started.push(params); },
    notify: async (input) => { calls.notified.push(input); },
    ...over,
  };
  return { delivery, calls };
}

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'PR comments',
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: 'every', everyMs: 300_000 },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'read them' },
    executor: { type: 'session', config: { target: 'task-1', prompt: 'read them', instructions: 'read them' } },
    check: { run: 'bash check.sh', host: '__local__', cwd: '/repo' },
    state: {},
    ...over,
  };
}

const REF = { type: 'session', config: { target: 'task-1', prompt: 'read them', instructions: 'read them' } };
const FIRE = buildTriggerMessage({ name: 'PR comments' }, { atMs: 1, items: [{ id: 'c1' }] }, 'read them');

describe('session executor: validate', () => {
  const exec = createSessionExecutor(fakeDelivery());

  it('requires both a target task and a prompt', () => {
    expect(exec.validate({ prompt: 'x' }).ok).toBe(false);
    expect(exec.validate({ target: 'task-1' }).ok).toBe(false);
    expect(exec.validate({ target: '  ', prompt: 'x' }).ok).toBe(false);
  });

  it('trims and mirrors the prompt into `instructions` for the cron engine', () => {
    const out = exec.validate({ target: ' task-1 ', prompt: ' read them ' });
    expect(out).toEqual({ ok: true, config: { target: 'task-1', prompt: 'read them', instructions: 'read them' } });
  });

  it('accepts a legacy payload edit that only set `instructions`', () => {
    const out = exec.validate({ target: 'task-1', instructions: 'from the legacy payload' });
    expect(out.ok && out.config.prompt).toBe('from the legacy payload');
  });
});

describe('session executor: delivery', () => {
  it('sends the fire into the live session and names it in the summary', async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [
        { claudeSessionId: 'dead-1', process_status: 'stopped' },
        { claudeSessionId: 'sid-abcdef12', process_status: 'idle', title: 'PR work' },
      ] as Sessions,
    });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('sent to session PR work [sid-abcd]');
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0].sessionId).toBe('sid-abcdef12');
    expect(calls.sent[0].taskId).toBe('task-1');
    // The envelope reaches the session unchanged — it was already built.
    expect(calls.sent[0].message).toBe(FIRE);
    expect(calls.started).toEqual([]);
  });

  it('ignores an archived session, even a running one', async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [{ claudeSessionId: 'old', process_status: 'running', archived: true }] as Sessions,
      getTask: async () => ({ id: 'task-1', cwd: '/repo', phase: 'IN_PROGRESS' }),
    });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result.status).toBe('ok');
    expect(calls.sent).toEqual([]);
    expect(calls.started).toHaveLength(1);
  });

  // The idle reaper kills the CLI after ~2h of quiet and the record reads
  // 'stopped'; a trigger typically fires hours after the session that set it up
  // went quiet, so this is THE common case. The transcript is intact and a send
  // cold-resumes it, which is what the user's own next message would do too.
  it('resumes a STOPPED session instead of starting a new one (the conversation keeps its memory)', async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [
        { claudeSessionId: 'sid-stopped1', process_status: 'stopped', title: 'Watch the PR' },
      ] as Sessions,
      getTask: async () => ({ id: 'task-1', cwd: '/repo', phase: 'IN_PROGRESS' }),
    });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result).toEqual({
      status: 'ok',
      summary: 'resumed session Watch the PR [sid-stop]',
      // The audit trail's record of this fire: which session, and the exact
      // text it received. Without both, the flyout can only say "delivered".
      delivered: { sessionId: 'sid-stopped1', text: FIRE },
    });
    expect(calls.sent).toEqual([{ sessionId: 'sid-stopped1', message: FIRE, taskId: 'task-1' }]);
    expect(calls.started).toEqual([]);
  });

  it('prefers a live session over a stopped one, and the most recent among equals', async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [
        { claudeSessionId: 'stopped-new', process_status: 'stopped', lastActiveAt: '2026-09-15T12:00:00Z' },
        { claudeSessionId: 'idle-old', process_status: 'idle', lastActiveAt: '2026-09-14T08:00:00Z' },
        { claudeSessionId: 'idle-new', process_status: 'idle', lastActiveAt: '2026-09-14T09:00:00Z' },
      ] as Sessions,
    });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(calls.sent[0].sessionId).toBe('idle-new');
    expect(result.summary).toMatch(/^sent to session/);
  });

  it("an 'error' session is terminal: the task gets a new session, as everywhere else", async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [{ claudeSessionId: 'crashed', process_status: 'error' }] as Sessions,
      getTask: async () => ({ id: 'task-1', cwd: '/repo', phase: 'IN_PROGRESS' }),
    });
    await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(calls.sent).toEqual([]);
    expect(calls.started).toHaveLength(1);
  });

  it('starts a new session on the SAME task when none is resumable, using the task cwd', async () => {
    const { delivery, calls } = fakeDelivery({
      getTask: async () => ({ id: 'task-1', cwd: '/repo/checkout', phase: 'TODO' }),
    });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result).toEqual({
      status: 'ok',
      summary: 'restarted session on task task-1',
      // No session id: this launch has not linked one yet, and the audit says so
      // rather than guessing. The text is still recorded.
      delivered: { text: FIRE },
    });
    expect(calls.started).toEqual([{
      message: FIRE, taskId: 'task-1', cwd: '/repo/checkout', title: 'Trigger: PR comments',
    }]);
  });

  // A session's title is derived from its launch message when the caller gives
  // none, so a trigger's restart used to name it `<walnut-message kind="trigger"…`
  // and nothing renamed it afterwards (observed on prod).
  it('names a restarted session after the trigger, never after the envelope', async () => {
    const { delivery, calls } = fakeDelivery({ getTask: async () => ({ id: 'task-1', phase: 'TODO' }) });
    await createSessionExecutor({ delivery }).run(job({ name: 'Nightly deploy watch' }), REF, FIRE);
    expect(calls.started[0].title).toBe('Trigger: Nightly deploy watch');
    expect(calls.started[0].title).not.toContain('walnut-message');
  });

  it('falls back to the check cwd, then to the Walnut home', async () => {
    const { delivery, calls } = fakeDelivery({ getTask: async () => ({ id: 'task-1', phase: 'TODO' }) });
    const exec = createSessionExecutor({ delivery });
    await exec.run(job(), REF, FIRE);
    expect(calls.started[0].cwd).toBe('/repo');
    await exec.run(job({ check: { run: 'x', host: '__local__' } }), REF, FIRE);
    expect(calls.started[1].cwd).toBe(WALNUT_HOME);
  });

  it('restarts on the trigger host, or the host the old session ran on', async () => {
    const remote = fakeDelivery({ getTask: async () => ({ id: 'task-1', phase: 'TODO' }) });
    await createSessionExecutor(remote).run(job({ check: { run: 'x', host: 'devbox' } }), REF, FIRE);
    expect(remote.calls.started[0].host).toBe('devbox');

    const inherited = fakeDelivery({
      sessionsForTask: async () => [{ claudeSessionId: 'gone', process_status: 'error', host: 'devbox' }] as Sessions,
      getTask: async () => ({ id: 'task-1', phase: 'TODO' }),
    });
    await createSessionExecutor(inherited).run(job(), REF, FIRE);
    expect(inherited.calls.started[0].host).toBe('devbox');
  });

  it('a missing task is an error plus a notification, never a new task', async () => {
    const { delivery, calls } = fakeDelivery({ getTask: async () => null });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result.status).toBe('error');
    expect(result.error).toContain('task task-1 is gone');
    expect(result.error).toContain('will not resurrect it');
    expect(calls.started).toEqual([]);
    expect(calls.notified[0].dedupKey).toBe('trigger-target:job-1:gone');
  });

  it('a COMPLETE task is the same refusal (the human closed it)', async () => {
    const { delivery, calls } = fakeDelivery({ getTask: async () => ({ id: 'task-1', phase: 'COMPLETE' }) });
    const result = await createSessionExecutor({ delivery }).run(job(), REF, FIRE);
    expect(result.status).toBe('error');
    expect(result.error).toContain('is complete');
    expect(calls.started).toEqual([]);
    expect(calls.notified[0].taskId).toBe('task-1');
  });

  it('a plain scheduled run (no envelope yet) is wrapped before delivery', async () => {
    const { delivery, calls } = fakeDelivery({
      sessionsForTask: async () => [{ claudeSessionId: 'sid-1', process_status: 'running' }] as Sessions,
    });
    await createSessionExecutor({ delivery }).run(job({ check: undefined }), REF, 'read them');
    const parsed = parseWalnutMessage(calls.sent[0].message)!;
    expect(parsed.kind).toBe('trigger');
    expect(parsed.attrs.note).toBe('scheduled');
    expect(parsed.body).toBe('read them');
  });
});
