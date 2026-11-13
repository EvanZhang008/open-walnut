/**
 * A portable routine's clock on an always-on host (clock-portable.ts, clock-placement.ts).
 *
 * Why: a routine that is only server API work has no host of its own, so while the Mac is
 * awake its clock may go to a connected, free, always-on host, which starts the run itself
 * when the Mac sleeps (clock-host-start-v1). The routine's configured host never changes;
 * a routine bound to a host, a console agent (persona and init not ready off the Mac), an
 * init routine, one that needs this Mac's tools, and any routine while the backup-leader
 * switch is off, keep today's placement. Only the host facts are faked (connection,
 * capabilities, load, engine, home); the cron store, the handover and the push are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-clock-portable'))

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { placeClocks, revertClocks, settleClocks, takeBackStranded } from '../../../src/core/cron/clock-handover.js'
import { applyTriggerFired } from '../../../src/core/cron/trigger-apply.js'
import {
  __setClockPlacementDepsForTesting, _ownerWatchForTest, _resetClockPlacementForTest, OWNER_REFRESH_MS, defaultPlacementDeps, placeClocksForHost, takeBackStrandedClocks,
  type ClockService, type PlacementDeps,
} from '../../../src/core/routines/clock-placement.js'
import { ALWAYS_ON_TAG, capabilitiesOf, defaultPortableClockEnv, type PortableClockEnv } from '../../../src/core/routines/clock-portable.js'
import type { RunPlacementDeps } from '../../../src/core/routines/run-placement.js'
import { START_TASK_TOKEN, type ClockStartSpec } from '../../../src/providers/trigger-clock-core.js'
import { validateTriggerDef } from '../../../src/providers/trigger-check-core.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { recordProbedFacts } from '../../../src/core/hosts/host-profile.js'
import type { HostCapabilities } from '../../../src/core/hosts/capabilities.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const BOX = 'always-box'
const OTHER = 'other-box'
const SRC = 'src-box'
const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)
const slot = (n: number) => BASE + n * HOUR

let counter = 0
let now: { value: number }

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
}

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => now.value, log: mockLog(), storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor: vi.fn().mockResolvedValue({ status: 'ok' }), onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

function serviceOf(state: CronServiceState): ClockService {
  return {
    placeClocks: (host, opts) => placeClocks(state, host, opts),
    settleClocks: (host, reply) => settleClocks(state, host, reply),
    revertClocks: (host, handed) => revertClocks(state, host, handed),
    takeBackStranded: (host, ids) => takeBackStranded(state, host, ids),
  }
}

const jobsOf = async (state: CronServiceState): Promise<CronJob[]> => await ops.list(state, { includeDisabled: true, recompute: false })
const jobOf = async (state: CronServiceState, id: string): Promise<CronJob> => (await jobsOf(state)).find((j) => j.id === id)!

const card = (tags: string[], unknown: string[] = []): HostCapabilities => ({
  tags, alwaysOn: tags.includes(ALWAYS_ON_TAG) ? true : null, placement: null, os: 'linux', ios: null, browsers: [], mcp: [], clis: [], declared: [], unknown,
})

/** The facts the world says: every field a test turns is one external fact, never the handover. */
interface Facts {
  connected: Record<string, boolean>
  caps: Record<string, HostCapabilities | null>
  closed: Set<string>
  noMcp: Set<string>
  free: Record<string, boolean | null>
  home: Record<string, string | null>
  down: Set<string>
  allowed: boolean
  engineBlocker: string | null
}
let facts: Facts

function freshFacts(): Facts {
  return {
    connected: { [BOX]: true, [OTHER]: true, [SRC]: false },
    caps: { [BOX]: card(['always-on', 'linux']), [OTHER]: card(['always-on', 'linux']) },
    closed: new Set(), noMcp: new Set(), free: { [BOX]: true, [OTHER]: true, [SRC]: true },
    home: { [BOX]: '/home/box', [OTHER]: '/home/other', [SRC]: '/home/src' }, down: new Set(), allowed: true, engineBlocker: null,
  }
}

let ensured: Array<[string, string]>
let ensureFails: string | null

function env(): PortableClockEnv {
  const run: RunPlacementDeps = {
    admit: async () => { throw new Error('a clock push admits no slot') },
    place: async () => { throw new Error('a clock push chooses nothing by load placement') },
    connected: async (h) => facts.connected[h] === true,
    hasDaemonCap: async (h) => (facts.connected[h] ? !facts.noMcp.has(h) : null),
    remoteHome: async (h) => facts.home[h] ?? null,
    closed: async (h) => facts.closed.has(h),
    capabilities: async (h) => facts.caps[h] ?? null,
    engineOn: async () => undefined,
    engineBlocker: async () => facts.engineBlocker,
    takesMintedId: async () => true,
    hasSession: async () => false,
    ensureDir: async (dir, host) => { if (ensureFails) throw new Error(ensureFails); ensured.push([host, dir]) },
    localHome: async () => WALNUT_HOME,
    unavailable: async (h) => (facts.down.has(h) ? { label: h, reason: 'it is not connected (asleep or unreachable)' } : null),
  }
  return { run, free: async (h) => facts.free[h] ?? null, allowed: async () => facts.allowed }
}

