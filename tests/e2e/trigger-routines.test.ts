/**
 * walnut-trigger through the real server: create, test, and the daemon's reports.
 *
 * The daemon half is driven two ways on purpose:
 *  - the DAEMON LOOKUP is stubbed (a real `triggers-v1` daemon needs a deployed
 *    binary, which no test server has), so `triggers.test` / `triggers.ack` are
 *    asserted as the exact RPCs the server sends;
 *  - the EVENTS are handed to the registered sink directly, which is what the
 *    socket handler does — everything after that point (dedup, history,
 *    auto-disable, delivery) is the real code path.
 *
 * Delivery is asserted where it actually lands: the mock daemon's `send` command
 * history for the live session on the target task.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerChecked, handleTriggerEvent, handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { listNotifications } from '../../src/core/notifications/store.js'
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../src/providers/trigger-check-core.js'
import { FIRE_DELIVERY_MAX_ATTEMPTS } from '../../src/core/cron/trigger-apply.js'
import { registerExecutor } from '../../src/core/routines/registry.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

/** Every RPC the server aimed at a daemon, in order. */
const sends: Array<{ cmd: string; params: Record<string, unknown> }> = []

const TEST_RESULT = {
  ok: true, exitCode: 0, durationMs: 12, stdoutTail: '{"fire":true}',
  stderrTail: '', parsed: { fire: true, hasState: false }, error: null,
  wouldFire: true, newItemCount: 1,
}

function fakeDaemon(caps: string[] = ['triggers-v1'], opts: { pushed?: boolean } = {}): TriggerDaemon {
  return {
    host: '__local__',
    hasCapability: (cap) => caps.includes(cap),
    // The default fake is a daemon THIS server has armed (the common case).
    triggersPushed: opts.pushed ?? true,
    async send(cmd, params = {}) {
      sends.push({ cmd, params })
      if (cmd === 'triggers.test') return { ok: true, result: TEST_RESULT }
      return { ok: true }
    },
  }
}

