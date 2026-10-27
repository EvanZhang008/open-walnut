/**
 * E2E: a routine run whose session never starts is retried once and then
 * recorded failed where the user and the task's lead see it.
 *
 * Repro of 2026-10-26: this Mac's session daemon could not start, the catch-up
 * run of a twice-daily routine made its task, the spawn failed, and the routine
 * still read "OK" with nothing on the task. Here a real server runs the real
 * claude-code executor and launch path; only the session runner is replaced (by
 * name, after startServer) with one that fails the spawn the way the real one
 * does: the seeded record goes to 'stopped' and a SESSION_ERROR names the cause.
 * The start deadlines are shortened through their env knobs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-routine-start'));

process.env.WALNUT_ROUTINE_START_INLINE_MS = '300';
process.env.WALNUT_ROUTINE_START_DEADLINE_MS = '1500';
process.env.WALNUT_ROUTINE_START_RETRY_MS = '200';
process.env.WALNUT_ROUTINE_START_HOST_WAIT_MS = '0';
process.env.WALNUT_ROUTINE_START_POLL_MS = '50';

import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import type { SessionStartEvent } from '../../src/core/event-types.js';
import { updateSessionRecord } from '../../src/core/session-tracker.js';
import { _resetRoutineRunStarterForTesting } from '../../src/core/routines/run-start-deps.js';
import { _runStartWatchesForTesting } from '../../src/core/routines/run-start.js';

const DAEMON_DOWN = 'Local daemon failed to start — port file not created within 30s, and the Walnut Sessions host (pid 44765) is still running';

let server: HttpServer;
let port: number;
const starts: SessionStartEvent[] = [];
/** How the fake runner treats each start, in order: fail the spawn or bring it up. */
let plan: Array<'fail' | 'up'> = [];

const api = (p: string) => `http://localhost:${port}${p}`;
async function post(p: string, body: unknown): Promise<any> {
  const res = await fetch(api(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return await res.json().catch(() => null);
}
async function get(p: string): Promise<any> {
  return await (await fetch(api(p))).json();
}

function installFailingRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_START) return;
    const d = event.data as SessionStartEvent;
    starts.push(d);
    const sid = d.preassignedSessionId;
    if (!sid) return;
    const what = plan.shift() ?? 'fail';
    setTimeout(() => {
      void (async () => {
        if (what === 'up') {
          await updateSessionRecord(sid, { pid: 4242, outputFile: `remote://__local__/${sid}`, process_status: 'running' });
          return;
        }
        // The transport-start failure path: the record stops, the error rides the bus.
        await updateSessionRecord(sid, { process_status: 'stopped' });
        bus.emit(EventNames.SESSION_ERROR, { sessionId: sid, taskId: d.taskId, error: DAEMON_DOWN }, ['main-ai', 'session-runner'], { source: 'session-runner' });
      })();
    }, 20);
  });
}

async function createRoutine(name: string): Promise<string> {
  const created = await post('/api/routines', {
    name, schedule: { kind: 'every', everyMs: 3_600_000 }, enabled: true,
    executor: { type: 'claude-code', config: { instructions: 'Review the last 12 hours.', cwd: '/tmp', taskTitle: name } },
  });
  return created.job.id;
}

async function settled(): Promise<void> {
  for (let i = 0; i < 100 && _runStartWatchesForTesting().size > 0; i++) {
    await Promise.all([..._runStartWatchesForTesting().values()]);
  }
}

async function taskTitled(title: string): Promise<any> {
  const tasks = await get('/api/tasks');
  const list = Array.isArray(tasks) ? tasks : tasks.tasks;
  return list.find((t: any) => t.title === title);
}

beforeAll(async () => {
  _resetRoutineRunStarterForTesting();
  server = await startServer({ port: 0, dev: true });
  installFailingRunner();
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await settled();
  await stopServer();
  bus.clear();
});

describe('a routine run whose session never starts', () => {
  it('is retried once, then recorded failed on the routine, the task handed back with the reason', async () => {
    starts.length = 0;
    plan = ['fail', 'fail'];
    const id = await createRoutine('Org reflection (never starts)');
    await post(`/api/routines/${id}/run`, {});
    await settled();

    // Two launches on ONE task: the run and its single retry.
    expect(starts).toHaveLength(2);
    expect(starts[1].taskId).toBe(starts[0].taskId);
    expect(starts[1].preassignedSessionId).not.toBe(starts[0].preassignedSessionId);

    const { job } = await get(`/api/routines/${id}`);
    expect(job.state.lastStatus).toBe('error');
    expect(job.state.lastError).toContain('never started (tried twice)');
    expect(job.state.lastError).toContain('port file not created');
    expect(job.state.fireLog?.[0]?.delivery?.status).toBe('error');

    const task = await taskTitled('Org reflection (never starts)');
    expect(task.id).toBe(starts[0].taskId);
    expect(task.phase).toBe('NEED_ACTION');
    expect(task.note).toContain('did not run');
    expect(task.routine_start).toMatchObject({ state: 'failed', attempt: 2, job_id: id });
    expect(task.routine_start.launch).toBeUndefined();

    const sessions = (await get(`/api/sessions/task/${task.id}`)).sessions as any[];
    expect(sessions.every((s) => s.process_status === 'error' || s.process_status === 'stopped')).toBe(true);
  });

  it('a retry that starts leaves the run OK and says it started on the second try', async () => {
    starts.length = 0;
    plan = ['fail', 'up'];
    const id = await createRoutine('Org reflection (second try)');
    await post(`/api/routines/${id}/run`, {});
    await settled();

    expect(starts).toHaveLength(2);
    const { job } = await get(`/api/routines/${id}`);
    expect(job.state.lastStatus).toBe('ok');
    expect(job.state.lastError).toBeUndefined();
    expect(job.state.fireLog?.[0]?.delivery?.summary).toContain('second try');
    const task = await taskTitled('Org reflection (second try)');
    expect(task.routine_start).toMatchObject({ state: 'started', attempt: 2 });
    // No "did not run" note: the run happened (the runner's own spawn edge moves the phase).
    expect(task.note ?? '').not.toContain('did not run');
  });

  it('a session that comes up is confirmed inline and never retried', async () => {
    starts.length = 0;
    plan = ['up'];
    const id = await createRoutine('Org reflection (starts)');
    await post(`/api/routines/${id}/run`, {});
    await settled();
    expect(starts).toHaveLength(1);
    const { job } = await get(`/api/routines/${id}`);
    expect(job.state.lastStatus).toBe('ok');
    const task = await taskTitled('Org reflection (starts)');
    expect(task.routine_start).toMatchObject({ state: 'started', attempt: 1 });
  });
});