const startOf = (host: string, cwd: string): ClockStartSpec => ({
  home: WALNUT_HOME, host, title: 'Routine: Portable', project: 'Routines', cwd, message: 'Summarize the board', mode: 'auto', context: `task ${START_TASK_TOKEN}`,
})

/** What the real routineStartOf would produce is proven in clock-host-start-placement.test.ts; here only the cwd it is given matters. */
function deps(over: Partial<PlacementDeps> = {}): PlacementDeps {
  return {
    hosts: async () => new Set([BOX, OTHER, SRC]),
    getTask: async () => null,
    sessionsForTask: async () => [],
    connected: async (h) => facts.connected[h] === true,
    routineStart: async (job, host, at) => (at ? startOf(host, at.cwd) : null),
    portable: env(),
    ...over,
  }
}

const portableCwd = () => path.join(WALNUT_HOME, 'routines', 'board')

const portable = (over: Partial<CronJobCreate> = {}, config: Record<string, unknown> = {}): CronJobCreate => ({
  name: 'Portable', enabled: true, wakeMode: 'now',
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'claude-code', config: { cwd: portableCwd(), instructions: 'Summarize the board', placement: { portable: true }, ...config } },
  ...over,
})

/** Push to `host` as the daemon connection does for a daemon that holds clocks and starts runs. */
const push = async (state: CronServiceState, host: string, d: PlacementDeps = deps(), over: { hostStart?: boolean; capability?: 'yes' | 'no' | 'unknown' } = {}) =>
  await placeClocksForHost(serviceOf(state), host, await jobsOf(state), over.capability ?? 'yes', d, { hostStart: over.hostStart ?? true })

async function holdOn(state: CronServiceState, host: string, id: string, d: PlacementDeps = deps()): Promise<ClockStartSpec | undefined> {
  const placed = await push(state, host, d)
  const j = await jobOf(state, id)
  expect(j.state.clockHost, 'handed').toBe(host)
  await placed.applied({ clocks: [{ id, fromMs: j.state.clockFromMs!, nextRunAtMs: j.state.clockFromMs! }] })
  return placed.defs.find((d) => d.id === id)?.start
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  now = { value: BASE + 1_000 }
  facts = freshFacts()
  ensured = []
  ensureFails = null
  _resetClockPlacementForTest()
})