/** Stub the lookup for the duration of one call. */
function withDaemon(conn: TriggerDaemon | null): void {
  setTriggerDaemonLookupForTest(() => conn)
}

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function get(p: string) {
  const res = await fetch(apiUrl(p))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function jobState(id: string) {
  const { json } = await get(`/api/routines/${id}`)
  return json.job
}

/** Envelopes the server has actually written toward a session's CLI. */
function envelopesSentToDaemon(): string[] {
  return daemon.getCommandHistoryFor('send')
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((text) => text.includes('<walnut-message kind="trigger"'))
}

/**
 * Wait for a delivery to reach the daemon. Delivery is queue-then-write, so a
 * bare assertion right after the sink returns races the write — and asserting
 * "0 envelopes" without a settle window would pass before anything could arrive.
 */
async function waitForEnvelopes(min: number, timeoutMs = 8_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let found = envelopesSentToDaemon()
  while (found.length < min && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    found = envelopesSentToDaemon()
  }
  return found
}

/** Give a delivery that must NOT happen time to happen. */
async function settle(ms = 500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  withDaemon(fakeDaemon())
}, 60_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── the session a trigger is created from ──

let sessionId = ''
let taskId = ''
const SESSION_CWD = '/tmp'

describe('POST /api/v1/routines/trigger', () => {
  it('resolves target, host and cwd from the calling session', async () => {
    const started = await post('/api/sessions/quick-start', {
      cwd: SESSION_CWD, message: 'work on the PR',
    })
    expect(started.status).toBe(200)
    sessionId = started.json.sessionId
    taskId = started.json.taskId
    expect(sessionId).toBeTruthy()

    const created = await post('/api/v1/routines/trigger', {
      run: 'bash ~/.open-walnut/triggers/pr/check.sh',
      every: '5m',
      prompt: 'Read each new comment and change the code where it asks.',
    }, { 'x-walnut-caller-sid': sessionId })

    expect(created.status).toBe(201)
    expect(created.json.host).toBe('__local__')
    // Always null: the daemon owns the clock and reports the real next check.
    expect(created.json.nextCheckAt).toBeNull()
    const job = created.json.job
    expect(job.check).toMatchObject({ run: 'bash ~/.open-walnut/triggers/pr/check.sh', host: '__local__', cwd: SESSION_CWD })
    expect(job.executor).toEqual({
      type: 'session',
      config: {
        target: taskId,
        prompt: 'Read each new comment and change the code where it asks.',
        instructions: 'Read each new comment and change the code where it asks.',
      },
    })
    expect(job.schedule).toMatchObject({ kind: 'every', everyMs: 300_000 })
    // The name is the prompt itself when none was given (short enough to keep whole).
    expect(job.name).toBe('Read each new comment and change the code where it asks.')
    // The server never invents a next check time for a check job.
    expect(job.state.nextRunAtMs).toBeUndefined()
  })

  it('refuses "this" when nothing says who is calling', async () => {
    const r = await post('/api/v1/routines/trigger', { run: 'x', every: '5m', prompt: 'p' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('no calling session')
  })

  it('refuses an unknown task as the target instead of arming a trigger that can never deliver', async () => {
    const r = await post('/api/v1/routines/trigger', {
      run: 'x', every: '5m', prompt: 'p', session: 'task-that-never-existed',
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('no task task-that-never-existed')
  })

  it('refuses a cadence faster than the floor', async () => {
    const r = await post('/api/v1/routines/trigger', {
      run: 'x', every: '2s', prompt: 'p', session: taskId,
    }, { 'x-walnut-caller-sid': sessionId })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('at least 10s')
  })
})

describe('save-time validation of a check', () => {
  it('refuses a cron schedule: a poll is an interval', async () => {
    const r = await post('/api/routines', {
      name: 'cron check',
      schedule: { kind: 'cron', expr: '0 * * * *' },
      check: { run: 'bash check.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('use every, not cron')
  })

  it('refuses a schedule-only patch that would move a stored trigger onto a wall clock', async () => {
    const created = await post('/api/routines', {
      name: 'interval check',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash check.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    expect(created.status).toBe(201)
    const id = (created.json as { job: { id: string } }).job.id
    const res = await fetch(apiUrl(`/api/routines/${id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: { kind: 'cron', expr: '0 9 * * *' } }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('use every, not cron')
    // The stored trigger is untouched.
    const after = await get(`/api/routines/${id}`)
    expect((after.json as { job: { schedule: unknown } }).job.schedule).toMatchObject({ kind: 'every', everyMs: 600_000 })
    await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
  })

  it('refuses a check with no command instead of storing a plain routine', async () => {
    const r = await post('/api/routines', {
      name: 'empty check',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: '  ' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('check.run is required')
  })

  it('names the upgrade when the host daemon is too old, and the outage when it is cold', async () => {
    const body = {
      name: 'host check',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash check.sh', host: 'devbox' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    }
    withDaemon(fakeDaemon([]))
    const old = await post('/api/routines', body)
    expect(old.status).toBe(400)
    expect(JSON.stringify(old.json)).toContain('upgrade the daemon on devbox')

    withDaemon(null)
    const cold = await post('/api/routines', body)
    expect(cold.status).toBe(503)
    expect(JSON.stringify(cold.json)).toContain('is not connected')

    withDaemon(fakeDaemon())
  })
})

describe('POST /api/v1/routines/check-test', () => {
  it('relays to the host daemon and answers with its result', async () => {
    sends.length = 0
    const r = await post('/api/v1/routines/check-test', {
      check: { run: 'bash check.sh', cwd: '/repo', timeoutSeconds: 9_999 },
      id: 'job-abc',
    })
    expect(r.status).toBe(200)
    expect(r.json.result).toMatchObject({ wouldFire: true, newItemCount: 1 })
    const rpc = sends.find((s) => s.cmd === 'triggers.test')!
    expect(rpc.params.check).toEqual({ run: 'bash check.sh', cwd: '/repo', timeoutSeconds: 300 })
    // `triggerId`, never `id`: send() spreads params over the frame's own `id`,
    // and the reply would be dropped as unmatched.
    expect(rpc.params.triggerId).toBe('job-abc')
    expect(rpc.params.id).toBeUndefined()
  })

  it('says WHY it cannot run when the host has no daemon', async () => {
    withDaemon(null)
    const r = await post('/api/v1/routines/check-test', { check: { run: 'bash check.sh', host: 'devbox' } })
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.json)).toContain('daemon on devbox is not connected')
    withDaemon(fakeDaemon())
  })

  it('requires a command', async () => {
    const r = await post('/api/v1/routines/check-test', { check: {} })
    expect(r.status).toBe(400)
  })
})

describe('trigger.checked from the daemon', () => {
  let quietJobId = ''

  beforeAll(async () => {
    const created = await post('/api/routines', {
      name: 'quiet watcher',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash quiet.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    quietJobId = created.json.job.id
  })

  it('a quiet check records the report and the daemon-reported next time', async () => {
    const nextRunAtMs = Date.now() + 600_000
    await handleTriggerChecked('__local__', {
      type: 'trigger.checked', id: quietJobId, atMs: 1_700_000_000_000, outcome: 'quiet',
      reason: 'all-seen', durationMs: 42, nextRunAtMs, consecutiveErrors: 0,
    })
    const job = await jobState(quietJobId)
    expect(job.state.lastCheck).toEqual({
      atMs: 1_700_000_000_000, outcome: 'quiet', reason: 'all-seen', durationMs: 42,
    })
    expect(job.state.nextRunAtMs).toBe(nextRunAtMs)
    expect(job.enabled).toBe(true)
    // A quiet check is not a routine RUN: it must not fake a history line.
    expect(job.state.lastStatus).toBeUndefined()
  })

  it('the LIST endpoint carries check + lastCheck (the card reads them from there)', async () => {
    const { json } = await get('/api/routines?includeDisabled=true')
    const row = json.jobs.find((j: any) => j.id === quietJobId)
    expect(row.check).toMatchObject({ run: 'bash quiet.sh', host: '__local__' })
    expect(row.state.lastCheck).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    expect(row.schedule).toMatchObject({ kind: 'every', everyMs: 600_000 })
  })

  it('an event for a routine that no longer exists is ignored, not thrown', async () => {
    await expect(handleTriggerChecked('__local__', {
      type: 'trigger.checked', id: 'gone-job', atMs: 1, outcome: 'quiet',
      durationMs: 1, nextRunAtMs: 2, consecutiveErrors: 0,
    })).resolves.toBeUndefined()
  })

  it(`${MAX_CONSECUTIVE_CHECK_ERRORS} check errors in a row disable the trigger and notify`, async () => {
    const created = await post('/api/routines', {
      name: 'broken watcher',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash broken.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    const id = created.json.job.id
    for (let i = 1; i <= MAX_CONSECUTIVE_CHECK_ERRORS; i++) {
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id, atMs: Date.now(), outcome: 'error',
        error: 'exit 127: jq: command not found', durationMs: 5,
        nextRunAtMs: Date.now() + 600_000, consecutiveErrors: i,
      })
      const job = await jobState(id)
      expect(job.state.consecutiveErrors).toBe(i)
      expect(job.enabled).toBe(i < MAX_CONSECUTIVE_CHECK_ERRORS)
    }
    const job = await jobState(id)
    expect(job.state.lastCheck.outcome).toBe('error')
    expect(job.state.lastCheck.error).toContain('jq: command not found')
    expect(job.state.lastStatus).toBe('error')
    // A disabled trigger has no next check at all.
    expect(job.state.nextRunAtMs).toBeUndefined()

    const { feed } = await listNotifications()
    const note = feed.find((n) => n.dedupKey === `trigger-disabled:${id}`)
    expect(note?.title).toContain('broken watcher')
    expect(note?.body).toContain('jq: command not found')
  })
})

describe('trigger.fired from the daemon', () => {
  let firedJobId = ''

  beforeAll(async () => {
    const created = await post('/api/v1/routines/trigger', {
      name: 'fire watcher',
      run: 'bash fire.sh',
      every: '5m',
      prompt: 'Read each new comment.',
      session: taskId,
    })
    firedJobId = created.json.job.id
  })

  it('delivers ONE envelope into the live session, records the seq, and acks', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    const nextRunAtMs = Date.now() + 300_000
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: firedJobId, seq: 1, atMs: 1_700_000_000_000,
      items: [{ id: 'PR-1#c1', title: 'please rename this' }],
      input: 'the check also saw a failing build',
      durationMs: 33, nextRunAtMs,
    })

    // Delivery, where it actually lands: the daemon's stdin write for the
    // session on the target task.
    const delivered = await waitForEnvelopes(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('from="Trigger: fire watcher"')
    expect(delivered[0]).toContain('Read each new comment.')
    expect(delivered[0]).toContain('PR-1#c1')
    expect(delivered[0]).toContain('the check also saw a failing build')

    const job = await jobState(firedJobId)
    expect(job.state.lastFireSeq).toBe(1)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.lastCheck).toMatchObject({ outcome: 'fired', items: 1, durationMs: 33 })
    expect(job.state.nextRunAtMs).toBe(nextRunAtMs)

    const ack = sends.find((s) => s.cmd === 'triggers.ack')!
    expect(ack.params).toEqual({ triggerId: firedJobId, seq: 1 })
    expect(ack.params.id).toBeUndefined()
  })

  it('a replayed seq is acked again but delivered only once', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: firedJobId, seq: 1, atMs: Date.now(),
      items: [{ id: 'PR-1#c1' }], durationMs: 1, nextRunAtMs: Date.now() + 300_000,
    })
    await settle()
    expect(envelopesSentToDaemon()).toEqual([])
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toHaveLength(1)
  })

  it('a fire for a routine the server no longer has is still acked, so it stops replaying', async () => {
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: 'deleted-job', seq: 9, atMs: Date.now(),
      items: [], durationMs: 1, nextRunAtMs: Date.now() + 1_000,
    })
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: 'deleted-job', seq: 9 })
  })

  // Two servers on one daemon (a stale test server adopting the production
  // daemon is a recorded incident): a fire for an id this server never pushed
  // may be the other server's, and acking it would eat that server's fire.
  it('a fire for an unknown routine on a host this server has NOT armed is left unacked', async () => {
    withDaemon(fakeDaemon(['triggers-v1'], { pushed: false }))
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: 'someone-elses-job', seq: 3, atMs: Date.now(),
      items: [], durationMs: 1, nextRunAtMs: Date.now() + 1_000,
    })
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toEqual([])
    withDaemon(fakeDaemon())
  })

  // Only the DEDUP is asserted here, not a second write: the first fire proved
  // the delivery path, and this send legitimately rides the message queue (a
  // session mid-turn is written to when its turn ends), which is not something
  // a trigger test should pin a wall-clock expectation on.
  it('a higher seq is processed rather than skipped as a replay', async () => {
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: firedJobId, seq: 2, atMs: Date.now(),
      items: [{ id: 'PR-1#c2' }], durationMs: 1, nextRunAtMs: Date.now() + 300_000,
    })
    const job = await jobState(firedJobId)
    expect(job.state.lastFireSeq).toBe(2)
    expect(job.state.lastCheck).toMatchObject({ outcome: 'fired', items: 1 })
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: firedJobId, seq: 2 })
  })

  // The daemon's seq restarts at 0 when its state file is recreated; the epoch
  // it mints with the file is what keeps the server from calling the next N
  // fires replays. Before epochs, a disable-then-enable silently ate them.
  it('a new epoch resets the dedup mark: seq 1 under a fresh epoch is delivered, not skipped', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    const before = (await jobState(firedJobId)).state.lastFireSeq
    expect(before).toBeGreaterThanOrEqual(2)
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: firedJobId, epoch: 'e2e-epoch-b', seq: 1, atMs: Date.now(),
      items: [{ id: 'PR-1#c9' }], durationMs: 1, nextRunAtMs: Date.now() + 300_000,
    })
    const job = await jobState(firedJobId)
    expect(job.state.lastFireEpoch).toBe('e2e-epoch-b')
    expect(job.state.lastFireSeq).toBe(1)
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: firedJobId, seq: 1 })
    // And under THAT epoch, seq 1 again is a replay.
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: firedJobId, epoch: 'e2e-epoch-b', seq: 1, atMs: Date.now(),
      items: [{ id: 'PR-1#c9' }], durationMs: 1, nextRunAtMs: Date.now() + 300_000,
    })
    expect((await jobState(firedJobId)).state.lastFireSeq).toBe(1)
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toHaveLength(1)
  })
})

describe('the sink under the daemon fan-out', () => {
  // The daemon sends every event to ALL trusted clients, and one server holds
  // several sockets to a daemon, so the same fire lands in the sink two or three
  // times within milliseconds. The (epoch, seq) mark is written only after
  // delivery, so without an in-flight guard every copy would deliver.
  it('three concurrent copies of one fire deliver once and ack once', async () => {
    const created = await post('/api/routines', {
      name: 'fan-out watcher',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash fanout.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'Fan-out check.' } },
    })
    const id = created.json.job.id as string
    daemon.clearCommandHistory()
    sends.length = 0
    const event = {
      type: 'trigger.fired' as const, id, epoch: 'fanout-epoch', seq: 1, atMs: Date.now(),
      items: [{ id: 'FAN-1' }], durationMs: 1, nextRunAtMs: Date.now() + 600_000,
    }
    handleTriggerEvent('__local__', event)
    handleTriggerEvent('__local__', { ...event })
    handleTriggerEvent('__local__', { ...event })
    // The sink is fire-and-forget; the ack is the "done" signal.
    const deadline = Date.now() + 15_000
    while (!sends.some((s) => s.cmd === 'triggers.ack') && Date.now() < deadline) await settle(50)
    await settle(500)
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toHaveLength(1)
    expect(envelopesSentToDaemon().filter((t) => t.includes('FAN-1'))).toHaveLength(1)
    expect((await jobState(id)).state.lastFireSeq).toBe(1)
  })
})

describe('a fire for a task whose session has STOPPED', () => {
  // The idle reaper kills the CLI after ~2h of quiet and the record reads
  // 'stopped'; a trigger typically fires hours after the session that created it
  // went quiet, so this is the COMMON case. The right answer is a cold --resume
  // of that same session (the transcript is intact), never a fresh session with
  // no memory of why it is being told. Driven through the real
  // sendMessageToSession: the mock daemon must see a `start` with resume:true.
  let stoppedTaskId = ''
  const stoppedSid = 'pw-stopped-trigger-session'
  let jobId = ''

  beforeAll(async () => {
    const task = await post('/api/tasks', { title: 'stopped-session trigger target', project: 'Trigger e2e' })
    expect(task.status).toBe(201)
    stoppedTaskId = task.json.id ?? task.json.task?.id
    expect(stoppedTaskId).toBeTruthy()
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    await createSessionRecord(stoppedSid, stoppedTaskId, 'Trigger e2e', SESSION_CWD, {
      host: '__local__', title: 'Watch the PR', initialProcessStatus: 'stopped', initialStatusReason: 'expected_teardown',
    })
    const created = await post('/api/routines', {
      name: 'resume watcher',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash resume.sh' },
      executor: { type: 'session', config: { target: stoppedTaskId, prompt: 'Read the new comments.' } },
    })
    expect(created.status).toBe(201)
    jobId = created.json.job.id
  })

  it('resumes the stopped session cold with the envelope instead of starting a new one', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: jobId, epoch: 'resume-epoch', seq: 1, atMs: Date.now(),
      items: [{ id: 'PR-2#c1' }], durationMs: 1, nextRunAtMs: Date.now() + 600_000,
    })

    // The cold path: a `start` for THAT session id with resume:true carrying the envelope.
    const deadline = Date.now() + 15_000
    let resumed: Record<string, unknown> | undefined
    while (!resumed && Date.now() < deadline) {
      resumed = daemon.getCommandHistoryFor('start')
        .map((c) => c.payload)
        .find((p) => p.sid === stoppedSid && p.resume === true)
      if (!resumed) await new Promise((r) => setTimeout(r, 50))
    }
    expect(resumed, 'the stopped session must be resumed, not replaced').toBeTruthy()
    // The envelope follows on the resumed session's stdin (the spawn carries no
    // message; the queue writes it once the CLI is up).
    const delivered = await waitForEnvelopes(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('PR-2#c1')
    const sendFor = daemon.getCommandHistoryFor('send').find((c) => String(c.payload.text ?? c.payload.message ?? '').includes('PR-2#c1'))
    expect(sendFor?.payload.sid).toBe(stoppedSid)

    const job = await jobState(jobId)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.lastFireSeq).toBe(1)

    // Still ONE session on the task, the original one, and not archived.
    const { getSessionsForTask } = await import('../../src/core/session-tracker.js')
    const sessions = await getSessionsForTask(stoppedTaskId)
    expect(sessions.map((s) => s.claudeSessionId)).toEqual([stoppedSid])
    expect(sessions[0].archived).toBeFalsy()
  })
})

describe('a fire whose delivery fails', () => {
  // A registered executor whose failures the test controls: a throw is transient
  // (the daemon must replay), an error RESULT is a refusal (final).
  let mode: 'throw' | 'refuse' | 'ok' = 'ok'
  let attempts = 0
  let flakyJobId = ''

  beforeAll(async () => {
    registerExecutor({
      type: 'e2e-flaky',
      label: 'flaky',
      description: 'test double',
      configSchema: [],
      validate: () => ({ ok: true, config: { instructions: 'x' } }),
      async run() {
        attempts += 1
        if (mode === 'throw') throw new Error('target host unreachable (test)')
        if (mode === 'refuse') return { status: 'error', error: 'target task is complete (test)' }
        return { status: 'ok', summary: 'delivered (test)' }
      },
    })
    const created = await post('/api/routines', {
      name: 'flaky delivery',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash flaky.sh' },
      executor: { type: 'e2e-flaky', config: {} },
    })
    expect(created.status).toBe(201)
    flakyJobId = created.json.job.id
  })

  function fire(seq: number, epoch = 'flaky-epoch') {
    return handleTriggerFired('__local__', {
      type: 'trigger.fired', id: flakyJobId, epoch, seq, atMs: Date.now(),
      items: [{ id: `item-${seq}` }], durationMs: 1, nextRunAtMs: Date.now() + 600_000,
    })
  }

  it('a transient failure is NOT acked and NOT recorded, so the replay is delivered', async () => {
    mode = 'throw'; attempts = 0; sends.length = 0
    await fire(1)
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toEqual([])
    let job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBeUndefined()
    expect(job.state.lastCheck).toMatchObject({ outcome: 'fired', retryPending: true })
    expect(job.state.lastCheck.error).toContain('unreachable')
    expect(job.state.fireRetry).toMatchObject({ epoch: 'flaky-epoch', seq: 1, attempts: 1 })

    // The daemon replays the same fire; this time delivery works.
    mode = 'ok'
    await fire(1)
    expect(attempts).toBe(2)
    job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBe(1)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.fireRetry).toBeUndefined()
    expect(job.state.lastCheck.retryPending).toBeUndefined()
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: flakyJobId, seq: 1 })
  })

  it(`gives up after ${FIRE_DELIVERY_MAX_ATTEMPTS} transient failures: recorded, acked, and the user is told`, async () => {
    mode = 'throw'; attempts = 0; sends.length = 0
    for (let i = 0; i < FIRE_DELIVERY_MAX_ATTEMPTS; i++) await fire(2)
    expect(attempts).toBe(FIRE_DELIVERY_MAX_ATTEMPTS)
    const job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBe(2)
    expect(job.state.lastStatus).toBe('error')
    expect(job.state.lastError).toContain(`failed ${FIRE_DELIVERY_MAX_ATTEMPTS} times`)
    expect(job.state.fireRetry).toBeUndefined()
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toHaveLength(1)
    const { feed } = await listNotifications()
    expect(feed.find((n) => n.dedupKey === `trigger-delivery:${flakyJobId}:flaky-epoch:2`)?.title).toContain('could not deliver')
    // A later fire is a new attempt series, not a continuation.
    mode = 'ok'
    await fire(3)
    expect((await jobState(flakyJobId)).state.lastStatus).toBe('ok')
  })

  it('a refusal (error RESULT) is final: recorded and acked on the first attempt', async () => {
    mode = 'refuse'; attempts = 0; sends.length = 0
    await fire(4)
    expect(attempts).toBe(1)
    const job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBe(4)
    expect(job.state.lastError).toContain('task is complete')
    expect(job.state.lastCheck.retryPending).toBeUndefined()
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: flakyJobId, seq: 4 })
  })
})

describe('run-now on a check job', () => {
  it('relays triggers.run to the host instead of executing locally', async () => {
    const created = await post('/api/routines', {
      name: 'manual run',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash manual.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    const id = created.json.job.id
    sends.length = 0
    daemon.clearCommandHistory()
    const r = await post(`/api/routines/${id}/run`, {})
    expect(r.status).toBe(200)
    expect(r.json.result).toMatchObject({ status: 'ok', host: '__local__' })
    expect(sends.find((s) => s.cmd === 'triggers.run')?.params).toEqual({ triggerId: id })
    // Nothing was delivered: the daemon decides whether this run fires.
    await settle()
    expect(envelopesSentToDaemon()).toEqual([])
  })

  it('answers with the reason when the host daemon cannot be reached', async () => {
    const created = await post('/api/routines', {
      name: 'manual run cold',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash manual.sh' },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    withDaemon(null)
    const r = await post(`/api/routines/${created.json.job.id}/run`, {})
    expect(r.status).toBe(200)
    expect(r.json.result.status).toBe('skipped')
    expect(r.json.result.error).toContain('is not connected')
    withDaemon(fakeDaemon())
  })
})
