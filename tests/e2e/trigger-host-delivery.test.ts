/**
 * The server half of trigger-claim-v1: the daemon decides who delivers a fire,
 * and this server must neither deliver one the host already delivered, nor
 * deliver one it could not claim. Through the real server: the sink, the cron
 * store, the session executor, the message queue and the mock daemon. The trigger
 * daemon is a fake that answers `triggers.claim` the way each scenario needs.
 *
 * Why (2026-10-05): the Mac slept, the host kept firing a one-minute chat monitor,
 * and the fires waited up to 42 minutes for the server while the target session
 * sat idle on that host. The host now delivers them; this file pins what the
 * server does when it hears about it, and that a healthy server still delivers
 * exactly once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-host-delivery-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerEvent } from '../../src/core/routines/trigger-events.js'
import { compileTriggersForHost } from '../../src/core/routines/trigger-push.js'
import type { HostDelivery, TriggerFiredEvent } from '../../src/providers/trigger-check-core.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
const sends: Array<{ cmd: string; params: Record<string, unknown> }> = []

/** How the fake daemon answers a claim, per seq; anything unlisted is claimed. */
type ClaimAnswer = 'claimed' | 'host' | 'busy' | 'foreign' | 'timeout'
const claimAnswers = new Map<number, ClaimAnswer>()
const hostDeliveries = new Map<number, HostDelivery>()
let arbitrates = true
/** False: this connection's hello never answered, so its capability list is empty. */
let capsKnown = true

function fakeDaemon(): TriggerDaemon {
  return {
    host: '__local__',
    hasCapability: (cap) => capsKnown && (cap === 'triggers-v1' || (arbitrates && cap === 'trigger-claim-v1')),
    capabilitiesKnown: capsKnown,
    triggersPushed: true,
    async send(cmd, params = {}) {
      sends.push({ cmd, params })
      if (cmd !== 'triggers.claim') return { ok: true }
      if (!arbitrates) return { ok: false, error: 'unknown command: triggers.claim' }
      const seqs = params.seqs as number[]
      if (seqs.some((s) => claimAnswers.get(s) === 'timeout')) throw new Error('daemon command timeout: triggers.claim (15000ms)')
      if (seqs.some((s) => claimAnswers.get(s) === 'foreign')) return { ok: true, claimed: [], unknown: [], host: [], busy: [], foreign: true }
      return {
        ok: true,
        claimed: seqs.filter((s) => (claimAnswers.get(s) ?? 'claimed') === 'claimed'),
        unknown: [],
        busy: seqs.filter((s) => claimAnswers.get(s) === 'busy'),
        host: seqs.filter((s) => claimAnswers.get(s) === 'host').map((seq) => ({ seq, host: hostDeliveries.get(seq) })),
      }
    },
  }
}

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const jobState = async (id: string) => (await req('GET', `/api/routines/${id}`)).json.job
const task = async (id: string) => { const r = await req('GET', `/api/tasks/${id}`); return r.json.task ?? r.json }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function newTask(title: string): Promise<string> {
  const t = await req('POST', '/api/tasks', { title, project: 'Host delivery e2e', cwd: '/tmp' })
  expect(t.status).toBe(201)
  return t.json.id ?? t.json.task?.id
}

async function newTrigger(name: string, target: string): Promise<string> {
  const created = await req('POST', '/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 60_000 },
    check: { run: `bash ${name.replace(/\W+/g, '-')}.sh`, cwd: '/tmp' },
    executor: { type: 'session', config: { target, prompt: 'Handle each new message.' } },
  })
  expect(created.status).toBe(201)
  return created.json.job.id
}

function fire(id: string, epoch: string, seq: number, atMs: number, extra: Partial<TriggerFiredEvent> = {}): TriggerFiredEvent {
  return {
    type: 'trigger.fired', id, epoch, seq, atMs,
    items: [{ id: `${epoch}-MSG-${seq}`, text: `message ${seq}` }],
    durationMs: 9, nextRunAtMs: Date.now() + 60_000, ...extra,
  } as TriggerFiredEvent
}

const acksFor = (jobId: string) => sends.filter((s) => s.cmd === 'triggers.ack' && s.params.triggerId === jobId).map((s) => Number(s.params.seq)).sort((a, b) => a - b)
const claimsFor = (jobId: string) => sends.filter((s) => s.cmd === 'triggers.claim' && s.params.triggerId === jobId)