afterEach(async () => {
  __setClockPlacementDepsForTesting(null)
  vi.unstubAllEnvs()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a portable claude-code routine takes its clock to an always-on host', () => {
  it('hands the clock over with a start in that host\'s Walnut home, and leaves the routine\'s own host untouched', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    const placed = await push(state, BOX)
    expect(placed.handed).toEqual([job.id])
    const def = placed.defs[0]!
    expect(def.deliver).toBeUndefined()
    expect(def.start).toMatchObject({ host: BOX, cwd: '/home/box/.open-walnut/routines/board', message: 'Summarize the board' })
    // The daemon would accept the def as sent.
    expect(validateTriggerDef(JSON.parse(JSON.stringify(def)))).toMatchObject({ ok: true })
    const stored = await jobOf(state, job.id)
    expect(stored.state).toMatchObject({ clockHost: BOX, clockFromMs: slot(1) })
    // The source stays as configured: nothing renames it to the host that holds the clock.
    expect((stored.executor!.config as Record<string, unknown>).host).toBeUndefined()
    await placed.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, job.id)).state.clockStarts).toBe(true)
  })

  it('the Mac awake takes the host\'s fire and runs the routine as it always did; one run per slot', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    const deliver = vi.fn(async (_j: CronJob) => ({ status: 'ok' as const, summary: 'ran' }))
    const fire = { type: 'trigger.fired' as const, id: job.id, epoch: 'e1', seq: 1, atMs: slot(1), items: [], durationMs: 0, clock: { slotMs: slot(1), fromMs: slot(1) } }
    expect(await applyTriggerFired(state, fire, deliver, { fromHost: BOX })).toMatchObject({ found: true, delivered: true })
    expect((deliver.mock.calls[0]![0].executor!.config as Record<string, unknown>).host).toBeUndefined()
    expect(await applyTriggerFired(state, fire, deliver, { fromHost: BOX })).toMatchObject({ duplicate: true })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('keeps every routine that cannot run off this Mac on the server timer', async () => {
    const state = makeState()
    const stay = [
      await ops.add(state, portable({ name: 'Not declared' }, { placement: undefined })),
      await ops.add(state, portable({ name: 'Declared not portable' }, { placement: { portable: false } })),
      await ops.add(state, portable({ name: 'Console agent' }, { walnutAgent: true, agentId: 'inbox-triage' })),
      await ops.add(state, portable({ name: 'Old triage', initProcessor: { actionId: 'inbox-triage-batch' } }, { walnutAgent: true, agentId: 'inbox-triage' })),
      await ops.add(state, portable({ name: 'Init routine', initProcessor: { actionId: 'fetch' } })),
      await ops.add(state, portable({ name: 'Mac tools' }, { instructions: 'Open the Messages app with osascript and summarize it' })),
      await ops.add(state, portable({ name: 'Local file' }, { instructions: 'Read /Users/someone/notes/todo.md and summarize it' })),
      await ops.add(state, portable({ name: 'Folder outside Walnut home' }, { cwd: '/Users/someone/repo' })),
      await ops.add(state, portable({ name: 'Paused', enabled: false })),
      await ops.add(state, portable({ name: 'Counter', wake: { events: ['plugin:x:y'], threshold: 3 } })),
    ]
    const placed = await push(state, BOX)
    expect(placed.handed).toEqual([])
    expect(placed.defs).toEqual([])
    for (const j of stay) expect((await jobOf(state, j.id)).state.clockHost, j.name).toBeUndefined()
  })

  it('a routine that names a host stays bound to it, backup switch or not', async () => {
    const state = makeState()
    const bound = await ops.add(state, portable({ name: 'Bound' }, { host: OTHER, placement: { portable: true } }))
    facts.allowed = false
    const onBox = await push(state, BOX)
    expect(onBox.handed).toEqual([])
    const onOther = await push(state, OTHER)
    expect(onOther.handed).toEqual([bound.id])
    expect((await jobOf(state, bound.id)).state.clockHost).toBe(OTHER)
  })

  it('a bound claude-code routine\'s def is what it was: its start has no mapping, no delivery', async () => {
    const state = makeState()
    await ops.add(state, portable({ name: 'Bound' }, { host: BOX, cwd: '/srv/repo', placement: undefined }))
    const calls: unknown[] = []
    const placed = await push(state, BOX, deps({ routineStart: async (j, h, at) => { calls.push(at); return startOf(h, '/srv/repo') } }))
    expect(calls).toEqual([undefined])
    expect(placed.defs[0]?.start?.cwd).toBe('/srv/repo')
  })
})

describe('a portable routine that names a host of its own', () => {
  const remote = (): CronJobCreate => portable({ name: 'Remote portable' }, { host: SRC, cwd: '/home/src/.open-walnut/routines/board' })

  it('goes to an always-on host while no host holds its clock, up or down, its source setting untouched', async () => {
    for (const down of [true, false]) {
      facts = freshFacts()
      if (down) facts.down.add(SRC)
      const state = makeState()
      const job = await ops.add(state, remote())
      const placed = await push(state, BOX)
      expect(placed.handed, `down=${down}`).toEqual([job.id])
      // Its folder is the same place in the new host's Walnut home as in its own host's.
      expect(placed.defs[0]!.start).toMatchObject({ host: BOX, cwd: '/home/box/.open-walnut/routines/board' })
      expect(((await jobOf(state, job.id)).executor!.config as Record<string, unknown>).host).toBe(SRC)
    }
  })

  it('its own host takes it only as any host does: a source that is not always-on, pushed first, leaves it to the always-on host', async () => {
    const state = makeState()
    const job = await ops.add(state, remote())
    facts.connected[SRC] = true
    facts.caps[SRC] = card(['linux'])
    expect((await push(state, SRC)).handed).toEqual([])
    expect((await push(state, BOX)).handed).toEqual([job.id])
    // A source that is itself always-on and fit may take it, its folder mapped onto itself.
    facts.caps[SRC] = card(['always-on', 'linux'])
    const second = makeState()
    const other = await ops.add(second, remote())
    const onSrc = await push(second, SRC)
    expect(onSrc.handed).toEqual([other.id])
    expect(onSrc.defs[0]!.start).toMatchObject({ host: SRC, cwd: '/home/src/.open-walnut/routines/board' })
  })

  it('a host that does not fit leaves it where it is', async () => {
    const state = makeState()
    await ops.add(state, remote())
    facts.caps[BOX] = card(['linux'])
    expect((await push(state, BOX)).handed).toEqual([])
  })

  it('never takes a clock its own host holds, however long that host is gone', async () => {
    const state = makeState()
    const job = await ops.add(state, remote())
    facts.connected[SRC] = true
    facts.caps[SRC] = card(['always-on', 'linux'])
    await holdOn(state, SRC, job.id)
    facts.connected[SRC] = false
    facts.down.add(SRC)
    expect((await push(state, BOX)).handed).toEqual([])
    expect((await jobOf(state, job.id)).state.clockHost).toBe(SRC)
  })

  it('stays on the always-on host while its own host is away, and goes back through the daemon\'s reply only when that host\'s push takes it', async () => {
    const state = makeState()
    const job = await ops.add(state, remote())
    await holdOn(state, BOX, job.id)
    expect((await push(state, BOX)).defs.map((d) => d.id)).toEqual([job.id])
    // Its own host connecting never takes a clock another host holds.
    facts.connected[SRC] = true
    expect((await push(state, SRC)).handed).toEqual([])
    expect((await jobOf(state, job.id)).state.clockHost).toBe(BOX)
  })

  it('a console agent or an undeclared routine on a named host stays bound to it', async () => {
    const state = makeState()
    await ops.add(state, portable({ name: 'Agent' }, { host: SRC, walnutAgent: true, agentId: 'x' }))
    await ops.add(state, portable({ name: 'Undeclared' }, { host: SRC, placement: undefined }))
    facts.down.add(SRC)
    expect((await push(state, BOX)).handed).toEqual([])
  })
})

