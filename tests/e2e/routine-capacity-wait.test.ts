import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { SessionStartEvent } from '../../src/core/event-types.js'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-routine-capacity'))
process.env.WALNUT_START_QUEUE = '0'
process.env.WALNUT_ROUTINE_START_INLINE_MS = '0'
process.env.WALNUT_ROUTINE_START_DEADLINE_MS = '2000'
process.env.WALNUT_ROUTINE_START_POLL_MS = '10'

import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addTask, getTask, listTasks, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionExecutor } from '../../src/core/routines/executors/session.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { admitHostStart, __setHostViewForTesting, __resetHostAdmissionForTesting } from '../../src/core/sessions/host-admission.js'
import { drainStartQueue, cancelQueuedStartByPerson, startQueuedNow, queueOrder } from '../../src/core/sessions/start-queue.js'
import { _resetRoutineRunStarterForTesting, routineRunStarter } from '../../src/core/routines/run-start-deps.js'
import { _runStartWatchesForTesting } from '../../src/core/routines/run-start.js'

let root: string
let full = true
const starts: SessionStartEvent[] = []
async function post(path: string, body: unknown) {
  const response = await fetch(root + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(response.ok).toBe(true)
  return response.json()
}
beforeAll(async () => {
  _resetRoutineRunStarterForTesting()
  __setHostViewForTesting(async host => ({ host, label: 'This host', known: true, running: full ? 7 : 0, runningLimit: 7,
    full, fullReasons: full ? ['all 7 slots taken'] : [], busy: full, reasons: [], score: full ? 0 : 1 }))
  const server = await startServer({ port: 0, dev: true })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  root = `http://localhost:${address.port}`
  installRunner()
}, 30_000)
function installRunner() {
  bus.subscribe('session-runner', event => {
    if (event.name !== EventNames.SESSION_START) return
    const data = event.data as SessionStartEvent
    starts.push(data)
    if (data.preassignedSessionId) void updateSessionRecord(data.preassignedSessionId, { process_status: 'running', pid: 4242, outputFile: 'fixture-output' })
  })
}
afterAll(async () => {
  __setHostViewForTesting(null)
  __resetHostAdmissionForTesting()
  _resetRoutineRunStarterForTesting()
  for (const promise of _runStartWatchesForTesting().values()) await promise
  await stopServer()
  delete process.env.WALNUT_START_QUEUE
})

describe('a routine run with no capacity', () => {
  it('persists the original run immediately, outlives its spawn deadline, then starts once on release', async () => {
    const created = await post('/api/routines', { name: 'Capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Check the original batch. '.repeat(100), cwd: '/tmp', taskTitle: 'Capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const state = await (await fetch(root + `/api/routines/${created.job.id}`)).json()
    expect(JSON.stringify(state.job.state)).toContain('waiting for a free slot')
    const task = (await listTasks()).find(t => t.title === 'Capacity run')!
    expect(task.start_queue).toMatchObject({ wait_for_slot: true, routine: { message: 'Check the original batch. '.repeat(100).trim() } })
    expect(starts).toEqual([])
    expect(_runStartWatchesForTesting().size).toBe(0)
    // The accepted wait is older than the spawn deadline: no timeout may discard this run.
    await updateTaskRaw(task.id, { routine_start: { ...task.routine_start!, attempt_at: new Date(Date.now() - 3_600_000).toISOString() } })
    expect((await drainStartQueue()).held).toContain(task.id)
    full = false
    const passes = await Promise.all([drainStartQueue(), drainStartQueue()])
    expect(passes[0].started).toEqual([task.id])
    expect(starts).toHaveLength(1)
    expect(starts[0].taskId).toBe(task.id)
    expect(starts[0].message).toContain('Check the original batch.')
    for (const promise of _runStartWatchesForTesting().values()) await promise
    expect((await getTask(task.id)).routine_start?.state).toBe('started')
    expect((await getTask(task.id)).start_queue).toBeFalsy()
  }, 30_000)

  it('a trigger starting a missing conversation uses the same persistent capacity wait', async () => {
    full = true
    const { task } = await addTask({ title: 'Trigger capacity target', cwd: '/tmp', source: 'local' })
    const ref = { type: 'session', config: { target: task.id, prompt: 'Read trigger content.' } }
    const job = { id: 'capacity-trigger-without-service', name: 'Capacity trigger', enabled: true, state: {}, check: { cwd: '/tmp' } } as never
    const result = await createSessionExecutor().run(job, ref, 'The original trigger item.')
    expect(result.summary).toContain('waiting for a free slot')
    expect(result.delivered).toBeUndefined()
    const waiting = await getTask(task.id)
    expect(waiting.start_queue?.routine?.message).toContain('The original trigger item.')
    // Disable the job lookup only for this manually constructed trigger fixture.
    await updateTaskRaw(task.id, { start_queue: { ...waiting.start_queue!, routine: { ...waiting.start_queue!.routine!, jobId: undefined } } })
    full = false
    expect((await drainStartQueue()).started).toContain(task.id)
    expect(starts.filter(s => s.taskId === task.id)).toHaveLength(1)
    expect(starts.at(-1)?.message).toContain('The original trigger item.')
  }, 30_000)

  it('a cancelled waiting run never starts', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Cancelled capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Read only.', cwd: '/tmp', taskTitle: 'Cancelled capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Cancelled capacity run')!
    await cancelQueuedStartByPerson(task.id)
    full = false
    await drainStartQueue()
    expect(starts.some(s => s.taskId === task.id)).toBe(false)
    expect((await getTask(task.id)).routine_start?.state).toBe('failed')
  }, 30_000)

  it('the same dispatched run is one persistent wait across simultaneous and later deliveries', async () => {
    full = true
    const starter = await routineRunStarter()
    const input = { job: { id: 'dedup-capacity-job', name: 'Deduplicated run' }, runAtMs: Date.now(),
      launch: { message: 'Original delivered trigger content.', cwd: '/tmp', taskTitle: 'Deduplicated run', source: 'cron-isolated' } }
    const results = await Promise.all([starter.start(input), starter.start(input), starter.start(input)])
    expect(new Set(results.map(r => r.task.id)).size).toBe(1)
    _resetRoutineRunStarterForTesting()
    expect((await (await routineRunStarter()).start(input)).task.id).toBe(results[0].task.id)
    const queued = (await getTask(results[0].task.id)).start_queue
    await stopServer()
    const restarted = await startServer({ port: 0, dev: true })
    const address = restarted.address()
    if (!address || typeof address === 'string') throw new Error('No restarted port')
    root = `http://localhost:${address.port}`
    installRunner()
    expect((await getTask(results[0].task.id)).start_queue).toEqual(queued)
    await cancelQueuedStartByPerson(results[0].task.id)
  }, 30_000)

  it('a paused routine keeps its wait and resumes without another dispatched run', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Paused capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Paused instructions.', cwd: '/tmp', taskTitle: 'Paused capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Paused capacity run')!
    await fetch(root + `/api/routines/${created.job.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    full = false
    expect((await drainStartQueue()).held).toContain(task.id)
    expect(starts.some(s => s.taskId === task.id)).toBe(false)
    // A disabled wait cannot reserve every empty slot ahead of other automatic starts.
    const release = await admitHostStart('independent-ready-task', '__local__', { automatic: true, respectWaiting: true })
    release()
    await fetch(root + `/api/routines/${created.job.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect((await drainStartQueue()).started).toContain(task.id)
    for (const promise of _runStartWatchesForTesting().values()) await promise
  }, 30_000)

  it('removing a waiting routine makes its start terminal across boot pickup', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Removed capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Never run removed work.', cwd: '/tmp', taskTitle: 'Removed capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Removed capacity run')!
    expect((await fetch(root + `/api/routines/${created.job.id}`, { method: 'DELETE' })).ok).toBe(true)
    full = false
    expect((await drainStartQueue()).dropped).toContain(task.id)
    const removed = await getTask(task.id)
    expect(removed.start_queue).toBeFalsy()
    expect(removed.routine_start?.state).toBe('failed')
    expect(removed.routine_start?.launch).toBeUndefined()
    const starter = await routineRunStarter()
    starter.resume(task.id, removed.routine_start!)
    expect(_runStartWatchesForTesting().has(task.id)).toBe(false)
    expect(starts.some(s => s.taskId === task.id)).toBe(false)
  }, 30_000)

  it('Start now and the automatic drain share one claim without failing the winner', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Racing capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Exactly one launch.', cwd: '/tmp', taskTitle: 'Racing capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Racing capacity run')!
    full = false
    const results = await Promise.allSettled([startQueuedNow(task.id), drainStartQueue()])
    expect(results.some(r => r.status === 'fulfilled')).toBe(true)
    for (const promise of _runStartWatchesForTesting().values()) await promise
    expect(starts.filter(s => s.taskId === task.id)).toHaveLength(1)
    expect((await getTask(task.id)).routine_start?.state).toBe('started')
    expect((await getTask(task.id)).routine_start?.error).toBeUndefined()
  }, 30_000)

  it('ten dispatched rounds retain their identities and take one newly freed slot per pass', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Backlogged capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Backlog.', cwd: '/tmp' } } })
    const starter = await routineRunStarter()
    const at = Date.now()
    const runs = await Promise.all(Array.from({ length: 10 }, (_, i) => starter.start({
      job: { id: created.job.id, name: created.job.name }, runAtMs: at + i,
      launch: { message: `Original round ${i}.`, cwd: '/tmp', taskTitle: `Backlogged run ${i}`, source: 'routine' },
    })))
    expect(new Set(runs.map(r => r.task.id)).size).toBe(10)
    expect(runs.every(r => r.queued)).toBe(true)
    const line = runs.map(r => r.task).sort(queueOrder)
    let slotConsumed = false
    __setHostViewForTesting(async host => ({ host, label: 'This host', known: true, running: slotConsumed ? 1 : 0,
      runningLimit: 1, full: slotConsumed, fullReasons: slotConsumed ? ['all 1 slots taken'] : [], busy: slotConsumed,
      reasons: [], score: slotConsumed ? 0 : 1 }))
    bus.subscribe('capacity-slot-consumed', event => {
      if (event.name === EventNames.SESSION_START && runs.some(r => r.task.id === (event.data as SessionStartEvent).taskId)) slotConsumed = true
    }, { global: true, interest: [EventNames.SESSION_START] })
    try {
      for (let i = 0; i < 10; i += 1) {
        slotConsumed = false
        expect((await drainStartQueue()).started).toEqual([line[i].id])
      }
      for (const promise of _runStartWatchesForTesting().values()) await promise
      for (let i = 0; i < 10; i += 1) {
        const launch = starts.filter(s => s.taskId === runs[i].task.id)
        expect(launch).toHaveLength(1)
        expect(launch[0].message).toContain(`Original round ${i}.`)
        expect((await getTask(runs[i].task.id)).routine_start?.run_at).toBe(new Date(at + i).toISOString())
      }
    } finally {
      bus.unsubscribe('capacity-slot-consumed')
      __setHostViewForTesting(async host => ({ host, label: 'This host', known: true, running: full ? 7 : 0, runningLimit: 7,
        full, fullReasons: full ? ['all 7 slots taken'] : [], busy: full, reasons: [], score: full ? 0 : 1 }))
    }
  }, 30_000)

  it('cancelling during admission drops the replay without recording a launch failure', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Cancelled admission routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Cancel during admission.', cwd: '/tmp', taskTitle: 'Cancelled admission run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Cancelled admission run')!
    let entered!: () => void
    let release!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    __setHostViewForTesting(async host => {
      entered()
      await gate
      return { host, label: 'This host', known: true, running: 0, runningLimit: 7, full: false, fullReasons: [], busy: false, reasons: [], score: 1 }
    })
    const drain = drainStartQueue()
    await entering
    await cancelQueuedStartByPerson(task.id)
    release()
    expect((await drain).dropped).toContain(task.id)
    expect((await getTask(task.id)).routine_start?.error).toContain('user cancelled')
    expect(starts.some(s => s.taskId === task.id)).toBe(false)
    __setHostViewForTesting(async host => ({ host, label: 'This host', known: true, running: full ? 7 : 0, runningLimit: 7,
      full, fullReasons: full ? ['all 7 slots taken'] : [], busy: full, reasons: [], score: full ? 0 : 1 }))
  }, 30_000)

  it('a conversation created while its trigger waits records a terminal delivery failure instead of losing the fire quietly', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Existing trigger wait', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Configuration only.', cwd: '/tmp' } } })
    const { task } = await addTask({ title: 'Started elsewhere target', cwd: '/tmp', source: 'local' })
    const { defaultRunStartDeps } = await import('../../src/core/routines/run-start-deps.js')
    await defaultRunStartDeps().launch({ message: 'Still owed trigger content.', cwd: '/tmp', source: 'routine-trigger', jobId: created.job.id }, { existingTaskId: task.id })
    const waiting = await getTask(task.id)
    await updateTaskRaw(task.id, { last_start: { id: 'human-start', state: 'started', at: new Date(Date.parse(waiting.start_queue!.at) + 1).toISOString() } })
    expect((await drainStartQueue()).dropped).toContain(task.id)
    const state = await (await fetch(root + `/api/routines/${created.job.id}`)).json()
    expect(JSON.stringify(state.job.state)).toContain('started since queued')
    expect((await getTask(task.id)).start_queue).toBeFalsy()
  }, 30_000)

  it('Start now keeps the routine launch and starts once even when the host is still full', async () => {
    full = true
    const created = await post('/api/routines', { name: 'Immediate capacity routine', enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'claude-code', config: { instructions: 'Original immediate instructions.', cwd: '/tmp', taskTitle: 'Immediate capacity run' } } })
    await post(`/api/routines/${created.job.id}/run`, {})
    const task = (await listTasks()).find(t => t.title === 'Immediate capacity run')!
    expect((await startQueuedNow(task.id))?.started).toBe(true)
    expect(starts.filter(s => s.taskId === task.id)).toHaveLength(1)
    expect(starts.at(-1)?.message).toContain('Original immediate instructions.')
    expect((await getTask(task.id)).start_queue).toBeFalsy()
    for (const promise of _runStartWatchesForTesting().values()) await promise
  }, 30_000)
})