/** Commands that carried a trigger envelope for this epoch toward a CLI. */
function envelopes(epoch: string): string[] {
  return [...new Set([...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((t) => t.includes('<walnut-message kind="trigger"') && t.includes(`${epoch}-MSG-`)))]
}

async function until<T>(what: string, probe: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) { await sleep(50); v = await probe() }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

async function sessionOn(taskId: string, sid: string): Promise<void> {
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  await createSessionRecord(sid, taskId, 'Host delivery e2e', '/tmp', { host: '__local__', title: 'Chat loop', initialProcessStatus: 'stopped' })
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
}, 90_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the push tells the daemon where an unclaimed fire goes', () => {
  it('carries the target task, the prompt and this Walnut\'s data dir for a session routine', async () => {
    const taskId = await newTask('Push spec')
    const jobId = await newTrigger('push spec', taskId)
    const compiled = await compileTriggersForHost('__local__')
    const def = compiled!.payload.triggers.find((d) => d.id === jobId)!
    expect(def.deliver).toEqual({ home: WALNUT_HOME, taskId, prompt: 'Handle each new message.' })
  })
})

describe('a server that claims delivers once, as before', () => {
  it('claims at arrival, then delivers and acks', async () => {
    const taskId = await newTask('Claimed')
    await sessionOn(taskId, 'host-e2e-claimed')
    const jobId = await newTrigger('claimed', taskId)
    sends.length = 0
    daemon.clearCommandHistory()
    handleTriggerEvent('__local__', fire(jobId, 'ep-claimed', 1, Date.now()))
    handleTriggerEvent('__local__', fire(jobId, 'ep-claimed', 1, Date.now())) // the second socket's copy
    await until('ack', () => acksFor(jobId), (a) => a.length === 1)
    expect(claimsFor(jobId)).toHaveLength(1)
    expect(claimsFor(jobId)[0].params).toMatchObject({ triggerId: jobId, epoch: 'ep-claimed', seqs: [1] })
    await until('envelope', () => envelopes('ep-claimed'), (e) => e.length === 1)
    expect((await jobState(jobId)).state.fireLog[0].delivery.status).toBe('ok')
  })

  it('a daemon that does not arbitrate is never asked, and the fire is delivered as before', async () => {
    const taskId = await newTask('Legacy daemon')
    await sessionOn(taskId, 'host-e2e-legacy')
    const jobId = await newTrigger('legacy', taskId)
    arbitrates = false
    try {
      sends.length = 0
      handleTriggerEvent('__local__', fire(jobId, 'ep-legacy', 1, Date.now()))
      await until('ack', () => acksFor(jobId), (a) => a.length === 1)
      expect(claimsFor(jobId)).toHaveLength(0)
      await until('envelope', () => envelopes('ep-legacy'), (e) => e.length === 1)
    } finally {
      arbitrates = true
    }
  })

  it('a connection whose hello never answered is asked anyway: "old" is not assumed', async () => {
    const taskId = await newTask('Unknown capabilities')
    await sessionOn(taskId, 'host-e2e-unknown-caps')
    const jobId = await newTrigger('unknown caps', taskId)
    capsKnown = false
    try {
      // A current daemon behind it: the claim goes through and the server delivers once.
      sends.length = 0
      handleTriggerEvent('__local__', fire(jobId, 'ep-caps-new', 1, Date.now()))
      await until('ack', () => acksFor(jobId), (a) => a.length === 1)
      expect(claimsFor(jobId)).toHaveLength(1)
      await until('envelope', () => envelopes('ep-caps-new'), (e) => e.length === 1)
      // An old daemon behind it answers "unknown command": it never delivers itself, so the server does.
      arbitrates = false
      sends.length = 0
      handleTriggerEvent('__local__', fire(jobId, 'ep-caps-old', 1, Date.now()))
      await until('ack', () => acksFor(jobId), (a) => a.length === 1)
      expect(claimsFor(jobId)).toHaveLength(1)
      await until('envelope', () => envelopes('ep-caps-old'), (e) => e.length === 1)
    } finally {
      capsKnown = true
      arbitrates = true
    }
  })
})