describe('the host a portable clock may live on', () => {
  async function handedTo(host: string): Promise<{ handed: string[] }> {
    const state = makeState()
    await ops.add(state, portable())
    return { handed: (await push(state, host)).handed }
  }

  it.each([
    ['not connected', () => { facts.connected[BOX] = false }],
    ['not always-on', () => { facts.caps[BOX] = card(['linux']) }],
    ['its capabilities not known', () => { facts.caps[BOX] = null }],
    ['its always-on not read yet', () => { facts.caps[BOX] = card(['linux'], ['always-on']) }],
    ['closed to work from other hosts', () => { facts.closed.add(BOX) }],
    ['its daemon lacks the Walnut MCP', () => { facts.noMcp.add(BOX) }],
    ['its Walnut home not known', () => { facts.home[BOX] = null }],
    ['busy', () => { facts.free[BOX] = false }],
    ['its load not known', () => { facts.free[BOX] = null }],
    ['its engine not ready', () => { facts.engineBlocker = 'Claude Code is not signed in there' }],
  ])('a new handover needs a host that is not: %s', async (_name, spoil) => {
    spoil()
    expect((await handedTo(BOX)).handed).toEqual([])
  })

  it('a daemon that cannot start runs, or has not said it holds clocks, gets none', async () => {
    const state = makeState()
    await ops.add(state, portable())
    expect((await push(state, BOX, deps(), { hostStart: false })).handed).toEqual([])
    for (const capability of ['no', 'unknown'] as const) {
      const placed = await push(state, BOX, deps(), { capability })
      expect(placed.handed).toEqual([])
      expect(placed.defs).toEqual([])
    }
  })

  it('a start the host cannot be given means no handover: the clock would gain nothing', async () => {
    const state = makeState()
    await ops.add(state, portable())
    expect((await push(state, BOX, deps({ routineStart: async () => null }))).handed).toEqual([])
  })

  it('the first free always-on host that is pushed to takes it; the other waits for it to be given back', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    expect((await push(state, OTHER)).handed).toEqual([])
    expect((await jobOf(state, job.id)).state.clockHost).toBe(BOX)
  })

  it('a host that does not pass is never pushed a portable routine by an exception in its facts', async () => {
    const state = makeState()
    await ops.add(state, portable())
    const boom = deps({ portable: { ...env(), free: async () => { throw new Error('probe failed') } } })
    expect((await push(state, BOX, boom)).handed).toEqual([])
  })
})

describe('a held clock is judged more gently than a new handover', () => {
  it('stays when the host\'s capabilities or Walnut home are merely not known, with the start the daemon accepted, unchanged', async () => {
    for (const unsure of [() => { facts.caps[BOX] = null }, () => { facts.caps[BOX] = card(['linux'], ['always-on']) }, () => { facts.home[BOX] = null }]) {
      facts = freshFacts()
      const state = makeState()
      const job = await ops.add(state, portable())
      const accepted = await holdOn(state, BOX, job.id)
      unsure()
      const again = await push(state, BOX)
      expect(again.defs.map((d) => d.id)).toEqual([job.id])
      expect(again.defs[0]!.start).toEqual(accepted)
      expect((await jobOf(state, job.id)).state.clockHost).toBe(BOX)
    }
  })

  it('stays on a busy host: room is asked only before the handover', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    facts.free[BOX] = false
    const again = await push(state, BOX)
    expect(again.defs.map((d) => d.id)).toEqual([job.id])
    expect(again.defs[0]!.start?.host).toBe(BOX)
  })

  it('goes back to the server when the host plainly stops fitting: no longer always-on, closed, or the routine no longer portable', async () => {
    const cases: Array<[string, (state: CronServiceState, id: string) => Promise<void>]> = [
      ['not always-on', async () => { facts.caps[BOX] = card(['linux']) }],
      ['closed', async () => { facts.closed.add(BOX) }],
      ['no longer portable', async (state, id) => { await ops.update(state, id, { executor: { type: 'claude-code', config: { cwd: portableCwd(), instructions: 'Summarize the board' } } }) }],
    ]
    for (const [name, spoil] of cases) {
      facts = freshFacts()
      const state = makeState()
      const job = await ops.add(state, portable())
      await holdOn(state, BOX, job.id)
      await spoil(state, job.id)
      const again = await push(state, BOX)
      expect(again.defs, name).toEqual([])
      // The daemon's reply gives it back, from where it stood.
      await again.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
      expect((await jobOf(state, job.id)).state.clockHost, name).toBeUndefined()
    }
  })
})

