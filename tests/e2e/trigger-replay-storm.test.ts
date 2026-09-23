/**
 * A host comes back after an outage and its daemon replays every fire the server
 * never acked, all in the same instant. Through the real server: the sink, the
 * cron store, the session executor, the message queue and the mock daemon.
 *
 * What prod did with seven replayed fires of one Slack trigger (2026-09-21): seven
 * concurrent deliveries, each of which found the task's only session in
 * `error / remote_unreachable`, treated that as terminal, and started its own
 * session. Seven agents then ran the same Slack sweep, each posting replies.
 *
 * The contract pinned here:
 *  - a burst is delivered ONCE, as one envelope carrying every fire's items, and
 *    every seq is still acked individually (the daemon's ack removes one seq);
 *  - a session killed by the infrastructure is resumed, not replaced;
 *  - when a new session IS needed, exactly one is started, and every later
 *    delivery (the rest of the burst, a fresh fire, another trigger on the same
 *    task) lands in it;
 *  - the audit row names the session that actually received the envelope.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-storm-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerEvent } from '../../src/core/routines/trigger-events.js'
import { registerExecutor } from '../../src/core/routines/registry.js'
import type { TriggerFiredEvent } from '../../src/providers/trigger-check-core.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const HOUR = 3_600_000

let server: HttpServer
let port: number
let daemon: MockDaemon
const sends: Array<{ cmd: string; params: Record<string, unknown> }> = []

function fakeDaemon(): TriggerDaemon {
  return {
    host: '__local__',
    hasCapability: (cap) => cap === 'triggers-v1',
    triggersPushed: true,
    async send(cmd, params = {}) {
      sends.push({ cmd, params })
      return { ok: true }
    },
  }
}

async function post(p: string, body: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function jobState(id: string) {
  const res = await fetch(`http://localhost:${port}/api/routines/${id}`)
  return ((await res.json()) as any).job
}

async function newTask(title: string): Promise<string> {
  const task = await post('/api/tasks', { title, project: 'Storm e2e', cwd: '/tmp' })
  expect(task.status).toBe(201)
  return task.json.id ?? task.json.task?.id
}

async function newTrigger(name: string, target: string): Promise<string> {
  const created = await post('/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 300_000 },
    check: { run: `bash ${name.replace(/\W+/g, '-')}.sh`, cwd: '/tmp' },
    executor: { type: 'session', config: { target, prompt: 'Run the full sweep.' } },
  })
  expect(created.status).toBe(201)
  return created.json.job.id
}

function fireEvent(id: string, epoch: string, seq: number, atMs: number, replay: boolean): TriggerFiredEvent {
  return {
    type: 'trigger.fired', id, epoch, seq, atMs,
    items: [{ id: `${epoch}-ITEM-${seq}`, title: `item ${seq}` }],
    durationMs: 5, nextRunAtMs: Date.now() + 300_000,
    ...(replay ? { replay: true } : {}),
  } as TriggerFiredEvent
}

/** The daemon fans every event out to both sockets, so the sink sees each twice. */
function deliverWithFanOut(event: TriggerFiredEvent): void {
  handleTriggerEvent('__local__', event)
  handleTriggerEvent('__local__', { ...event, items: [...event.items] })
}

function acksFor(jobId: string): number[] {
  return sends
    .filter((s) => s.cmd === 'triggers.ack' && s.params.triggerId === jobId)
    .map((s) => Number(s.params.seq))
}

