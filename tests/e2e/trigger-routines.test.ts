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
import { compileTriggersForHost, triggerDefOf } from '../../src/core/routines/trigger-push.js'
import { getOp } from '../../src/ops/index.js'
import { testRunDeadlineMs } from '../../src/core/cron/trigger-time-limit.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'

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

/**
 * Every envelope that reached a session's CLI, by EITHER route. A cold `--resume`
 * can carry the message on the spawn itself (`start.message`) or defer it to a
 * `send` once the CLI is up, and which one happens depends on timing, not on
 * intent: scanning only `send` made this suite pass in one checkout and fail in
 * another for the same product behaviour.
 *
 * A `send` counts only when the daemon wrote it to a live FIFO. The mock CLI
 * exits at the end of each turn, so a fire landing as a turn ends goes mid-turn
 * write (ENXIO), then processNext (ENXIO), then a resume plus its deferred
 * send: three `send` commands in the log for one delivery.
 */
function envelopeCarriersToDaemon(): Array<{ cmd: string; sid: string; text: string }> {
  const written = daemon.getFifoWrites().map((w) => ({ cmd: 'send', sid: w.sid, text: w.message }))
  const spawned = daemon.getCommandHistoryFor('start')
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => ({
      cmd: 'start',
      sid: String(c.payload.sid ?? ''),
      text: String(c.payload.message ?? ''),
    }))
  return [...written, ...spawned].filter((c) => c.text.includes('<walnut-message kind="trigger"'))
}