describe('the backup-leader switch', () => {
  it('off: no portable routine is delegated, and a held clock is given back', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    facts.allowed = false
    const again = await push(state, BOX)
    expect(again.defs).toEqual([])
    await again.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, job.id)).state.clockHost).toBeUndefined()
    // Nor is it handed again while the switch is off.
    expect((await push(state, BOX)).handed).toEqual([])
  })

  it('off, a switch that cannot be read counts as off', async () => {
    const state = makeState()
    await ops.add(state, portable())
    const bad = deps({ portable: { ...env(), allowed: async () => { throw new Error('config unreadable') } } })
    expect((await push(state, BOX, bad)).handed).toEqual([])
  })

  it('off, a session routine on its host still moves there as before', async () => {
    const state = makeState()
    facts.allowed = false
    const job = await ops.add(state, {
      name: 'Session', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      executor: { type: 'session', config: { target: 'task-1', prompt: 'p', instructions: 'p' } },
    })
    const placed = await push(state, BOX, deps({
      getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }],
    }))
    expect(placed.handed).toEqual([job.id])
    expect(placed.defs[0]?.deliver?.taskId).toBe('task-1')
  })
})

describe('a clock on a host that is not connected', () => {
  const stranded = async (state: CronServiceState, d: PlacementDeps) => await takeBackStrandedClocks(serviceOf(state), await jobsOf(state), d)

  it('stays however long the host has been unreachable: no lease says the daemon stopped its own clock', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    facts.connected[BOX] = false
    expect(await stranded(state, deps())).toEqual([])
    facts.down.add(BOX)
    expect(await stranded(state, deps())).toEqual([])
    expect((await jobOf(state, job.id)).state.clockHost).toBe(BOX)
  })

  it('with the switch off, a started clock still waits for its daemon\'s reply; a connected host is never swept', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    await holdOn(state, BOX, job.id)
    expect(await stranded(state, deps())).toEqual([])
    facts.connected[BOX] = false
    facts.allowed = false
    expect(await stranded(state, deps())).toEqual([])
    expect((await jobOf(state, job.id)).state.clockHost).toBe(BOX)
  })
})

