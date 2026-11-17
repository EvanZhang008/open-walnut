/**
 * One fire of a daemon reaching this server under several host names is delivered once.
 *
 * 2026-11-16: a machine was configured as both `newdev` and `clouddev`. The daemon sends each
 * event to every link, so each fire arrived twice, about a millisecond apart. The fire lanes were
 * keyed by host name, so the two copies went down two lanes at once; the store records a fire only
 * after its delivery, and 24 fires that day passed the dedup twice and reached their session twice.
 *
 * A fire is the daemon's (trigger id, epoch, seq): whatever name it arrives under, one lane, one
 * delivery, one ack. Real cron store and the real event sink; the executor is slow, as a real
 * session send is, so the copies overlap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-trigger-fire-many-names'))
const cron = vi.hoisted(() => ({ service: null as unknown, run: null as null | ((...a: unknown[]) => unknown) }))
vi.mock('../../../src/web/routes/cron.js', () => ({ getCronService: () => cron.service }))
vi.mock('../../../src/core/routines/registry.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/routines/registry.js')>()),
  runExecutor: (...a: unknown[]) => cron.run!(...a),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { CronService } from '../../../src/core/cron/service.js'
import { fireLaneBusy, handleTriggerEvent } from '../../../src/core/routines/trigger-events.js'
import { setTriggerDaemonLookupForTest } from '../../../src/core/routines/trigger-daemon.js'
import type { TriggerFiredEvent } from '../../../src/providers/trigger-check-core.js'

const NAMES = ['newdev', 'clouddev', 'clouddev-net']
let counter = 0
let runs: number
let acks: Array<{ host: string; seq: unknown }>

function service(): CronService {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return new CronService({
    nowMs: () => Date.now(), log, storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled: false,
    broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor: vi.fn(), onEvent: vi.fn(),
  } as never)
}

const fire = (id: string, seq: number, epoch = 'e1'): TriggerFiredEvent =>
  ({ type: 'trigger.fired', id, epoch, seq, atMs: Date.now(), items: [{ id: `item-${seq}` }], durationMs: 5 })

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(() => {
  runs = 0
  acks = []
  // A session send takes a while: long enough for every copy to arrive while it runs.
  cron.run = async () => { runs++; await new Promise((r) => setTimeout(r, 400)); return { status: 'ok', summary: 'sent' } }
  setTriggerDaemonLookupForTest((host) => ({
    host, hasCapability: () => true, capabilitiesKnown: true, triggersPushed: true,
    send: async (cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'triggers.ack') acks.push({ host, seq: p.seq })
      // The daemon answers each link of this one server the same: the fire is this server's.
      if (cmd === 'triggers.claim') return { ok: true, claimed: p.seqs, unknown: [], host: [], busy: [] }
      return { ok: true }
    },
  }) as never)
})

afterEach(() => { setTriggerDaemonLookupForTest(null) })

async function watchRoutine(s: CronService): Promise<string> {
  const job = await s.add({
    name: 'Watch the channel', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 300_000 },
    check: { run: './check.sh', host: 'clouddev' },
    executor: { type: 'session', config: { target: 'task-watch', prompt: 'Read what is new.' } },
  } as never)
  return job.id
}

describe('one fire arriving under several names of one daemon', () => {
  it('is delivered once and acked once, whichever name it came in on first', async () => {
    const s = service()
    cron.service = s
    const id = await watchRoutine(s)
    const event = fire(id, 1)
    // The daemon's fan-out: the same event on every link, a moment apart.
    for (const host of NAMES) handleTriggerEvent(host, { ...event })
    // Every copy is settled once the trigger's lane is empty: a duplicate is dropped as it arrives.
    await until(() => acks.length >= 1 && !fireLaneBusy(id))
    expect(runs).toBe(1)
    // Acked once, over the link whose copy arrived first.
    expect(acks).toEqual([{ host: 'newdev', seq: 1 }])
    const job = (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === id)!
    expect(job.state.lastFireSeq).toBe(1)
  })

  it('two different fires still each deliver, one after the other', async () => {
    const s = service()
    cron.service = s
    const id = await watchRoutine(s)
    for (const host of NAMES) handleTriggerEvent(host, fire(id, 1))
    await until(() => runs === 1)
    for (const host of NAMES) handleTriggerEvent(host, fire(id, 2))
    await until(() => acks.length >= 2 && !fireLaneBusy(id))
    expect(runs).toBe(2)
    expect(acks.map((a) => a.seq).sort()).toEqual([1, 2])
  })

  it('a copy that arrives after the delivery ended is a recorded duplicate, acked, never run again', async () => {
    const s = service()
    cron.service = s
    const id = await watchRoutine(s)
    handleTriggerEvent('newdev', fire(id, 1))
    await until(() => acks.length === 1)
    handleTriggerEvent('clouddev', fire(id, 1))
    await until(() => acks.length === 2)
    expect(runs).toBe(1)
    expect(acks.map((a) => a.host)).toEqual(['newdev', 'clouddev'])
  })

  it('a delivery that fails for now is retried from whichever name the replay reaches first, once', async () => {
    const s = service()
    cron.service = s
    const id = await watchRoutine(s)
    let first = true
    cron.run = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 200))
      if (first) { first = false; throw new Error('the host is not reachable right now') }
      return { status: 'ok', summary: 'sent' }
    }
    for (const host of NAMES) handleTriggerEvent(host, fire(id, 1))
    // The failed delivery has ended once the lane is empty.
    await until(() => runs === 1 && !fireLaneBusy(id))
    // Not acked: the daemon keeps it and replays it on every link.
    expect(acks).toEqual([])
    for (const host of ['clouddev', 'newdev']) handleTriggerEvent(host, { ...fire(id, 1), replay: true } as TriggerFiredEvent)
    await until(() => acks.length === 1 && !fireLaneBusy(id))
    expect(runs).toBe(2)
    expect(acks).toEqual([{ host: 'clouddev', seq: 1 }])
  })

  it('a trigger that moved machines: each machine\'s fire is delivered and acked over its own link', async () => {
    const s = service()
    cron.service = s
    const id = await watchRoutine(s)
    // The old machine still replays a fire of its own numbering while the new one fires.
    handleTriggerEvent('olddev', fire(id, 7, 'old-epoch'))
    handleTriggerEvent('clouddev', fire(id, 1, 'new-epoch'))
    await until(() => acks.length === 2 && !fireLaneBusy(id))
    expect(runs).toBe(2)
    expect(acks.sort((a, b) => a.host.localeCompare(b.host))).toEqual([{ host: 'clouddev', seq: 1 }, { host: 'olddev', seq: 7 }])
  })
})