describe('a fire the host already delivered is recorded, never delivered again', () => {
  it('a claim answered "host" records the delivery, with the host\'s time, and acks it', async () => {
    const taskId = await newTask('Host delivered (claim)')
    const jobId = await newTrigger('host claim', taskId)
    const firedAt = Date.now() - 40 * 60_000
    hostDeliveries.set(1, { atMs: firedAt + 30_000, sessionId: 'host-e2e-live-1', messageId: 'qm-trigger-aa11', seqs: [1] })
    claimAnswers.set(1, 'host')
    try {
      sends.length = 0
      daemon.clearCommandHistory()
      handleTriggerEvent('__local__', fire(jobId, 'ep-host-claim', 1, firedAt))
      await until('ack', () => acksFor(jobId), (a) => a.length === 1)
      const row = (await jobState(jobId)).state.fireLog[0]
      expect(row.delivery).toMatchObject({ status: 'ok', sessionId: 'host-e2e-live-1' })
      // The host is named the way a person reads it, never by its internal id.
      expect(row.delivery.summary).toMatch(/^the local host sent it to session /)
      // Delivered 30s after the fire: on time, so no lateness is recorded.
      expect(row.deliveredAtMs).toBeUndefined()
      expect(row.injected.preview).toContain('ep-host-claim-MSG-1')
      expect(envelopes('ep-host-claim')).toEqual([])
    } finally {
      claimAnswers.clear(); hostDeliveries.clear()
    }
  })

  it('a replay that carries the host delivery is recorded without asking, even after a long outage', async () => {
    const taskId = await newTask('Host delivered (replay)')
    const jobId = await newTrigger('host replay', taskId)
    const firedAt = Date.now() - 3 * 3_600_000
    const host: HostDelivery = { atMs: firedAt + 60 * 60_000, sessionId: 'host-e2e-live-2', messageId: 'qm-trigger-bb22', seqs: [1, 2] }
    sends.length = 0
    daemon.clearCommandHistory()
    handleTriggerEvent('__local__', fire(jobId, 'ep-host-replay', 1, firedAt, { host, replay: true } as Partial<TriggerFiredEvent>))
    handleTriggerEvent('__local__', fire(jobId, 'ep-host-replay', 2, firedAt + 60_000, { host, replay: true } as Partial<TriggerFiredEvent>))
    await until('acks', () => acksFor(jobId), (a) => a.length === 2)
    expect(claimsFor(jobId)).toHaveLength(0)
    const state = (await jobState(jobId)).state
    // One message on the host, so one history row carrying both fires.
    expect(state.fireLog).toHaveLength(1)
    expect(state.fireLog[0]).toMatchObject({ coalesced: 2, deliveredAtMs: host.atMs })
    expect(envelopes('ep-host-replay')).toEqual([])
    // The daemon replays until the ack lands; a second copy is a duplicate, acked again, delivered never.
    handleTriggerEvent('__local__', fire(jobId, 'ep-host-replay', 1, firedAt, { host, replay: true } as Partial<TriggerFiredEvent>))
    await until('re-ack', () => acksFor(jobId), (a) => a.length === 3)
    expect((await jobState(jobId)).state.fireLog).toHaveLength(1)
    expect(envelopes('ep-host-replay')).toEqual([])
  })

  it('wakes a WAITING target the host delivery found parked, and leaves one parked after it', async () => {
    const parked = await newTask('Parked before the fire')
    const jobA = await newTrigger('wake parked', parked)
    const p = await req('PATCH', `/api/tasks/${parked}`, { phase: 'WAITING' })
    expect(p.status, JSON.stringify(p.json)).toBe(200)
    expect((await task(parked)).phase).toBe('WAITING')
    handleTriggerEvent('__local__', fire(jobA, 'ep-wake', 1, Date.now(), {
      host: { atMs: Date.now() + 1_000, sessionId: 'host-e2e-live-3', messageId: 'qm-trigger-cc33', seqs: [1] },
    } as Partial<TriggerFiredEvent>))
    await until('woken', () => task(parked), (t) => t.phase === 'IN_PROGRESS')

    const later = await newTask('Parked after the fire')
    const jobB = await newTrigger('stay parked', later)
    expect((await req('PATCH', `/api/tasks/${later}`, { phase: 'WAITING' })).status).toBe(200)
    sends.length = 0
    handleTriggerEvent('__local__', fire(jobB, 'ep-stay', 1, Date.now() - 120_000, {
      host: { atMs: Date.now() - 60_000, sessionId: 'host-e2e-live-4', messageId: 'qm-trigger-dd44', seqs: [1] },
    } as Partial<TriggerFiredEvent>))
    await until('ack', () => acksFor(jobB), (a) => a.length === 1)
    expect((await task(later)).phase).toBe('WAITING')
  })
})

describe('no verdict, no delivery', () => {
  for (const answer of ['timeout', 'busy', 'foreign'] as const) {
    it(`a claim answered "${answer}" is neither delivered nor acked; the replay asks again`, async () => {
      const taskId = await newTask(`No verdict ${answer}`)
      await sessionOn(taskId, `host-e2e-${answer}`)
      const jobId = await newTrigger(`no verdict ${answer}`, taskId)
      const epoch = `ep-${answer}`
      claimAnswers.set(1, answer)
      sends.length = 0
      daemon.clearCommandHistory()
      handleTriggerEvent('__local__', fire(jobId, epoch, 1, Date.now()))
      await until('claim', () => claimsFor(jobId), (c) => c.length === 1)
      await sleep(1_500)
      expect(acksFor(jobId)).toEqual([])
      expect(envelopes(epoch)).toEqual([])
      expect((await jobState(jobId)).state.fireLog ?? []).toEqual([])
      // The daemon's replay a minute later meets a claim that goes through.
      claimAnswers.clear()
      handleTriggerEvent('__local__', fire(jobId, epoch, 1, Date.now(), { replay: true } as Partial<TriggerFiredEvent>))
      await until('ack', () => acksFor(jobId), (a) => a.length === 1)
      expect(claimsFor(jobId)).toHaveLength(2)
      await until('one envelope', () => envelopes(epoch), (e) => e.length === 1)
    })
  }
})