describe('a clock whose start the daemon accepted', () => {
  const sessionJob = (): CronJobCreate => ({
    name: 'Session', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    executor: { type: 'session', config: { target: 'task-1', prompt: 'p', instructions: 'p' } },
  })
  const doneTask = deps({ getTask: async (id) => ({ id, phase: 'COMPLETE' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }] })
  const live = deps({ getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }] })

  it('stays with an unreachable host whatever the routine looks like now; a deliver-only clock still goes back when its owner is done', async () => {
    const state = makeState()
    const portableJob = await ops.add(state, portable())
    await holdOn(state, BOX, portableJob.id)
    expect((await jobOf(state, portableJob.id)).state.clockStarts).toBe(true)
    const bound = await ops.add(state, sessionJob())
    const placed = await push(state, BOX, live)
    expect(placed.handed).toEqual([bound.id])
    const heldAt = (id: string, from: number) => ({ id, fromMs: from, nextRunAtMs: from })
    await placed.applied({ clocks: [heldAt(bound.id, slot(1)), heldAt(portableJob.id, (await jobOf(state, portableJob.id)).state.clockFromMs!)] })
    expect((await jobOf(state, bound.id)).state.clockStarts).toBeUndefined()
    expect((await jobOf(state, portableJob.id)).state.clockStarts).toBe(true)
    facts.connected[BOX] = false
    // The switch off and the routine edited: the daemon that accepted a start still answers for the clock.
    facts.allowed = false
    await ops.update(state, portableJob.id, { executor: { type: 'claude-code', config: { cwd: portableCwd(), instructions: 'Summarize the board' } } })
    expect(await takeBackStrandedClocks(serviceOf(state), await jobsOf(state), doneTask)).toEqual([bound.id])
    expect((await jobOf(state, portableJob.id)).state.clockHost).toBe(BOX)
    expect((await jobOf(state, bound.id)).state.clockHost).toBeUndefined()
  })

  it('a deliver-only clock keeps the ordinary rules even when the offline seam would take the routine: owner complete or session moved to the Mac', async () => {
    const seam = { portable: () => true, startOf: async () => null }
    const sessions = (host?: string) => async () => [{ process_status: 'idle', ...(host ? { host } : {}) }]
    for (const [name, taskPhase, host] of [['owner complete', 'COMPLETE', BOX], ['session moved to the Mac', 'IN_PROGRESS', undefined]] as const) {
      facts = freshFacts()
      const state = makeState()
      const bound = await ops.add(state, sessionJob())
      const placed = await push(state, BOX, deps({ getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: sessions(BOX) }))
      await placed.applied({ clocks: [{ id: bound.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
      expect((await jobOf(state, bound.id)).state.clockStarts, name).toBeUndefined()
      facts.connected[BOX] = false
      const d = deps({ offline: seam, getTask: async (id) => ({ id, phase: taskPhase }), sessionsForTask: sessions(host) })
      expect(await takeBackStrandedClocks(serviceOf(state), await jobsOf(state), d), name).toEqual([bound.id])
    }
  })

  it('config unreadable: a clock keeps the start the daemon accepted, or, with none on record, is left out for the daemon to release; X paused or deleted still reaches the host', async () => {
    const unreadable = (d: PlacementDeps): PlacementDeps => ({ ...d, hosts: async () => null })
    const state = makeState()
    const y = await ops.add(state, portable({ name: 'Y' }))
    const x = await ops.add(state, sessionJob())
    const both = deps({ getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }] })
    const first = await push(state, BOX, both)
    const at = (id: string) => ({ id, fromMs: slot(1), nextRunAtMs: slot(1) })
    await first.applied({ clocks: [at(y.id), at(x.id)] })
    const accepted = first.defs.find((d) => d.id === y.id)!.start
    // The start the daemon accepted is sent again as it was.
    const same = await push(state, BOX, unreadable(both))
    expect(same.defs.map((d) => d.id).sort()).toEqual([x.id, y.id].sort())
    expect(same.defs.find((d) => d.id === y.id)!.start).toEqual(accepted)
    // X paused: it is gone from the set, Y still carries its accepted start.
    await ops.update(state, x.id, { enabled: false })
    const paused = await push(state, BOX, unreadable(both))
    expect(paused.defs.map((d) => d.id)).toEqual([y.id])
    expect(paused.defs[0]!.start).toEqual(accepted)
    // This server restarted (no record of what was accepted): Y is left out for the daemon to release, X's delete still goes out.
    _resetClockPlacementForTest()
    await ops.remove(state, x.id)
    const forgotten = await push(state, BOX, unreadable(both))
    expect(forgotten.defs).toEqual([])
    // The daemon's reply gives Y back from where it stood.
    await forgotten.applied({ clocks: [], released: [{ id: y.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, y.id)).state.clockHost).toBeUndefined()
    // A held clock with no accepted start has nothing to lose: it goes on as before.
    const plain = makeState()
    const bound = await ops.add(plain, sessionJob())
    const live1 = await push(plain, BOX, both)
    await live1.applied({ clocks: [at(bound.id)] })
    const again = await push(plain, BOX, unreadable(both))
    expect(again.defs.map((d) => d.id)).toEqual([bound.id])
  })

  it('one clock whose facts are not known keeps its accepted start while the rest of the set goes on: a pause or a delete elsewhere reaches the host', async () => {
    const state = makeState()
    const y = await ops.add(state, portable({ name: 'Y' }))
    const x = await ops.add(state, sessionJob())
    const both = deps({ getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }] })
    const first = await push(state, BOX, both)
    const fromMs = (id: string) => ({ id, fromMs: slot(1), nextRunAtMs: slot(1) })
    await first.applied({ clocks: [fromMs(y.id), fromMs(x.id)] })
    const accepted = first.defs.find((d) => d.id === y.id)!.start
    facts.home[BOX] = null
    // X paused, Y's facts unknown: X is gone from the set, Y keeps the start it had.
    await ops.update(state, x.id, { enabled: false })
    const paused = await push(state, BOX, both)
    expect(paused.defs.map((d) => d.id)).toEqual([y.id])
    expect(paused.defs[0]!.start).toEqual(accepted)
    // X deleted: the same.
    await ops.remove(state, x.id)
    const deleted = await push(state, BOX, both)
    expect(deleted.defs.map((d) => d.id)).toEqual([y.id])
    expect(deleted.defs[0]!.start).toEqual(accepted)
    // A later answer from the host gives Y a freshly built start again.
    facts.home[BOX] = '/home/box'
    expect((await push(state, BOX, both)).defs[0]!.start).toEqual(accepted)
  })

})