function envelopesSentToDaemon(): string[] {
  return envelopeCarriersToDaemon().map((c) => c.text)
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
      description: 'Checks the PR for new review comments every 5 minutes; the session addresses each one.',
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
    expect(job.description).toBe('Checks the PR for new review comments every 5 minutes; the session addresses each one.')
    // With no name given, a short label from the description, never the prompt (trigger-label.ts).
    expect(job.name).toBe('Checks the PR for new review comments')
    // The server never invents a next check time for a check job.
    expect(job.state.nextRunAtMs).toBeUndefined()
  })

  it('refuses "this" when nothing says who is calling', async () => {
    const r = await post('/api/v1/routines/trigger', { run: 'x', every: '5m', prompt: 'p', description: 'd' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('no calling session')
  })

  it('refuses an unknown task as the target instead of arming a trigger that can never deliver', async () => {
    const r = await post('/api/v1/routines/trigger', {
      run: 'x', every: '5m', prompt: 'p', description: 'd', session: 'task-that-never-existed',
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('no task task-that-never-existed')
  })

  it('refuses a cadence faster than the floor', async () => {
    const r = await post('/api/v1/routines/trigger', {
      run: 'x', every: '2s', prompt: 'p', description: 'd', session: taskId,
    }, { 'x-walnut-caller-sid': sessionId })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('at least 10s')
  })

  it('refuses a trigger with no usable description, and arms nothing', async () => {
    const countJobs = async () => ((await get('/api/routines?includeDisabled=true')).json.jobs as unknown[]).length
    const before = await countJobs()
    const base = { run: 'bash check.sh', every: '5m', prompt: 'p', session: taskId }
    for (const [description, message] of [
      [undefined, 'description is required'],
      ['  \n\t ', 'description is required'],
      ['x'.repeat(601), 'the limit is 600'],
    ] as const) {
      const r = await post('/api/v1/routines/trigger', { ...base, ...(description === undefined ? {} : { description }) })
      expect(r.status, JSON.stringify(description)).toBe(400)
      expect(JSON.stringify(r.json)).toContain(message)
    }
    expect(await countJobs()).toBe(before)
  })

  it('keeps a description verbatim apart from folding its whitespace onto one line', async () => {
    // Non-ASCII test data (Latin accents + CJK), written as escapes.
    const made: string[] = []
    try {
      const created = await post('/api/v1/routines/trigger', {
        run: 'bash check.sh', every: '10m', prompt: 'p', session: taskId,
        description: '  Watches the caf\u00e9 order feed\n  for \u65b0\u8ba2\u5355 every 10 minutes.  ',
      })
      expect(created.status).toBe(201)
      made.push(created.json.job.id)
      expect((await jobState(created.json.job.id)).description)
        .toBe('Watches the caf\u00e9 order feed for \u65b0\u8ba2\u5355 every 10 minutes.')
      // Exactly the limit is accepted.
      const atLimit = await post('/api/v1/routines/trigger', {
        run: 'bash check.sh', every: '10m', prompt: 'p', session: taskId, description: 'y'.repeat(600),
      })
      expect(atLimit.status).toBe(201)
      made.push(atLimit.json.job.id)
    } finally {
      for (const id of made) await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })

  it('edits and clears a description without touching what the daemon runs', async () => {
    const created = await post('/api/v1/routines/trigger', {
      run: 'bash check.sh', every: '5m', prompt: 'p', session: taskId, description: 'First words.',
    })
    const id = created.json.job.id
    try {
      const before = await jobState(id)
      // Compared below, so it must be a real def (an enabled local check job).
      expect(triggerDefOf(before, '__local__')).not.toBeNull()
      const patch = async (body: unknown) => {
        const res = await fetch(apiUrl(`/api/routines/${id}`), {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        expect(res.status).toBe(200)
        return await jobState(id)
      }
      const edited = await patch({ description: 'Second words.' })
      expect(edited.description).toBe('Second words.')
      // The def the daemon holds is unchanged, so its clock and cursor carry on.
      expect(triggerDefOf(edited, '__local__')).toEqual(triggerDefOf(before, '__local__'))
      expect(edited.executor).toEqual(before.executor)
      // An empty description (what the form sends when the field is cleared) removes it.
      const cleared = await patch({ description: '' })
      expect(cleared.description).toBeUndefined()
      expect(triggerDefOf(cleared, '__local__')).toEqual(triggerDefOf(before, '__local__'))
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
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

// 2026-11-08, a trigger sweep: scripts whose call timeouts times their retries passed
// the trigger's limit were killed before the retry ran; nothing showed the limit, a
// killed run read "check timed out after 434s", and a slow test passed without a word.
describe('the check\'s time limit, through the real routes', () => {
  /** A daemon whose test run answers `result`. */
  const testingDaemon = (result: Record<string, unknown>): TriggerDaemon => ({
    ...fakeDaemon(),
    async send(cmd, params = {}) {
      sends.push({ cmd, params })
      if (cmd === 'triggers.test') return { ok: true, result: { ...TEST_RESULT, ...result } }
      return { ok: true }
    },
  })

  afterAll(() => withDaemon(fakeDaemon()))

  it('a test run says how long it ran against its limit, and warns over half of it', async () => {
    withDaemon(testingDaemon({ durationMs: 1_500 }))
    const fast = await post('/api/v1/routines/check-test', { check: { run: 'bash fast.sh', timeoutSeconds: 60 } })
    expect(fast.status).toBe(200)
    expect(fast.json.timeLimit).toMatchObject({ seconds: 60, durationMs: 1_500, killed: false, line: 'ran 1.5 s of its 60 s limit' })
    expect(fast.json.timeLimit.warning).toBeUndefined()

    withDaemon(testingDaemon({ durationMs: 40_000 }))
    const slow = await post('/api/v1/routines/check-test', { check: { run: 'bash slow.sh', timeoutSeconds: 60 } })
    expect(slow.json.timeLimit).toMatchObject({ seconds: 60, share: 0.67, line: 'ran 40 s of its 60 s limit' })
    expect(slow.json.timeLimit.warning).toMatch(/^This test run took 40 s, 67% of its 60 s time limit/)
  })

  it('a test the daemon killed at its deadline says so, with the limit, in the error and the outcome', async () => {
    withDaemon(testingDaemon({ ok: false, durationMs: 30_004, parsed: null, wouldFire: false, newItemCount: 0, error: 'check timed out after 30s' }))
    const out = await getOp('trigger_test')!.handler!({ run: 'bash hang.sh' }, async (method, p, body) => (await post(`/api/v1${p}`, body)).json) as {
      result: { error: string }; timeLimit: Record<string, unknown>; outcome: string
    }
    expect(out.result.error).toBe('check killed at the 30 s limit (timeoutSeconds): it was still running')
    expect(out.timeLimit).toMatchObject({ seconds: 30, killed: true, line: 'was killed at its 30 s limit' })
    expect(out.outcome).toContain('check killed at the 30 s limit')
    expect(out.outcome).toContain('WARNING: This test run was killed at its 30 s time limit before it finished.')
  })

  it('trigger_create warns when the last test of the same script came close to the limit it arms', async () => {
    const base = {
      every: '5m', prompt: 'Look at the build.', description: 'Checks the build every 5 minutes; the session looks when it breaks.',
    }
    withDaemon(testingDaemon({ durationMs: 25_000 }))
    await post('/api/v1/routines/check-test', { check: { run: 'bash near.sh', cwd: SESSION_CWD } }, { 'x-walnut-caller-sid': sessionId })
    withDaemon(fakeDaemon())
    const near = await post('/api/v1/routines/trigger', { ...base, run: 'bash near.sh' }, { 'x-walnut-caller-sid': sessionId })
    expect(near.status).toBe(201)
    expect(near.json.timeLimit).toMatchObject({ seconds: 30, tested: { durationMs: 25_000, seconds: 30, killed: false } })
    expect(near.json.timeLimit.warning).toMatch(/^Its last trigger_test run took 25 s, 83% of its 30 s time limit/)
    const mapped = getOp('trigger_create')!.mapResult!({ body: near.json, args: {} }) as { outcome: string }
    expect(mapped.outcome).toContain('WARNING: Its last trigger_test run took 25 s')

    // The same script armed with room to spare: no warning.
    const roomy = await post('/api/v1/routines/trigger', { ...base, run: 'bash near.sh', timeoutSeconds: 120 }, { 'x-walnut-caller-sid': sessionId })
    expect(roomy.json.timeLimit).toMatchObject({ seconds: 120 })
    expect(roomy.json.timeLimit.warning).toBeUndefined()
    // A script never tested has nothing to warn about.
    const untested = await post('/api/v1/routines/trigger', { ...base, run: 'bash never-tested.sh' }, { 'x-walnut-caller-sid': sessionId })
    expect(untested.json.timeLimit).toEqual({ seconds: 30 })
  })

  // 2026-11-08: a check with a 280 s limit could not be tested (the CLI gave up at 10 s, the
  // server at 60 s), and a link that dropped mid-test read only "did not answer the test".
  it('waits for the daemon as long as the check may run, never a fixed minute', async () => {
    const deadlines: Array<number | undefined> = []
    withDaemon({ ...fakeDaemon(), async send(cmd, _params, timeoutMs) { deadlines.push(timeoutMs); return cmd === 'triggers.test' ? { ok: true, result: TEST_RESULT } : { ok: true } } })
    await post('/api/v1/routines/check-test', { check: { run: 'bash long.sh', timeoutSeconds: 280 } })
    await post('/api/v1/routines/check-test', { check: { run: 'bash short.sh' } })
    expect(deadlines).toEqual([testRunDeadlineMs(280), testRunDeadlineMs(30)])
    expect(testRunDeadlineMs(280)).toBeGreaterThan(285_000)
    // The CLI waits for two runs (the one retry) and the relink, whatever the limit.
    for (const limit of [1, 30, 120, 280, 300]) {
      expect(getOp('trigger_test')!.timeoutMs).toBeTypeOf('function')
      const cli = (getOp('trigger_test')!.timeoutMs as (a: Record<string, unknown>) => number)({ run: 'x', timeoutSeconds: limit })
      expect(cli).toBeGreaterThan(2 * testRunDeadlineMs(limit))
    }
  })

  it('a link that drops mid-test is retried once, and a second drop says it was the link, not the script', async () => {
    let calls = 0
    const dropping = (drops: number): TriggerDaemon => ({
      ...fakeDaemon(),
      async send(cmd) {
        if (cmd !== 'triggers.test') return { ok: true }
        calls += 1
        if (calls <= drops) throw markLinkFailure(new Error('connection closed'), 'lost')
        return { ok: true, result: TEST_RESULT }
      },
    })
    calls = 0
    withDaemon(dropping(1))
    const once = await post('/api/v1/routines/check-test', { check: { run: 'bash flaky-link.sh' } })
    expect(once.status).toBe(200)
    expect(once.json.result).toMatchObject({ wouldFire: true })
    expect(calls).toBe(2)

    calls = 0
    withDaemon(dropping(5))
    const twice = await post('/api/v1/routines/check-test', { check: { run: 'bash flaky-link.sh' } })
    expect(twice.status).toBe(503)
    expect(JSON.stringify(twice.json)).toContain('transport failure: the connection to the daemon on __local__ dropped while the test ran')
    expect(JSON.stringify(twice.json)).toContain('This is the link, not your script')
    expect(calls).toBe(2)

    // No answer in time is not retried: the check may still be running there.
    calls = 0
    withDaemon({ ...fakeDaemon(), async send(cmd) { if (cmd === 'triggers.test') { calls += 1; throw markLinkFailure(new Error('daemon command timeout'), 'no-answer') } return { ok: true } } })
    const silent = await post('/api/v1/routines/check-test', { check: { run: 'bash silent.sh', timeoutSeconds: 40 } })
    expect(silent.status).toBe(503)
    expect(JSON.stringify(silent.json)).toContain(`gave no answer within ${Math.round(testRunDeadlineMs(40) / 1000)} s, though the check's limit is 40 s`)
    expect(calls).toBe(1)
  })

  // A session on another host calls through its daemon's gateway, which waits about 20 s for one
  // relayed call: a longer run answers "still running" with its id, and the next call waits on it.
  it('a run longer than its caller may wait answers pending, and testId reads the same run\'s result', async () => {
    let runs = 0
    withDaemon({ ...fakeDaemon(), async send(cmd) {
      if (cmd !== 'triggers.test') return { ok: true }
      runs += 1
      await new Promise((r) => setTimeout(r, 2_500))
      return { ok: true, result: { ...TEST_RESULT, durationMs: 2_400 } }
    } })
    const answerBy = String(Date.now() + 5_000)
    const first = await post('/api/v1/routines/check-test', { check: { run: 'bash long-remote.sh', timeoutSeconds: 200 } }, { 'x-walnut-answer-by': answerBy })
    expect(first.status).toBe(200)
    expect(first.json.result).toBeUndefined()
    expect(first.json.pending).toMatchObject({ host: '__local__', limitSeconds: 200 })
    expect(first.json.pending.testId).toMatch(/^tt_[0-9a-f]{12}$/)
    const mapped = await getOp('trigger_test')!.handler!({ run: 'bash long-remote.sh', timeoutSeconds: 200 }, async () => first.json) as { outcome: string; next: string }
    expect(mapped.outcome).toMatch(/^The check is still running on this machine \(\d+ s so far; its limit is 200 s/)
    expect(mapped.next).toContain(`trigger_test '{"testId":"${first.json.pending.testId}"}'`)

    // The op with testId: the same run, not a new one; its time against the limit is there.
    const out = await getOp('trigger_test')!.handler!({ testId: first.json.pending.testId }, async (_m, p, body) => (await post(`/api/v1${p}`, body)).json) as {
      result: { wouldFire: boolean }; timeLimit: { line: string }; outcome: string
    }
    expect(out.result.wouldFire).toBe(true)
    expect(out.timeLimit.line).toBe('ran 2.4 s of its 200 s limit')
    expect(runs).toBe(1)
    // A caller with no deadline waits to the end.
    const whole = await post('/api/v1/routines/check-test', { check: { run: 'bash long-remote.sh', timeoutSeconds: 200 } })
    expect(whole.json.result).toMatchObject({ wouldFire: true })
    expect(runs).toBe(2)

    const unknown = await post('/api/v1/routines/check-test', { testId: 'tt_000000000000' })
    expect(unknown.status).toBe(404)
    expect(JSON.stringify(unknown.json)).toContain('run trigger_test again')
  }, 30_000)

  it('a test and a create that both leave cwd out are the same check: the create warns', async () => {
    // The common call: neither names cwd, and both mean the calling session's (2026-11-09 review).
    const base = { every: '5m', prompt: 'Look.', description: 'Checks the deploy every 5 minutes; the session looks when it fails.' }
    sends.length = 0
    withDaemon(testingDaemon({ durationMs: 22_000 }))
    await post('/api/v1/routines/check-test', { check: { run: 'bash no-cwd.sh' } }, { 'x-walnut-caller-sid': sessionId })
    expect(sends.find((x) => x.cmd === 'triggers.test')!.params.check).toMatchObject({ cwd: SESSION_CWD })
    withDaemon(fakeDaemon())
    const made = await post('/api/v1/routines/trigger', { ...base, run: 'bash no-cwd.sh' }, { 'x-walnut-caller-sid': sessionId })
    expect(made.json.timeLimit.warning).toMatch(/^Its last trigger_test run took 22 s, 73% of its 30 s time limit/)
  })

  it('a caller may name its own wait (the web form): a longer run answers pending inside it', async () => {
    withDaemon({ ...fakeDaemon(), async send(cmd) {
      if (cmd !== 'triggers.test') return { ok: true }
      await new Promise((r) => setTimeout(r, 2_000))
      return { ok: true, result: TEST_RESULT }
    } })
    const t0 = Date.now()
    const first = await post('/api/routines/check-test', { check: { run: 'bash web-long.sh', timeoutSeconds: 60 }, answerWithinMs: 1_000 })
    expect(Date.now() - t0).toBeLessThan(1_900)
    expect(first.json.pending.testId).toMatch(/^tt_/)
    const done = await post('/api/routines/check-test', { testId: first.json.pending.testId, answerWithinMs: 10_000 })
    expect(done.json.result).toMatchObject({ wouldFire: true })
    expect(done.json.timeLimit).toMatchObject({ seconds: 60 })
  }, 20_000)

  it('a check killed at its limit is recorded as one, in lastCheck, History and the list trigger_list reads', async () => {
    const created = await post('/api/routines', {
      name: 'slow watcher',
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run: 'bash slow-watch.sh', timeoutSeconds: 120 },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    const id = created.json.job.id
    // An older daemon's words for the kill, with the wall time a sleep stretched.
    await handleTriggerChecked('__local__', {
      type: 'trigger.checked', id, atMs: Date.now(), outcome: 'error', error: 'check timed out after 434s',
      durationMs: 434_000, nextRunAtMs: Date.now() + 600_000, consecutiveErrors: 1,
    })
    const job = await jobState(id)
    const killed = 'check killed at the 120 s limit (timeoutSeconds): it was still running'
    expect(job.state.lastCheck).toMatchObject({ outcome: 'error', error: killed, killedAtLimit: true, limitSeconds: 120 })
    expect(job.state.checkLog[0]).toMatchObject({ outcome: 'error', error: killed, killedAtLimit: true, limitSeconds: 120 })
    expect(job.state.lastError).toBe(killed)
    const listed = await getOp('trigger_list')!.handler!({ name: 'slow watcher' }, async (_m, p) => (await get(`/api/v1${p}`)).json) as {
      triggers: Array<Record<string, unknown>>
    }
    expect(listed.triggers[0]).toMatchObject({ timeLimit: '120s', lastRun: 'was killed at its 120 s limit' })
    expect(String(listed.triggers[0].last)).toContain(killed)
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
      // The limit it ran under (the default 30 s), so a later limit change never rewrites it.
      limitSeconds: 30,
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

  it(`${MAX_CONSECUTIVE_CHECK_ERRORS} check errors in a row disable the trigger, and the user hears nothing`, async () => {
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

    // Its task hears it (trigger-health.test.ts covers who); the user gets no letter and no bell.
    await settle()
    const { listLetters } = await import('../../src/core/human-inbox/store.js')
    expect((await listLetters()).letters.filter((l) => l.subject.includes('"broken watcher"'))).toEqual([])
    expect((await listNotifications()).feed.filter((n) => n.dedupKey.includes(id) || n.title.includes('"broken watcher"'))).toEqual([])
  })

  it('a check the fire budget holds tells the trigger\'s live session once a day, never the user', async () => {
    const created = await post('/api/routines', {
      name: 'busy chat watcher',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash chat.sh', maxFiresPerDay: 6 },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    const id = created.json.job.id
    const held = (atMs: number) => handleTriggerChecked('__local__', {
      type: 'trigger.checked', id, atMs, outcome: 'quiet', reason: 'rate-limited',
      durationMs: 9, nextRunAtMs: atMs + 300_000, consecutiveErrors: 0,
    })
    const bells = async () => (await listNotifications()).feed.filter((n) => n.dedupKey.includes(id))
    const told = () => [...new Set([
      ...daemon.getFifoWrites().map((w) => w.message),
      ...daemon.getCommandHistoryFor('start').map((c) => String(c.payload.message ?? '')),
    ].filter((t) => t.includes('outcome="fire_budget_held"') && t.includes(`(${id})`)))]
    // Live, so the notice lands without waking anything.
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const live = () => updateSessionRecord(sessionId, { process_status: 'idle' })
    try {
      const t0 = Date.now()
      await live()
      await held(t0)
      const [notice] = await (async () => {
        const deadline = Date.now() + 8_000
        while (told().length === 0 && Date.now() < deadline) await settle(50)
        return told()
      })()
      expect(notice).toContain(
        'it used its fire budget (6 fires a day), so it now fires at most once every 4 hours. '
        + 'Nothing is dropped: each fire carries everything new since the last one, it just arrives later. '
        + 'If this source is this busy, raise the trigger\'s maxFiresPerDay '
        + `(it checks 288 times a day, so 288 lets every check fire; 0 = no limit): PATCH /routines/${id}`,
      )
      expect(notice).toContain(`Your trigger "busy chat watcher" (${id}):`)
      const job = await jobState(id)
      expect(job.state.lastCheck).toMatchObject({ outcome: 'quiet', reason: 'rate-limited' })
      expect(job.state.fireBudgetNoticeAtMs).toBe(t0)

      // The next held checks that day add nothing.
      await live()
      await held(t0 + 300_000)
      await held(t0 + 600_000)
      // A quiet check of another kind never tells anyone.
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id, atMs: t0 + 700_000, outcome: 'quiet', reason: 'all-seen',
        durationMs: 9, nextRunAtMs: t0 + 1_000_000, consecutiveErrors: 0,
      })
      await settle()
      expect(told()).toHaveLength(1)
      // A day later it is told again.
      await live()
      await held(t0 + 24 * 60 * 60 * 1000)
      expect((await jobState(id)).state.fireBudgetNoticeAtMs).toBe(t0 + 24 * 60 * 60 * 1000)

      // A paused trigger's late held check is not news.
      await fetch(apiUrl(`/api/routines/${id}`), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
      })
      await held(t0 + 3 * 24 * 60 * 60 * 1000)
      expect((await jobState(id)).state.fireBudgetNoticeAtMs).toBe(t0 + 24 * 60 * 60 * 1000)
      // And the user saw none of it.
      expect(await bells()).toEqual([])
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })
})

describe('pause and resume', () => {
  const armedIds = async () => ((await compileTriggersForHost('__local__'))?.payload.triggers ?? []).map((t) => t.id)
  const create = async (name: string) => (await post('/api/v1/routines/trigger', {
    name, run: 'bash paused.sh', every: '5m', prompt: 'p', session: taskId, description: 'Pause test.',
  })).json.job.id as string
  const patch = async (id: string, body: unknown) => {
    const res = await fetch(apiUrl(`/api/routines/${id}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    return await jobState(id)
  }
  /** The ops' own executor path: /api/v1 over HTTP, as `walnut tools call` does. */
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(apiUrl(`/api/v1${p}`), {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`)
    return json
  }

  it('toggle off stamps the pause and disarms the trigger; toggle on clears it and re-arms', async () => {
    const id = await create('toggle pause')
    try {
      expect(await armedIds()).toContain(id)
      const t0 = Date.now()
      const off = (await post(`/api/routines/${id}/toggle`, {})).json.job
      expect(off.enabled).toBe(false)
      expect(off.state.pausedAtMs).toBeGreaterThanOrEqual(t0)
      expect(off.state.nextRunAtMs).toBeUndefined()
      expect(await armedIds()).not.toContain(id)
      const on = (await post(`/api/routines/${id}/toggle`, {})).json.job
      expect(on.enabled).toBe(true)
      expect(on.state.pausedAtMs).toBeUndefined()
      expect(await armedIds()).toContain(id)
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })

  it('a PATCH pause keeps its first time through repeats and edits, and a resume clears it', async () => {
    const id = await create('patch pause')
    try {
      const paused = await patch(id, { enabled: false })
      const at = paused.state.pausedAtMs
      expect(typeof at).toBe('number')
      await settle(20)
      // Pausing again, or editing the words, is not a new pause.
      expect((await patch(id, { enabled: false })).state.pausedAtMs).toBe(at)
      const edited = await patch(id, { description: 'New words.' })
      expect(edited.state.pausedAtMs).toBe(at)
      expect(edited.enabled).toBe(false)
      expect(await armedIds()).not.toContain(id)
      const resumed = await patch(id, { enabled: true })
      expect(resumed.state.pausedAtMs).toBeUndefined()
      expect(await armedIds()).toContain(id)
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })

  it('a check that was running when the pause landed is recorded, shows no next run, and never stops it', async () => {
    const id = await create('late check')
    try {
      await patch(id, { enabled: false })
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id, atMs: Date.now(), outcome: 'quiet', reason: 'all-seen',
        durationMs: 3, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: 0,
      })
      let job = await jobState(id)
      expect(job.state.lastCheck).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
      expect(job.state.nextRunAtMs).toBeUndefined()
      expect(job.enabled).toBe(false)
      // Late failures past the stop limit: still a pause, and nobody is told it was stopped.
      for (let i = 1; i <= MAX_CONSECUTIVE_CHECK_ERRORS + 1; i++) {
        await handleTriggerChecked('__local__', {
          type: 'trigger.checked', id, atMs: Date.now(), outcome: 'error', error: 'exit 1',
          durationMs: 3, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: i,
        })
      }
      job = await jobState(id)
      expect(job.enabled).toBe(false)
      expect(typeof job.state.pausedAtMs).toBe('number')
      expect(job.state.nextRunAtMs).toBeUndefined()
      const { feed } = await listNotifications()
      expect(feed.find((n) => n.dedupKey === `trigger-disabled:${id}`)).toBeUndefined()
      // Resume is a fresh start: those late failures cannot stop it on the next one.
      const resumed = await patch(id, { enabled: true })
      expect(resumed.state.consecutiveErrors).toBe(0)
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id, atMs: Date.now(), outcome: 'error', error: 'exit 1',
        durationMs: 3, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: 1,
      })
      expect((await jobState(id)).enabled).toBe(true)
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })

  it('a repeated Resume keeps the next run the daemon reported', async () => {
    const id = await create('repeat resume')
    try {
      const reported = Date.now() + 123_456
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id, atMs: Date.now(), outcome: 'quiet', reason: 'fire-false',
        durationMs: 3, nextRunAtMs: reported, consecutiveErrors: 0,
      })
      expect((await jobState(id)).state.nextRunAtMs).toBe(reported)
      const again = await patch(id, { enabled: true })
      expect(again.state.nextRunAtMs).toBe(reported)
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
  })

  it('trigger_pause / trigger_resume / trigger_list work end to end over /api/v1', async () => {
    const id = await create('op pause')
    try {
      const paused = await getOp('trigger_pause')!.handler!({ id }, call) as Record<string, unknown>
      expect(paused).toMatchObject({ id, state: 'paused', changed: true })
      expect((await jobState(id)).enabled).toBe(false)
      expect(await armedIds()).not.toContain(id)
      const listed = await getOp('trigger_list')!.handler!({}, call) as { triggers: Array<Record<string, unknown>> }
      const row = listed.triggers.find((t) => t.id === id)
      expect(row).toMatchObject({ state: 'paused', enabled: false })
      expect(typeof row?.pausedAt).toBe('string')
      expect(await getOp('trigger_pause')!.handler!({ id }, call)).toMatchObject({ changed: false })
      const resumed = await getOp('trigger_resume')!.handler!({ id }, call) as Record<string, unknown>
      expect(resumed).toMatchObject({ id, state: 'armed', changed: true })
      expect(await armedIds()).toContain(id)
      await expect(getOp('trigger_pause')!.handler!({ id: 'no-such-trigger' }, call)).rejects.toThrow(/not found/i)
    } finally {
      await fetch(apiUrl(`/api/routines/${id}`), { method: 'DELETE' })
    }
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
      description: 'Fires when fire.sh reports a new comment; the session reads it.',
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
    expect(ack.params).toEqual({ triggerId: firedJobId, seq: 1, home: WALNUT_HOME })
    expect(ack.params.id).toBeUndefined()
  })

  // The audit trail is what answers "did this ever fire, and what did it inject"
  // hours later, when lastCheck has been overwritten by a quiet run.
  it('records the fire in the audit trail with the delivery and the injected text', async () => {
    const job = await jobState(firedJobId)
    expect(job.state.fireCount).toBe(1)
    const fires = job.state.fireLog as Array<Record<string, any>>
    expect(fires).toHaveLength(1)
    expect(fires[0]).toMatchObject({ outcome: 'fired', seq: 1, items: 1 })
    expect(fires[0].delivery.status).toBe('ok')
    expect(fires[0].delivery.summary).toMatch(/sent to session|resumed session/)
    expect(fires[0].delivery.sessionId).toBeTruthy()
    // The preview is the message the session actually received, not a paraphrase.
    expect(fires[0].injected.preview).toContain('from="Trigger: fire watcher"')
    expect(fires[0].injected.preview).toContain('Read each new comment.')
    expect(fires[0].injected.chars).toBeGreaterThan(0)
    // …and the same fire shows up in the recent-activity list.
    const checks = job.state.checkLog as Array<Record<string, any>>
    expect(checks[0]).toMatchObject({ outcome: 'fired', seq: 1 })
  })

  it('a quiet check lands in the audit trail without touching the fire count', async () => {
    await handleTriggerChecked('__local__', {
      type: 'trigger.checked', id: firedJobId, outcome: 'quiet', reason: 'all-seen',
      atMs: Date.now(), durationMs: 4, nextRunAtMs: Date.now() + 300_000,
    })
    const job = await jobState(firedJobId)
    expect(job.state.fireCount).toBe(1)
    expect(job.state.fireLog).toHaveLength(1)
    const checks = job.state.checkLog as Array<Record<string, any>>
    expect(checks[0]).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    expect(checks.filter((c) => c.outcome === 'fired')).toHaveLength(1)
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
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: 'deleted-job', seq: 9, home: WALNUT_HOME })
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
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: firedJobId, seq: 2, home: WALNUT_HOME })
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
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: firedJobId, seq: 1, home: WALNUT_HOME })
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
    // One line, by its uuid: the mock CLI exits at each turn end, so a line written
    // into a turn that then ends is rewritten under the SAME uuid to the next
    // process (the CLI dedupes by uuid); a second delivery would be a second line.
    const fanLines = new Set(daemon.getCommandHistory()
      .filter((c) => (c.cmd === 'send' || c.cmd === 'start') && String(c.payload.message ?? '').includes('FAN-1'))
      .map((c) => String(c.payload.uuid ?? '')))
    expect([...fanLines]).toHaveLength(1)
    expect(envelopesSentToDaemon().filter((t) => t.includes('FAN-1')).length).toBeGreaterThanOrEqual(1)
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
    // The envelope reaches the resumed session either on the spawn or on the
    // stdin write that follows it (see envelopesSentToDaemon).
    const delivered = await waitForEnvelopes(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('PR-2#c1')
    // Whichever command carried it, it went to THAT session, not a fresh one.
    const carrier = envelopeCarriersToDaemon().find((c) => c.text.includes('PR-2#c1'))
    expect(carrier?.sid).toBe(stoppedSid)

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
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: flakyJobId, seq: 1, home: WALNUT_HOME })

    // ONE fire that took two tries, not two fires: three rows here would read as
    // three separate things happening, which is what the trail exists to prevent.
    const fires = job.state.fireLog as Array<Record<string, any>>
    expect(fires.filter((f) => f.seq === 1)).toHaveLength(1)
    expect(fires[0]).toMatchObject({ seq: 1, attempts: 2 })
    expect(fires[0].delivery.status).toBe('ok')
    expect(job.state.fireCount).toBe(1)
  })

  it(`gives up after ${FIRE_DELIVERY_MAX_ATTEMPTS} transient failures: recorded and acked, and the user is not the one told`, async () => {
    mode = 'throw'; attempts = 0; sends.length = 0
    for (let i = 0; i < FIRE_DELIVERY_MAX_ATTEMPTS; i++) await fire(2)
    expect(attempts).toBe(FIRE_DELIVERY_MAX_ATTEMPTS)
    const job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBe(2)
    expect(job.state.lastStatus).toBe('error')
    expect(job.state.lastError).toContain(`failed ${FIRE_DELIVERY_MAX_ATTEMPTS} times`)
    expect(job.state.fireRetry).toBeUndefined()
    expect(sends.filter((s) => s.cmd === 'triggers.ack')).toHaveLength(1)
    // A delivery failure is its task's lead's to hear (this routine has no task): never a bell.
    const { feed } = await listNotifications()
    expect(feed.filter((n) => n.dedupKey.includes(flakyJobId))).toEqual([])
    // The audit shows ONE fire that failed, with the attempt count, and the
    // total counts it once even though three attempts were made.
    const afterGiveUp = job.state.fireLog as Array<Record<string, any>>
    expect(afterGiveUp.filter((f) => f.seq === 2)).toHaveLength(1)
    expect(afterGiveUp[0]).toMatchObject({ seq: 2, attempts: FIRE_DELIVERY_MAX_ATTEMPTS })
    expect(afterGiveUp[0].delivery.status).toBe('error')
    expect(job.state.fireCount).toBe(2)
    // A later fire is a new attempt series, not a continuation.
    mode = 'ok'
    await fire(3)
    const later = await jobState(flakyJobId)
    expect(later.state.lastStatus).toBe('ok')
    expect(later.state.fireCount).toBe(3)
    const newest = (later.state.fireLog as Array<Record<string, any>>)[0]
    expect(newest.seq).toBe(3)
    // A first attempt carries no attempt count at all (nothing to explain).
    expect(newest.attempts).toBeUndefined()
  })

  it('a refusal (error RESULT) is final: recorded and acked on the first attempt', async () => {
    mode = 'refuse'; attempts = 0; sends.length = 0
    await fire(4)
    expect(attempts).toBe(1)
    const job = await jobState(flakyJobId)
    expect(job.state.lastFireSeq).toBe(4)
    expect(job.state.lastError).toContain('task is complete')
    expect(job.state.lastCheck.retryPending).toBeUndefined()
    expect(sends.find((s) => s.cmd === 'triggers.ack')?.params).toEqual({ triggerId: flakyJobId, seq: 4, home: WALNUT_HOME })
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
    expect(sends.find((s) => s.cmd === 'triggers.run')?.params).toEqual({ triggerId: id, home: WALNUT_HOME })
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