async function waitForAcks(jobId: string, count: number, timeoutMs = 30_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  while (acksFor(jobId).length < count && Date.now() < deadline) await sleep(50)
  return acksFor(jobId)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Every command that carried a trigger envelope for this epoch toward a CLI. A
 * write the daemon refused (the CLI had exited) is followed by a `--resume` and
 * the same envelope again, so ONE delivery can show up as two commands: count
 * distinct envelopes (`envelopes`) when the question is "how many deliveries".
 */
function carriers(epoch: string): Array<{ cmd: string; sid: string; text: string }> {
  return [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => ({
      cmd: String(c.payload.cmd ?? ''),
      sid: String(c.payload.sid ?? ''),
      text: String(c.payload.text ?? c.payload.message ?? ''),
    }))
    .filter((c) => c.text.includes('<walnut-message kind="trigger"') && c.text.includes(`${epoch}-ITEM-`))
}

function envelopes(epoch: string): string[] {
  return [...new Set(carriers(epoch).map((c) => c.text))]
}

async function waitForCarriers(epoch: string, min: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (carriers(epoch).length < min && Date.now() < deadline) await sleep(50)
  return carriers(epoch)
}

async function liveSessionsOn(taskId: string) {
  const { getSessionsForTask } = await import('../../src/core/session-tracker.js')
  return (await getSessionsForTask(taskId)).filter((s) => !s.archived)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon())
}, 60_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a replay burst into a task whose session the host outage killed', () => {
  const sid = 'storm-infra-killed-session'
  const epoch = 'storm-a'
  let taskId = ''
  let jobId = ''

  beforeAll(async () => {
    taskId = await newTask('Slack sweep')
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    await createSessionRecord(sid, taskId, 'Storm e2e', '/tmp', {
      host: '__local__', title: 'Slack sweep since August',
      initialProcessStatus: 'error', initialStatusReason: 'remote_unreachable',
    })
    jobId = await newTrigger('storm slack', taskId)
  })

  it('resumes that session once with every fire in one envelope, and acks each seq', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    const now = Date.now()
    // The host is back: its first check ran a minute ago, before the backlog landed.
    handleTriggerEvent('__local__', {
      type: 'trigger.checked', id: jobId, atMs: now - 60_000, outcome: 'quiet', reason: 'all-seen',
      durationMs: 5, nextRunAtMs: now + 240_000, consecutiveErrors: 0,
    })
    await expect.poll(async () => (await jobState(jobId)).state?.lastCheck?.outcome).toBe('quiet')
    // Seven fires held for 43 hours, replayed out of order (the daemon's two
    // sockets do not preserve order), each arriving twice.
    for (const seq of [2, 1, 3, 4, 5, 6, 7]) {
      deliverWithFanOut(fireEvent(jobId, epoch, seq, now - (43 - seq) * HOUR, true))
    }

    const acks = await waitForAcks(jobId, 7)
    expect([...acks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])

    const landed = await waitForCarriers(epoch, 1)
    await sleep(750)
    expect(envelopes(epoch), 'the burst must reach the session as ONE envelope').toHaveLength(1)
    expect(new Set(carriers(epoch).map((c) => c.sid))).toEqual(new Set([sid]))
    for (let seq = 1; seq <= 7; seq++) expect(landed[0].text).toContain(`${epoch}-ITEM-${seq}`)
    expect(landed[0].text).toContain('7 fires')

    // The conversation that has been running the sweep is the one that resumed.
    const resumed = daemon.getCommandHistoryFor('start').map((c) => c.payload)
    expect(resumed.filter((p) => p.sid !== sid)).toEqual([])
    const sessions = await liveSessionsOn(taskId)
    expect(sessions.map((s) => s.claudeSessionId)).toEqual([sid])

    const job = await jobState(jobId)
    expect(job.state.lastFireSeq).toBe(7)
    expect(job.state.fireCount).toBe(7)
    const fires = job.state.fireLog as Array<Record<string, any>>
    expect(fires).toHaveLength(1)
    expect(fires[0]).toMatchObject({ outcome: 'fired', items: 7, coalesced: 7 })
    expect(fires[0].delivery).toMatchObject({ status: 'ok', sessionId: sid })
    expect(fires[0].firstAtMs).toBeLessThan(fires[0].atMs)
    // The card's "last check" is still the newest check, not the day-old backlog.
    expect(job.state.lastCheck).toMatchObject({ outcome: 'quiet', atMs: now - 60_000 })
  }, 60_000)

  it('a later replay that repeats delivered seqs delivers only the new ones', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    const now = Date.now()
    for (const seq of [6, 7, 8, 9]) deliverWithFanOut(fireEvent(jobId, epoch, seq, now - (10 - seq) * 60_000, true))

    const acks = await waitForAcks(jobId, 4)
    expect([...acks].sort((a, b) => a - b)).toEqual([6, 7, 8, 9])
    const landed = await waitForCarriers(epoch, 1)
    await sleep(500)
    expect(envelopes(epoch)).toHaveLength(1)
    expect(new Set(carriers(epoch).map((c) => c.sid))).toEqual(new Set([sid]))
    expect(landed[0].text).toContain(`${epoch}-ITEM-8`)
    expect(landed[0].text).toContain(`${epoch}-ITEM-9`)
    expect(landed[0].text).not.toContain(`${epoch}-ITEM-7`)
    expect((await liveSessionsOn(taskId)).map((s) => s.claudeSessionId)).toEqual([sid])
    const job = await jobState(jobId)
    expect(job.state.lastFireSeq).toBe(9)
    expect(job.state.fireCount).toBe(9)
    // These fires are newer than that check, so they are the last check now.
    expect(job.state.lastCheck).toMatchObject({ outcome: 'fired', items: 2 })
  }, 60_000)
})