describe('offline routines the routines layer supplies (main-agent and session reflection)', () => {
  const offlineJob = (): CronJobCreate => ({
    name: 'Reflection', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    executor: { type: 'main-agent', config: { text: 'Reflect on the day' } },
  })
  const offline = (over: Partial<NonNullable<PlacementDeps['offline']>> = {}): NonNullable<PlacementDeps['offline']> => ({
    portable: (j) => j.executor?.type === 'main-agent',
    startOf: async (_j, host) => startOf(host, `/home/${host}/.open-walnut/reflect`),
    ...over,
  })

  it('delegates the clock with the start it supplies, no delivery, owner untouched', async () => {
    const state = makeState()
    const job = await ops.add(state, offlineJob())
    const placed = await push(state, BOX, deps({ offline: offline() }))
    expect(placed.handed).toEqual([job.id])
    expect(placed.defs[0]).toMatchObject({ id: job.id, start: { host: BOX, cwd: '/home/always-box/.open-walnut/reflect' } })
    expect(placed.defs[0]!.deliver).toBeUndefined()
    expect((await jobOf(state, job.id)).executor).toMatchObject({ type: 'main-agent', config: { text: 'Reflect on the day' } })
  })

  it('a session routine whose session is on the Mac is delegated without delivery; one on a host stays bound there', async () => {
    const state = makeState()
    const job = await ops.add(state, {
      name: 'Session reflection', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      executor: { type: 'session', config: { target: 'task-1', prompt: 'Reflect', instructions: 'Reflect' } },
    })
    const mac = deps({ offline: offline({ portable: () => true }), getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle' }] })
    const placed = await push(state, BOX, mac)
    expect(placed.handed).toEqual([job.id])
    expect(placed.defs[0]!.deliver).toBeUndefined()
    expect(placed.defs[0]!.start?.host).toBe(BOX)
    await placed.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    // The session moves to the other host: its own placement takes the clock there (BOX gives it back first).
    const moved = deps({ offline: offline({ portable: () => true }), getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: OTHER }] })
    const old = await push(state, BOX, moved)
    expect(old.defs).toEqual([])
  })

  it('a start that comes back null leaves the routine on its own path, held or not, never an empty def', async () => {
    const state = makeState()
    const job = await ops.add(state, offlineJob())
    await holdOn(state, BOX, job.id, deps({ offline: offline() })) // placed with a start
    const now = deps({ offline: offline({ startOf: async () => null }) })
    const again = await push(state, BOX, now)
    expect(again.defs).toEqual([])
    await again.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, job.id)).state.clockHost).toBeUndefined()
  })

  it('an owner whose conversation runs on that host keeps its delivery, never a start-only def', async () => {
    const state = makeState()
    const job = await ops.add(state, {
      name: 'VP reflection', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      executor: { type: 'session', config: { target: 'task-vp', prompt: 'Reflect', instructions: 'Reflect' } },
    })
    // The seam would say no (startOf null) because the owner's session is on BOX: the bound path delivers.
    const atBox = deps({
      offline: offline({ portable: () => true, startOf: async () => null }),
      getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }), sessionsForTask: async () => [{ process_status: 'idle', host: BOX }],
    })
    const placed = await push(state, BOX, atBox)
    expect(placed.handed).toEqual([job.id])
    expect(placed.defs[0]).toMatchObject({ deliver: { taskId: 'task-vp' } })
    expect(placed.defs[0]!.start).toBeUndefined()
  })

  it('watches the owner a start samples, and pushes again at most once a minute, last change included', async () => {
    const state = makeState()
    const job = await ops.add(state, offlineJob())
    const placed = await push(state, BOX, deps({ offline: offline({ ownerOf: async () => 'task-main' }) }))
    expect(placed.handed).toEqual([job.id])
    expect(_ownerWatchForTest().owners.get(job.id)).toBe('task-main')
    // A routine that is no longer held here is forgotten (its owner is no longer watched).
    await ops.update(state, job.id, { enabled: false })
    await push(state, BOX, deps({ offline: offline({ ownerOf: async () => 'task-main' }) }))
    expect(_ownerWatchForTest().owners.has(job.id)).toBe(false)
  })

  it('the owner refresh is leading and trailing, one push per minute window', () => {
    vi.useFakeTimers()
    try {
      const { refresh } = _ownerWatchForTest()
      const t0 = Date.now()
      const seen: number[] = []
      // scheduleClockPlacement is debounced 3 s and imports the daemon pool: only the schedule shape is checked here.
      refresh(t0)
      refresh(t0 + 1_000)
      refresh(t0 + 2_000)
      seen.push(vi.getTimerCount())
      // One debounce timer for the leading change, one trailing timer for the rest of the window.
      expect(seen[0]).toBe(2)
      expect(OWNER_REFRESH_MS).toBe(60_000)
    } finally {
      _resetClockPlacementForTest()
      vi.useRealTimers()
    }
  })

  it('nothing is delegated without the seam, or when it says no, or has no start for that host', async () => {
    const state = makeState()
    await ops.add(state, offlineJob())
    expect((await push(state, BOX, deps())).handed).toEqual([])
    expect((await push(state, BOX, deps({ offline: offline({ portable: () => false }) }))).handed).toEqual([])
    expect((await push(state, BOX, deps({ offline: offline({ startOf: async () => null }) }))).handed).toEqual([])
    facts.caps[BOX] = card(['linux'])
    expect((await push(state, BOX, deps({ offline: offline() }))).handed).toEqual([])
  })

  it('a routine with an init processor or a wake counter is never offline work', async () => {
    const state = makeState()
    await ops.add(state, { ...offlineJob(), name: 'Init', initProcessor: { actionId: 'fetch' } })
    await ops.add(state, { ...offlineJob(), name: 'Wake', wake: { events: ['plugin:x:y'], threshold: 2 } })
    expect((await push(state, BOX, deps({ offline: offline({ portable: () => true }) }))).handed).toEqual([])
  })
})

