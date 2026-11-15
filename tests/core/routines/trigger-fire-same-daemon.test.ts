/**
 * A clock fire that arrives on another alias's link of the SAME daemon runs once, judged under
 * the alias that holds the clock (trigger-events.ts clockOwnerAlias).
 *
 * The daemon keeps one set for all its aliases and sends each fire to every link, so a clock
 * held under `<name>-net` comes in on the SSH link too, and after a restart with only the SSH
 * link back, ONLY there. Judged under the link it came in on, its clock read as another host's
 * and the run was dropped as superseded. A fire of a clock held on another daemon is never taken.
 *
 * A real cron store on a temp home; the pool holds two stand-in links whose instance ids say
 * whether they reach one daemon; the daemon's claim and ack are hand-written; the executor is
 * watched at the routines registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-trigger-fire-same-daemon'))
const cron = vi.hoisted(() => ({ service: null as unknown, run: null as null | ((...a: unknown[]) => unknown) }))
vi.mock('../../../src/web/routes/cron.js', () => ({ getCronService: () => cron.service }))
vi.mock('../../../src/core/routines/registry.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/routines/registry.js')>()),
  runExecutor: (...a: unknown[]) => cron.run!(...a),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { CronService } from '../../../src/core/cron/service.js'
import { handleTriggerFired } from '../../../src/core/routines/trigger-events.js'
import { setTriggerDaemonLookupForTest } from '../../../src/core/routines/trigger-daemon.js'
import { setPooledConnectionForTest } from '../../../src/providers/daemon-connection.js'
import type { TriggerFiredEvent } from '../../../src/providers/trigger-check-core.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const SSH = 'studio'
const NET = 'studio-net'
const HOUR = 3_600_000
const BASE = Date.UTC(2026, 10, 15, 12, 0, 0)
const slot = (n: number) => BASE + n * HOUR

let counter = 0
let runExecutor: ReturnType<typeof vi.fn>
let acks: Array<{ host: string; p: Record<string, unknown> }>

function service(): CronService {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return new CronService({
    nowMs: () => slot(1) + 5 * 60_000, log, storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled: false,
    broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor, onEvent: vi.fn(),
  } as never)
}

/** A link in the pool, as far as sameDaemonHosts reads one: its alias and the daemon process its hello named. */
function link(host: string, instance: string): void {
  setPooledConnectionForTest(host, { host, connected: true, daemonInstanceId: instance, liveInstanceId: instance, fenceFileChanges: () => {}, pushTriggers: () => {} } as never)
}

/** A claude-code routine of the net alias, its clock handed to and held by that alias. */
async function netClock(s: CronService): Promise<CronJob> {
  const job = await s.add({
    name: 'Nightly report', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    executor: { type: 'claude-code', config: { cwd: '/srv/repo', host: NET, instructions: 'Write the nightly report' } },
  })
  await s.placeClocks(NET, { wanted: new Set([job.id]), handover: true, knownHosts: new Set([SSH, NET]), eligible: () => true })
  const placed = (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!
  expect(placed.state.clockHost).toBe(NET)
  await s.settleClocks(NET, { clocks: [{ id: job.id, fromMs: placed.state.clockFromMs!, nextRunAtMs: placed.state.clockFromMs! }] })
  return (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!
}

/** The daemon's fire of the clock's first slot; nobody delivered it on the host. */
function fireOf(job: CronJob): TriggerFiredEvent {
  const fromMs = job.state.clockFromMs!
  return { type: 'trigger.fired', id: job.id, epoch: 'e1', seq: 1, atMs: fromMs + 1_000, items: [], durationMs: 0, clock: { slotMs: fromMs, fromMs } }
}

const jobOf = async (s: CronService, id: string) => (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === id)!

beforeEach(() => {
  runExecutor = vi.fn().mockResolvedValue({ status: 'ok', summary: 'started' })
  cron.run = runExecutor
  acks = []
  setTriggerDaemonLookupForTest((host) => ({
    host, hasCapability: () => true, capabilitiesKnown: true, triggersPushed: true,
    send: async (cmd: string, p: Record<string, unknown> = {}) => {
      if (cmd === 'triggers.ack') acks.push({ host, p })
      // This server takes the fire (trigger-claim-v1): it is the server's to run.
      if (cmd === 'triggers.claim') return { ok: true, claimed: p.seqs, unknown: [], host: [], busy: [] }
      return { ok: true }
    },
  }) as never)
})

afterEach(() => {
  setTriggerDaemonLookupForTest(null)
  setPooledConnectionForTest(SSH, null)
  setPooledConnectionForTest(NET, null)
})

describe('a clock fire on another link of the same daemon', () => {
  it('runs once under the alias that holds the clock, and a copy on the owner\'s own link does not run it again', async () => {
    const s = service()
    cron.service = s
    link(SSH, 'd-1')
    link(NET, 'd-1')
    const job = await netClock(s)
    const fire = fireOf(job)

    await handleTriggerFired(SSH, fire)
    expect(runExecutor).toHaveBeenCalledTimes(1)
    const ran = await jobOf(s, job.id)
    // The clock stays the net alias's, at the same handover; the run is the routine's last.
    expect(ran.state.clockHost).toBe(NET)
    expect(ran.state.clockFromMs).toBe(job.state.clockFromMs)
    expect(ran.state.lastStatus).toBe('ok')
    expect(ran.state.lastRunAtMs).toBeGreaterThan(0)
    expect(acks.map((a) => a.p)).toEqual([{ triggerId: job.id, seq: 1, home: WALNUT_HOME }])

    // The same fire on the net link (the daemon sends it to both): recorded once, run once.
    await handleTriggerFired(NET, fire)
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })

  it('an older returned clock arriving on a sibling is judged under its own handover, not the current owner', async () => {
    const s = service()
    cron.service = s
    link(SSH, 'd-1')
    link(NET, 'd-1')
    const job = await netClock(s)
    const fire = fireOf(job)
    await s.update(job.id, { state: {
      clockHost: SSH, clockFromMs: job.state.clockFromMs! + HOUR,
      clockReturned: { host: NET, fromMs: job.state.clockFromMs!, beforeMs: job.state.clockFromMs! + HOUR },
    } })
    await handleTriggerFired(SSH, fire)
    expect(runExecutor).toHaveBeenCalledTimes(1)
    expect((await jobOf(s, job.id)).state.lastStatus).toBe('ok')
  })

  it('an unknown handover arriving on a sibling is never run', async () => {
    const s = service()
    cron.service = s
    link(SSH, 'd-1')
    link(NET, 'd-1')
    const job = await netClock(s)
    const fire = fireOf(job)
    fire.clock!.fromMs -= HOUR
    await handleTriggerFired(SSH, fire)
    expect(runExecutor).not.toHaveBeenCalled()
  })

  it('a fire of a clock held on another daemon is not run under this link', async () => {
    const s = service()
    cron.service = s
    link(SSH, 'd-1')
    link(NET, 'd-2')
    const job = await netClock(s)

    await handleTriggerFired(SSH, fireOf(job))
    expect(runExecutor).not.toHaveBeenCalled()
    // Still the net alias's clock: a stranger's word moves nothing.
    expect((await jobOf(s, job.id)).state.clockHost).toBe(NET)
  })
})