describe('a replay burst into a task with nothing to resume', () => {
  const epoch = 'storm-b'
  let taskId = ''
  let jobId = ''

  beforeAll(async () => {
    taskId = await newTask('Digest')
    jobId = await newTrigger('storm digest', taskId)
  })

  it('starts exactly one session, and a fresh fire during the burst lands in it', async () => {
    daemon.clearCommandHistory()
    sends.length = 0
    const now = Date.now()
    for (const seq of [3, 1, 2, 4, 5]) deliverWithFanOut(fireEvent(jobId, epoch, seq, now - (6 - seq) * HOUR, true))
    // The daemon's own clock keeps running: a new fire while the burst is still
    // being delivered.
    await sleep(300)
    deliverWithFanOut(fireEvent(jobId, epoch, 6, Date.now(), false))

    const acks = await waitForAcks(jobId, 6)
    expect([...acks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])

    // Counted only after every envelope has landed: a launch's record can appear
    // seconds after the delivery that asked for it returned.
    await waitForCarriers(epoch, 2)
    await sleep(1_500)
    const fresh = daemon.getCommandHistoryFor('start').map((c) => c.payload).filter((p) => p.resume !== true)
    expect(new Set(fresh.map((p) => p.sid)).size, 'one burst must never start more than one session').toBe(1)
    const sessions = await liveSessionsOn(taskId)
    expect(sessions).toHaveLength(1)
    const started = sessions[0].claudeSessionId
    const landed = carriers(epoch)
    expect(envelopes(epoch).length).toBeLessThanOrEqual(2)
    for (const c of landed) expect(c.sid).toBe(started)
    const text = envelopes(epoch).join('\n')
    for (let seq = 1; seq <= 6; seq++) expect(text).toContain(`${epoch}-ITEM-${seq}`)

    // The audit names the session that received each envelope, not a stale slot.
    const job = await jobState(jobId)
    expect(job.state.fireCount).toBe(6)
    const fires = job.state.fireLog as Array<Record<string, any>>
    expect(fires.length).toBeGreaterThanOrEqual(1)
    for (const f of fires) expect(f.delivery.sessionId).toBe(started)
    // Newest first by fire time.
    const times = fires.map((f) => f.atMs as number)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  }, 60_000)
})

describe('two triggers on one task firing at the same moment', () => {
  it('share one new session instead of starting one each', async () => {
    const taskId = await newTask('Two watchers')
    const first = await newTrigger('storm watcher one', taskId)
    const second = await newTrigger('storm watcher two', taskId)
    daemon.clearCommandHistory()
    sends.length = 0
    handleTriggerEvent('__local__', fireEvent(first, 'storm-c', 1, Date.now(), false))
    handleTriggerEvent('__local__', fireEvent(second, 'storm-c', 1, Date.now(), false))
    await waitForAcks(first, 1)
    await waitForAcks(second, 1)

    const landed = await waitForCarriers('storm-c', 2)
    await sleep(1_500)
    const fresh = daemon.getCommandHistoryFor('start').map((c) => c.payload).filter((p) => p.resume !== true)
    expect(new Set(fresh.map((p) => p.sid)).size).toBe(1)
    const sessions = await liveSessionsOn(taskId)
    expect(sessions).toHaveLength(1)
    expect(envelopes('storm-c')).toHaveLength(2)
    for (const c of landed) expect(c.sid).toBe(sessions[0].claudeSessionId)
  }, 60_000)
})