describe('the folder, the push budget and the default facts', () => {
  it('makes the run\'s folder on the host once, before a new handover, and a folder it cannot make means no handover', async () => {
    const state = makeState()
    const job = await ops.add(state, portable())
    const placed = await push(state, BOX)
    expect(ensured).toEqual([[BOX, '/home/box/.open-walnut/routines/board']])
    await placed.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    await push(state, BOX)
    expect(ensured).toHaveLength(1)
    const other = makeState()
    await ops.add(other, portable())
    ensureFails = 'its link did not answer'
    expect((await push(other, BOX)).handed).toEqual([])
  })

  it('facts that do not answer in time hand nothing over and keep a held clock where it is', async () => {
    vi.stubEnv('WALNUT_CLOCK_PORTABLE_MS', '50')
    const hang = deps({ portable: { ...env(), free: () => new Promise(() => {}) } })
    const fresh = makeState()
    await ops.add(fresh, portable())
    expect((await push(fresh, BOX, hang)).handed).toEqual([])
    const held = makeState()
    const job = await ops.add(held, portable())
    await holdOn(held, BOX, job.id)
    const hungHome = deps({ portable: { ...env(), run: { ...env().run, capabilities: () => new Promise(() => {}) } } })
    const waiting = await push(held, BOX, hungHome)
    expect(waiting.defs[0]!.start).toMatchObject({ host: BOX })
    expect((await jobOf(held, job.id)).state.clockHost).toBe(BOX)
    // A start that never arrives is no start: a new handover waits for the next push.
    const hungStart = makeState()
    await ops.add(hungStart, portable())
    expect((await push(hungStart, BOX, deps({ routineStart: () => new Promise(() => {}) }))).handed).toEqual([])
  })

  it('the test seam merges over the real wiring, and the real wiring carries the offline seam', () => {
    expect(defaultPlacementDeps().offline?.portable).toBeTypeOf('function')
    const hosts = async () => new Set(['x'])
    __setClockPlacementDepsForTesting({ hosts })
    expect(defaultPlacementDeps().hosts).toBe(hosts)
    expect(defaultPlacementDeps().routineStart).toBeTypeOf('function')
  })

  it('knows a host\'s declared tags and its probed home without a fleet read', async () => {
    await updateConfig({ hosts: { declared: { hostname: 'declared.example.test', capabilities: ['always-on'] }, plain: { hostname: 'plain.example.test' } } } as never)
    await recordProbedFacts('declared', { os: { platform: 'linux', release: '5' }, arch: 'x64', cpus: 2, memBytes: 1, home: '/home/probed', proxyEnv: {}, cloud: null, internet: null, tools: {} } as never)
    const run = defaultPortableClockEnv().run
    expect((await run.capabilities('declared'))?.tags).toContain(ALWAYS_ON_TAG)
    // Nothing declared, nothing probed: always-on is not known (never read as a no).
    const plain = await run.capabilities('plain')
    expect(plain?.tags).not.toContain(ALWAYS_ON_TAG)
    expect(plain?.unknown).toContain(ALWAYS_ON_TAG)
    expect(await run.capabilities('ghost')).toBeNull()
    expect(await run.remoteHome('declared')).toBe('/home/probed')
    expect(await run.remoteHome('plain')).toBeNull()
  })

  it('a card read before the user declared always-on does not hide the declaration', async () => {
    await updateConfig({ hosts: { late: { hostname: 'late.example.test', capabilities: ['always-on', 'Docker'] } } } as never)
    const stale = card(['linux'], ['always-on'])
    const merged = await capabilitiesOf('late', { capabilities: async () => stale })
    expect(merged?.tags).toEqual(expect.arrayContaining(['linux', 'always-on', 'docker']))
    expect(merged).toMatchObject({ alwaysOn: true, unknown: [] })
    // The cached card itself is not touched, and a card that already has the tags comes back as it is.
    expect(stale.tags).toEqual(['linux'])
    const whole = card(['linux', 'always-on', 'docker'])
    expect(await capabilitiesOf('late', { capabilities: async () => whole })).toBe(whole)
  })
})
