/**
 * A routine delivers to a task, never to a bare session
 * (src/core/routines/target-repair.ts, the session executor's guard), and a run
 * whose session never started can still change the routine's card after its
 * dispatch returned (cron ops recordRunStartFailure).
 *
 * 2026-10-27: routines ran in an old home chat session that had no task.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { planTargetRepairs } from '../../../src/core/routines/target-repair.js';
import { createSessionExecutor, type SessionDelivery } from '../../../src/core/routines/executors/session.js';
import { CronService } from '../../../src/core/cron/service.js';
import type { CronJob, CronServiceDeps } from '../../../src/core/cron/types.js';

function sessionJob(id: string, target: string): CronJob {
  return {
    id, name: `job ${id}`, enabled: true, createdAtMs: 0, updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 3_600_000 }, sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'go' },
    executor: { type: 'session', config: { target, prompt: 'go', instructions: 'go' } },
    state: {},
  } as CronJob;
}

describe('planTargetRepairs', () => {
  const tasks = new Set(['task-a', 'task-main']);
  const sessions: Record<string, { taskId?: string; legacyTaskId?: string; lane?: string }> = {
    'sid-with-task': { taskId: 'task-a' },
    'sid-detached': { taskId: '', legacyTaskId: 'task-a' },
    'sid-home-chat': { taskId: '', lane: 'chat:general:conv-1' },
    'sid-orphan': { taskId: '' },
  };
  const deps = {
    isTask: async (id: string) => tasks.has(id),
    session: async (id: string) => sessions[id] ?? null,
    mainTaskId: async () => 'task-main',
  };

  it('leaves task targets alone, and targets that are neither a task nor a session', async () => {
    expect(await planTargetRepairs([sessionJob('1', 'task-a'), sessionJob('2', 'nothing-here')], deps)).toEqual([]);
  });

  it('a session target goes to its task, or the task it was detached from', async () => {
    expect(await planTargetRepairs([sessionJob('1', 'sid-with-task'), sessionJob('2', 'sid-detached')], deps)).toEqual([
      { id: '1', from: 'sid-with-task', retarget: 'task-a' },
      { id: '2', from: 'sid-detached', retarget: 'task-a' },
    ]);
  });

  it('the home chat lane session (the old main agent) becomes the Main task', async () => {
    expect(await planTargetRepairs([sessionJob('1', 'sid-home-chat')], deps)).toEqual([
      { id: '1', from: 'sid-home-chat', retarget: 'task-main' },
    ]);
  });

  it('any other taskless session switches the routine off with the reason, never guessing a task', async () => {
    const [r] = await planTargetRepairs([sessionJob('1', 'sid-orphan')], deps);
    expect(r.retarget).toBeUndefined();
    expect(r.disable).toContain('session with no task');
  });

  it('only session routines are looked at', async () => {
    const other = { ...sessionJob('1', 'sid-orphan'), executor: { type: 'claude-code', config: { target: 'sid-orphan' } } } as CronJob;
    expect(await planTargetRepairs([other], deps)).toEqual([]);
  });
});

describe('session executor: a taskless session is never a target', () => {
  function delivery(over: Partial<SessionDelivery>): SessionDelivery & { sent: string[]; started: string[]; notes: string[] } {
    const sent: string[] = [];
    const started: string[] = [];
    const notes: string[] = [];
    return {
      sent, started, notes,
      sessionsForTask: async (taskId) => (taskId === 'task-a' ? [{ claudeSessionId: 'sid-live', process_status: 'idle' }] : []),
      sendToSession: async (sid) => { sent.push(sid); },
      getTask: async (id) => (id === 'task-a' ? { id: 'task-a' } : null),
      taskOfSession: async (id) => (id === 'sid-with-task' ? 'task-a' : id === 'sid-orphan' ? '' : undefined),
      startSession: async ({ taskId }) => { started.push(taskId); return {}; },
      notify: async (n) => { notes.push(n.title); },
      ...over,
    };
  }

  it('a target naming a session with a task delivers to that task\'s conversation', async () => {
    const d = delivery({});
    const ex = createSessionExecutor({ delivery: d });
    const res = await ex.run(sessionJob('1', 'sid-with-task'), { type: 'session', config: { target: 'sid-with-task', prompt: 'go' } }, 'go');
    expect(res.status).toBe('ok');
    expect(d.sent).toEqual(['sid-live']);
  });

  it('a target naming a taskless session is refused, with nothing sent or started', async () => {
    const d = delivery({});
    const ex = createSessionExecutor({ delivery: d });
    const res = await ex.run(sessionJob('1', 'sid-orphan'), { type: 'session', config: { target: 'sid-orphan', prompt: 'go' } }, 'go');
    expect(res.status).toBe('error');
    expect(res.error).toContain('session with no task');
    expect(d.sent).toEqual([]);
    expect(d.started).toEqual([]);
    expect(d.notes).toHaveLength(1);
  });
});

describe('cron store: verdicts learned after the dispatch', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-target-repair-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  function service(over: Partial<CronServiceDeps> = {}): CronService {
    const deps: CronServiceDeps = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as never,
      storePath: path.join(tmp, 'cron-jobs.json'),
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      onEvent: vi.fn(),
      ...over,
    };
    return new CronService(deps);
  }

  async function addRoutine(s: CronService, target = 'task-a'): Promise<CronJob> {
    return await s.add({
      name: 'Org reflection', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 },
      sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'go' },
      executor: { type: 'session', config: { target, prompt: 'go', instructions: 'go' } },
    } as never);
  }

  it('a run whose session never started turns the card to Error with the reason and a History row', async () => {
    const s = service();
    const job = await addRoutine(s);
    const runAt = Date.now() - 60_000;
    expect(await s.recordRunStartFailure(job.id, { runAtMs: runAt, error: 'The session for this run never started (tried twice): daemon down', ref: 'task-r1' })).toBe(true);
    const [after] = (await s.list({ includeDisabled: true })).filter((j) => j.id === job.id);
    expect(after.state.lastStatus).toBe('error');
    expect(after.state.lastError).toContain('never started');
    expect(after.state.consecutiveErrors).toBe(1);
    expect(after.state.fireLog?.[0]).toMatchObject({ atMs: runAt, outcome: 'fired', delivery: { status: 'error' } });
    expect(after.state.fireLog?.[0].delivery?.summary).toContain('task-r1');
  });

  it('a later run that already replaced the card keeps it; only the History row is added', async () => {
    const s = service({ runExecutor: async () => ({ status: 'ok', summary: 'task task-new delivered' }) });
    const job = await addRoutine(s);
    const runAt = Date.now() - 3_600_000;
    await s.run(job.id, 'force');  // a newer run that went fine
    await s.recordRunStartFailure(job.id, { runAtMs: runAt, error: 'never started', ref: 'task-old' });
    const [after] = (await s.list({ includeDisabled: true })).filter((j) => j.id === job.id);
    expect(after.state.lastStatus).toBe('ok');
    expect(after.state.lastError).toBeUndefined();
    expect(after.state.fireLog?.some((e) => e.delivery?.summary?.includes('task-old'))).toBe(true);
  });

  it('target repairs apply only where the stored target is still the one decided on', async () => {
    const s = service();
    const a = await addRoutine(s, 'sid-with-task');
    const b = await addRoutine(s, 'sid-orphan');
    const c = await addRoutine(s, 'sid-edited');
    const done = await s.applyTargetRepairs([
      { id: a.id, from: 'sid-with-task', retarget: 'task-a' },
      { id: b.id, from: 'sid-orphan', disable: 'Switched off: no task' },
      { id: c.id, from: 'sid-was-before-edit', retarget: 'task-x' },
    ]);
    expect(done.sort()).toEqual([a.id, b.id].sort());
    const jobs = await s.list({ includeDisabled: true });
    const byId = (id: string) => jobs.find((j) => j.id === id)!;
    expect((byId(a.id).executor!.config as { target: string }).target).toBe('task-a');
    expect(byId(b.id).enabled).toBe(false);
    expect(byId(b.id).state.lastError).toBe('Switched off: no task');
    expect((byId(c.id).executor!.config as { target: string }).target).toBe('sid-edited');
  });
});