describe('a coalesced batch whose delivery fails transiently', () => {
  let mode: 'throw' | 'ok' = 'throw'
  let runs = 0
  let lastMessage = ''
  let jobId = ''

  beforeAll(async () => {
    registerExecutor({
      type: 'storm-flaky',
      label: 'flaky',
      description: 'test double',
      configSchema: [],
      validate: () => ({ ok: true, config: { instructions: 'x' } }),
      async run(_job, _executor, message) {
        runs += 1
        lastMessage = message
        if (mode === 'throw') throw new Error('host unreachable (test)')
        return { status: 'ok', summary: 'delivered (test)' }
      },
    })
    const created = await post('/api/routines', {
      name: 'storm flaky',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash storm-flaky.sh' },
      executor: { type: 'storm-flaky', config: {} },
    })
    expect(created.status).toBe(201)
    jobId = created.json.job.id
  })

  function burst() {
    const now = Date.now()
    for (const seq of [1, 2, 3]) deliverWithFanOut(fireEvent(jobId, 'storm-d', seq, now - (4 - seq) * HOUR, true))
  }

  it('is withheld whole, then retried as one delivery with every item', async () => {
    sends.length = 0
    burst()
    const deadline = Date.now() + 15_000
    while (runs < 1 && Date.now() < deadline) await sleep(50)
    await sleep(750)
    expect(runs).toBe(1)
    expect(acksFor(jobId)).toEqual([])
    let job = await jobState(jobId)
    expect(job.state.lastFireSeq).toBeUndefined()
    expect(job.state.fireLog).toHaveLength(1)
    expect(job.state.fireLog[0].delivery.status).toBe('retrying')

    mode = 'ok'
    burst()
    const acks = await waitForAcks(jobId, 3)
    expect([...acks].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(runs).toBe(2)
    for (const seq of [1, 2, 3]) expect(lastMessage).toContain(`storm-d-ITEM-${seq}`)
    job = await jobState(jobId)
    expect(job.state.lastFireSeq).toBe(3)
    expect(job.state.fireCount).toBe(3)
    const fires = job.state.fireLog as Array<Record<string, any>>
    expect(fires).toHaveLength(1)
    expect(fires[0]).toMatchObject({ coalesced: 3, attempts: 2, items: 3 })
    expect(fires[0].delivery.status).toBe('ok')
  }, 60_000)
})

describe('the retry count of a batch', () => {
  let mode: 'throw' | 'ok' = 'throw'
  let runs = 0
  let jobId = ''

  beforeAll(async () => {
    registerExecutor({
      type: 'storm-chain',
      label: 'chain',
      description: 'test double',
      configSchema: [],
      validate: () => ({ ok: true, config: { instructions: 'x' } }),
      async run() {
        runs += 1
        if (mode === 'throw') throw new Error('host unreachable (test)')
        return { status: 'ok', summary: 'delivered (test)' }
      },
    })
    const created = await post('/api/routines', {
      name: 'storm chain',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash storm-chain.sh' },
      executor: { type: 'storm-chain', config: {} },
    })
    jobId = created.json.job.id
  })

  async function deliverNow(seqs: number[], replay: boolean) {
    const before = runs
    for (const seq of seqs) deliverWithFanOut(fireEvent(jobId, 'storm-e', seq, Date.now() - (10 - seq) * 60_000, replay))
    const deadline = Date.now() + 15_000
    while (runs === before && Date.now() < deadline) await sleep(25)
    await sleep(300)
  }

  // Fire 3 joins a batch that has already failed twice. Inheriting that count
  // would give fire 3 one try before its items were given up on.
  it('restarts when a new fire joins, so no fire is given up on early', async () => {
    mode = 'throw'; sends.length = 0
    await deliverNow([1, 2], true)
    await deliverNow([1, 2], true)
    let job = await jobState(jobId)
    expect(job.state.fireRetry).toMatchObject({ seq: 1, attempts: 2, seqs: [1, 2] })

    await deliverNow([1, 2, 3], true)
    job = await jobState(jobId)
    expect(acksFor(jobId), 'nothing may be given up on yet').toEqual([])
    expect(job.state.fireRetry).toMatchObject({ seq: 1, attempts: 1, seqs: [1, 2, 3] })
  }, 60_000)

  // A fire landing on its own says nothing about how often the waiting batch failed.
  it('is kept when a different fire lands while the batch waits for its replay', async () => {
    mode = 'ok'
    await deliverNow([4], false)
    let job = await jobState(jobId)
    expect(acksFor(jobId)).toEqual([4])
    expect(job.state.fireRetry).toMatchObject({ seq: 1, attempts: 1, seqs: [1, 2, 3] })

    mode = 'throw'
    await deliverNow([1, 2, 3], true)
    job = await jobState(jobId)
    expect(job.state.fireRetry).toMatchObject({ seq: 1, attempts: 2 })

    mode = 'ok'
    await deliverNow([1, 2, 3], true)
    await waitForAcks(jobId, 4)
    job = await jobState(jobId)
    expect([...acksFor(jobId)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(job.state.fireRetry).toBeUndefined()
    expect(job.state.lastFireSeq).toBe(4)
    expect(job.state.fireCount).toBe(4)
  }, 60_000)
})
