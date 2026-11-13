/**
 * A routine run whose named host is full starts on another host only when its work is portable
 * and that host can really take it (src/core/routines/run-placement.ts).
 *
 * Why: 2026-11-13, an Inbox Triage run waited for hours on a full Mac ("all 7 slots taken")
 * while clouddev had room. Triage is server API work and runs on clouddev in that host's own
 * Walnut home; work bound to its host (a folder, files on the Mac, the Mac's tools, an existing
 * conversation, a host whose capabilities are unknown) must never be moved. Every host tried is
 * admitted through the real slot lock, and a slot taken on a host the run then leaves is given
 * back.
 *
 * The first part drives the helper with fakes for each host fact; the last part runs it on
 * the real placement (choosePlacement over hostLoads) and the real admission.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-run-placement'))
/** The pool's link facts a test names (unset: the real pool's answer). */
const link = vi.hoisted(() => ({ awakeDownMs: null as number | null, lostSince: null as number | null }))
vi.mock('../../../src/providers/daemon-connection.js', async (orig) => {
  const real = await orig<typeof import('../../../src/providers/daemon-connection.js')>()
  return {
    ...real,
    getDaemonDisconnectedAwakeMs: (host: string) => link.awakeDownMs ?? real.getDaemonDisconnectedAwakeMs(host),
    daemonLinkLostSince: (host: string) => link.lostSince ?? real.daemonLinkLostSince(host),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { __setHostLoadProberForTesting, type PlacementDecision } from '../../../src/core/hosts/placement.js'
import {
  HostsFullError, __resetHostAdmissionForTesting, admitHostStart, startsAdmittedOn,
} from '../../../src/core/sessions/host-admission.js'
import {
  __setRunPlacementDepsForTesting, admitRoutineLaunch, defaultRunPlacementDeps, mapWalnutHomeCwd, portableWorkOf,
  routineLaunchPlacement, routinePlacementOf, sourceDownReason, type AdmitOptions, type RunPlacementDeps,
} from '../../../src/core/routines/run-placement.js'
import { createClaudeCodeExecutor } from '../../../src/core/routines/executors/claude-code.js'
import { TRIAGE_RUN_INSTRUCTIONS, triageInstructionsFor } from '../../../src/core/triage/bootstrap.js'
import type { RoutineLaunch } from '../../../src/core/types.js'

const MAC_HOME = '/Users/me/.open-walnut'
const CLOUD = 'clouddev'
const CLOUD_HOME = '/home/me'
const ADMIT: AdmitOptions = { automatic: true, respectWaiting: true, routine: true }

/** The run the claude-code executor builds from the stored Inbox Triage routine (prod shape, 2026-11-13). */
/** A real batch carries mail and history that name Mac things this run does not need. */
const BATCH = 'WALNUT batch: 3 new mail items, 2 Slack messages.\n- "iOS 26.2 release: xcodebuild and TestFlight changes" (Apple Developer)\n- Calendar: review on my Mac at 15:00'

/** The run's own instructions with `extra` in them (what placement reads), and the batch in front. */
const needs = (extra: string): Partial<RoutineLaunch> => ({
  message: `${BATCH}\n\n${TRIAGE_RUN_INSTRUCTIONS}\n${extra}`, requirementsText: `${TRIAGE_RUN_INSTRUCTIONS}\n${extra}`,
})

function triage(over: Partial<RoutineLaunch> = {}): RoutineLaunch {
  return {
    message: `${BATCH}\n\n${TRIAGE_RUN_INSTRUCTIONS}`, requirementsText: TRIAGE_RUN_INSTRUCTIONS,
    cwd: MAC_HOME, walnutAgent: true, agentId: 'triage', project: 'Ask Inbox Triage',
    taskTitle: 'Triage · 08:10 · 5 items', source: 'routine', jobId: 'muwzrdgn-a460', ...over,
  }
}

const full = (host: string, reason = 'all 7 slots taken') =>
  new HostsFullError(`Not started: ${host} has no room (${reason}).`, { taskId: 'routine-run:x', host, label: host === '__local__' ? 'this Mac' : host, reason })

interface HostFact {
  /** Admission refuses it (true), or refuses after `n` admissions. */
  full?: boolean
  connected?: boolean
  caps?: string[]
  home?: string | null
  closed?: boolean
  tags?: string[] | null
  engine?: 'codex' | undefined
  blocker?: string
  mkdirFails?: boolean
  /** Disconnects as soon as its folder is made. */
  dropsAfterMkdir?: boolean
  /** Asleep or unreachable: its link was lost (the unavailable fact). Default: it answers. */
  down?: boolean
}

/**
 * A fleet: the placement fake offers hosts in this order (the way choosePlacement offers the
 * best-scored first) and returns the first its `eligible` callback accepts.
 */
function fleet(hosts: Record<string, HostFact>, opts: { order?: string[]; placeThrows?: boolean } = {}) {
  const admitted: string[] = []
  const released: string[] = []
  const asked: string[] = []
  const mkdirs: string[] = []
  const placements: number[] = []
  const unavailableAsked: string[] = []
  const deps: RunPlacementDeps = {
    async admit(id, host, o) {
      expect(o).toEqual(ADMIT)
      if (hosts[host]?.full) throw full(host)
      admitted.push(host)
      let done = false
      return () => { if (!done) { done = true; released.push(host) } }
    },
    async place(input) {
      placements.push(1)
      if (opts.placeThrows) throw new Error('no answer in 4 s')
      const from = input.defaultHost || '__local__'
      for (const h of opts.order ?? Object.keys(hosts)) {
        if (h === from) continue
        asked.push(h)
        const why = await input.eligible!(h, { forFiles: false })
        if (!why) return { host: h === '__local__' ? '' : h, moved: true, from, reason: `${h} has room`, hosts: [] } as PlacementDecision
      }
      return { host: input.defaultHost, moved: false, from, reason: 'no other host has room', hosts: [] } as PlacementDecision
    },
    unavailable: async (h) => (unavailableAsked.push(h), hosts[h]?.down ? { label: h, reason: 'it is not connected (asleep or unreachable)' } : null),
    connected: async (h) => hosts[h]?.connected !== false && !hosts[h]?.down,
    hasDaemonCap: async (h, cap) => (hosts[h]?.connected === false ? null : (hosts[h]?.caps ?? ['walnut-mcp-v1']).includes(cap)),
    remoteHome: async (h) => (hosts[h] && 'home' in hosts[h] ? hosts[h].home! : CLOUD_HOME),
    closed: async (h) => !!hosts[h]?.closed,
    capabilities: async (h) => (hosts[h]?.tags === null ? null : { tags: hosts[h]?.tags ?? ['linux', 'cloud'] } as never),
    engineOn: async (h) => hosts[h]?.engine,
    engineBlocker: async (h) => hosts[h]?.blocker ?? null,
    takesMintedId: async (engine) => engine !== 'codex',
    hasSession: async (taskId) => taskId === 'task-with-session',
    async ensureDir(dir, h) {
      if (hosts[h]?.mkdirFails) throw new Error('Permission denied')
      mkdirs.push(`${h}:${dir}`)
      if (hosts[h]?.dropsAfterMkdir) hosts[h].connected = false
    },
    localHome: async () => MAC_HOME,
  }
  return { deps, admitted, released, asked, mkdirs, placements, unavailableAsked }
}

const run = (launch: RoutineLaunch, deps: RunPlacementDeps, extra: Partial<Parameters<typeof admitRoutineLaunch>[1]> = {}) =>
  admitRoutineLaunch(launch, { admissionId: 'routine-run:sid-1', admit: ADMIT, preassignedSessionId: 'sid-1', ...extra }, deps)

describe('admitRoutineLaunch: a full host\'s portable run goes where it can run', () => {
  it('a host with room admits the run there: the launch is unchanged and no other host is weighed', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    const got = await run(triage(), f.deps)
    expect(got).toMatchObject({ moved: false, host: '__local__' })
    expect(got.launch).toEqual(triage())
    expect(f.placements).toHaveLength(0)
    got.release()
    expect(f.released).toEqual(['__local__'])
  })

  it('Inbox Triage on a full Mac starts on clouddev, in clouddev\'s own Walnut home, holding clouddev\'s slot', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const got = await run(triage(), f.deps)
    expect(got.moved).toBe(true)
    expect(got.host).toBe(CLOUD)
    expect(got.launch).toEqual({ ...triage(), host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut` })
    expect(got.reason).toBe('this Mac has no room (all 7 slots taken); clouddev has room')
    expect(f.mkdirs).toEqual([`${CLOUD}:${CLOUD_HOME}/.open-walnut`])
    expect(f.admitted).toEqual([CLOUD])
    expect(f.released).toEqual([])
    got.release(60_000)
    expect(f.released).toEqual([CLOUD])
  })

  it('the message\'s Walnut note refs (notes/Walnut/Triage/State.md, an absolute path into a Walnut home) bind it to no host', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    expect((await run(triage(needs(`State: ${MAC_HOME}/notes/Walnut/Triage/State.md and ~/.open-walnut/notes/Walnut/Triage/Runs/2026-11.md`)), f.deps)).host).toBe(CLOUD)
  })

  it('a queued run that never started (its task, no session) may move; a task with a session keeps its host', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    expect((await run(triage(), f.deps, { existingTaskId: 'queued-task', admissionId: 'queued-task' })).host).toBe(CLOUD)
    const g = fleet({ __local__: { full: true }, [CLOUD]: {} })
    await expect(run(triage(), g.deps, { existingTaskId: 'task-with-session' })).rejects.toMatchObject({ code: 'hosts_full', detail: { host: '__local__' } })
    expect(g.placements).toHaveLength(0)
  })

  it('a session store that cannot be read keeps the host (unknown is never "no session")', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    f.deps.hasSession = async () => { throw new Error('db locked') }
    await expect(run(triage(), f.deps, { existingTaskId: 'queued-task' })).rejects.toBeInstanceOf(HostsFullError)
    expect(f.placements).toHaveLength(0)
  })

  it('a run on a full clouddev comes back to this Mac\'s Walnut home, with no host on the launch', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: { full: true } })
    const got = await run(triage({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut` }), f.deps)
    expect(got.host).toBe('__local__')
    expect(got.launch.cwd).toBe(MAC_HOME)
    expect('host' in got.launch).toBe(false)
  })

  it('an admission error that is not about room is the caller\'s, and no other host is weighed', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    f.deps.admit = async () => { throw new Error('task store unreadable') }
    await expect(run(triage(), f.deps)).rejects.toThrow('task store unreadable')
    expect(f.placements).toHaveLength(0)
  })
})

describe('host-bound work keeps its full host: the caller gets the named host\'s own refusal', () => {
  const cases: Array<[string, RoutineLaunch, Partial<Parameters<typeof admitRoutineLaunch>[1]>?]> = [
    ['an ordinary claude-code routine in a repository', { message: 'Write the nightly report', cwd: '/Users/me/repo', source: 'routine', project: 'Routines' }],
    ['another console agent\'s run (its needs are not registered)', triage({ agentId: 'mentor' })],
    ['a triage run whose folder was changed to a repository', triage({ cwd: '/Users/me/repo' })],
    ['a folder that only shares the home\'s prefix', triage({ cwd: `${MAC_HOME}-old` })],
    ['a run whose instructions name a file on this Mac', triage(needs('Also read /Users/me/Documents/brief.md'))],
    ['a run whose instructions need the Mac\'s tools', triage(needs('Then run xcodebuild test.'))],
    ['an ordinary run with no instructions of its own that needs the Mac\'s tools', { message: 'Run xcodebuild test', cwd: MAC_HOME, source: 'routine', placement: { portable: true } }],
    ['an org start (Main), even with a portable agent', triage({ source: 'org-autostart' })],
    ['a run the caller pins', triage(), { keepHost: true }],
  ]
  for (const [name, launch, extra] of cases) {
    it(name, async () => {
      const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
      const err = await run(launch, f.deps, extra).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostsFullError)
      expect((err as HostsFullError).detail).toMatchObject({ host: '__local__', reason: 'all 7 slots taken' })
      expect(f.placements).toHaveLength(0)
      expect(f.admitted).toEqual([])
    })
  }

  it('portableWorkOf says why, in words', async () => {
    const deps = { localHome: async () => MAC_HOME, remoteHome: async () => null }
    expect(await portableWorkOf(triage({ cwd: '/Users/me/repo' }), '__local__', deps)).toEqual({ stays: 'its folder /Users/me/repo is not Walnut\'s home' })
    expect(await portableWorkOf(triage({ message: 'read /Users/me/a/b.md', requirementsText: undefined }), '__local__', deps)).toEqual({ stays: 'it names /Users/me/a/b.md, which may be only on its host' })
    // A remote host that has not said its home: its folder cannot be known to be Walnut's.
    expect(await portableWorkOf(triage({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut` }), CLOUD, deps)).toMatchObject({ stays: expect.stringContaining('is not Walnut\'s home') })
  })
})

describe('the host it moves to must have what the run needs (unknown is a no)', () => {
  const blocked: Array<[string, HostFact, Partial<Parameters<typeof admitRoutineLaunch>[1]>?]> = [
    ['disconnected', { connected: false }],
    ['closed to work from other hosts', { closed: true }],
    ['a daemon without the Walnut tools (walnut-mcp-v1)', { caps: ['task-dir-v1'] }],
    ['a daemon that has not said its home', { home: null }],
    ['Claude Code not ready there', { blocker: 'Claude Code on clouddev is not signed in' }],
    ['an engine that issues its own ids, for a run that already has one', { engine: 'codex' }],
    ['a native engine for a run that has no id (its engine issues its own here)', {}, { preassignedSessionId: undefined }],
  ]
  for (const [name, fact, extra] of blocked) {
    it(name, async () => {
      const f = fleet({ __local__: { full: true }, [CLOUD]: fact })
      await expect(run(triage(), f.deps, extra)).rejects.toMatchObject({ detail: { host: '__local__' } })
      expect(f.asked).toEqual([CLOUD])
      expect(f.admitted).toEqual([])
      expect(f.mkdirs).toEqual([])
    })
  }

  it('a host that lacks one is passed over for the next that has everything', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: { caps: [] }, box2: {} }, { order: [CLOUD, 'box2'] })
    const got = await run(triage(), f.deps)
    expect(got.host).toBe('box2')
    expect(f.asked).toEqual([CLOUD, 'box2'])
  })

  it('fleet tags: required and present passes, absent or not yet read is a no', async () => {
    const { PORTABLE_AGENT_WORK } = await import('../../../src/core/routines/run-placement.js')
    const work = PORTABLE_AGENT_WORK.triage as { tags: string[] }
    const saved = work.tags
    work.tags = ['always-on']
    try {
      const has = fleet({ __local__: { full: true }, [CLOUD]: { tags: ['linux', 'always-on'] } })
      expect((await run(triage(), has.deps)).host).toBe(CLOUD)
      const lacks = fleet({ __local__: { full: true }, [CLOUD]: { tags: ['linux'] } })
      await expect(run(triage(), lacks.deps)).rejects.toBeInstanceOf(HostsFullError)
      const unknown = fleet({ __local__: { full: true }, [CLOUD]: { tags: null } })
      await expect(run(triage(), unknown.deps)).rejects.toBeInstanceOf(HostsFullError)
    } finally {
      work.tags = saved
    }
  })
})

describe('races: a slot taken on a host the run leaves is given back', () => {
  it('the host placement picked filled up before its slot lock: the next host takes it, the first is not asked again', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {}, box2: {} }, { order: [CLOUD, 'box2'] })
    const admit = f.deps.admit
    f.deps.admit = async (id, host, o) => (host === CLOUD ? Promise.reject(full(CLOUD, 'all 24 slots taken')) : admit(id, host, o))
    const got = await run(triage(), f.deps)
    expect(got.host).toBe('box2')
    expect(f.placements).toHaveLength(2)
    expect(f.asked).toEqual([CLOUD, CLOUD, 'box2'])
  })

  it('every host filled up: the named host\'s refusal, nothing left admitted', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    f.deps.admit = async (_id, host) => { throw full(host) }
    const err = await run(triage(), f.deps).catch((e: unknown) => e)
    expect((err as HostsFullError).detail.host).toBe('__local__')
    expect(f.admitted).toEqual([])
  })

  it('it disconnected after its slot was taken: the slot is released and the next host takes the run', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: { dropsAfterMkdir: true }, box2: {} }, { order: [CLOUD, 'box2'] })
    const got = await run(triage(), f.deps)
    expect(got.host).toBe('box2')
    expect(f.admitted).toEqual([CLOUD, 'box2'])
    expect(f.released).toEqual([CLOUD])
  })

  it('the link check itself failed after its slot was taken: read as disconnected, the slot is released', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    let checks = 0
    f.deps.connected = async () => { if (++checks > 1) throw new Error('pool closed'); return true }
    await expect(run(triage(), f.deps)).rejects.toMatchObject({ detail: { host: '__local__' } })
    expect(f.admitted).toEqual([CLOUD])
    expect(f.released).toEqual([CLOUD])
  })

  it('its folder could not be made: the slot is released and the named host\'s refusal stands', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: { mkdirFails: true } })
    await expect(run(triage(), f.deps)).rejects.toMatchObject({ detail: { host: '__local__' } })
    expect(f.admitted).toEqual([CLOUD])
    expect(f.released).toEqual([CLOUD])
  })

  it('placement could not answer: the named host\'s refusal, nothing admitted', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} }, { placeThrows: true })
    await expect(run(triage(), f.deps)).rejects.toBeInstanceOf(HostsFullError)
    expect(f.admitted).toEqual([])
  })
})

/**
 * A routine whose named host is asleep or unreachable (its link was lost): an automatic run is
 * never admitted on it and never spawned there to fail. Portable work goes to a connected host
 * with room that can take it, chosen the same way as for a full host; anything else is refused
 * with an honest reason (no slot words), so the caller records the capacity wait and the queue
 * holds it until the host is back.
 */
describe('an unreachable named host is unavailable, the same as a full one', () => {
  const DOWN = 'it is not connected (asleep or unreachable)'
  const onCloud = (over: Partial<RoutineLaunch> = {}) => triage({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut`, ...over })

  it('portable Triage on an asleep clouddev starts on this Mac when its card says always-on, in its Walnut home, nothing admitted on clouddev', async () => {
    const f = fleet({ __local__: { tags: ['macos', 'always-on'] }, [CLOUD]: { down: true } })
    const got = await run(onCloud(), f.deps)
    expect(got).toMatchObject({ moved: true, host: '__local__' })
    expect(got.launch.cwd).toBe(MAC_HOME)
    expect('host' in got.launch).toBe(false)
    expect(got.reason).toBe(`clouddev cannot take it (${DOWN}); this Mac has room`)
    expect(f.admitted).toEqual(['__local__'])
    got.release()
    expect(f.released).toEqual(['__local__'])
  })

  it('a host that is not always-on (this Mac, a laptop) or whose card was never read never takes work off an asleep host', async () => {
    for (const tags of [['macos', 'local'], null]) {
      const f = fleet({ __local__: { tags }, [CLOUD]: { down: true }, laptop: { tags: ['linux'] } }, { order: ['__local__', 'laptop'] })
      const err = await run(onCloud(), f.deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostsFullError)
      expect((err as HostsFullError).detail).toMatchObject({ host: CLOUD, reason: DOWN })
      expect(f.asked).toEqual(['__local__', 'laptop'])
      expect(f.admitted).toEqual([])
    }
  })

  it('a full host\'s work still goes to a host that is not always-on (only an asleep host\'s work needs one)', async () => {
    const f = fleet({ __local__: { tags: ['macos', 'local'] }, [CLOUD]: { full: true } })
    expect((await run(onCloud(), f.deps)).host).toBe('__local__')
  })

  it('the routine\'s own capabilities are required alongside always-on', async () => {
    const launch: RoutineLaunch = { message: 'Digest', cwd: `${CLOUD_HOME}/.open-walnut`, host: CLOUD, source: 'routine', placement: { portable: true, capabilities: ['docker'] } }
    const f = fleet({ [CLOUD]: { down: true }, box2: { tags: ['always-on'] }, box3: { tags: ['docker'] }, box4: { tags: ['docker', 'always-on'] } }, { order: ['box2', 'box3', 'box4'] })
    expect((await run(launch, f.deps)).host).toBe('box4')
  })

  it('the host it moves to must still be connected and pass every check: the next capable one takes it', async () => {
    const on = ['linux', 'always-on']
    const f = fleet({ [CLOUD]: { down: true }, __local__: { full: true, tags: on }, box2: { connected: false, tags: on }, box3: { caps: [], tags: on }, box4: { tags: on } }, { order: ['__local__', 'box2', 'box3', 'box4'] })
    const got = await run(onCloud(), f.deps)
    expect(got.host).toBe('box4')
    expect(got.launch).toMatchObject({ host: 'box4', cwd: `${CLOUD_HOME}/.open-walnut` })
    expect(f.admitted).toEqual(['box4'])
  })

  it('no other host can take it: the unavailable refusal (its host, honest words, no slot numbers), nothing held', async () => {
    const f = fleet({ [CLOUD]: { down: true }, __local__: { full: true, tags: ['always-on'] } })
    const err = await run(onCloud(), f.deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostsFullError)
    const detail = (err as HostsFullError).detail
    expect(detail).toEqual({ taskId: 'routine-run:sid-1', host: CLOUD, label: CLOUD, reason: DOWN })
    expect((err as Error).message).toBe(`Not started: clouddev cannot take it (${DOWN}).`)
    expect(f.admitted).toEqual([])
    expect(f.released).toEqual([])
  })

  // Class guard: every launch shape that keeps its host stays pending on an unavailable host,
  // never admitted (so never spawned) there, and the refusal never claims full slots.
  const pinned: Array<[string, RoutineLaunch, Partial<Parameters<typeof admitRoutineLaunch>[1]>?]> = [
    ['an ordinary claude-code routine in a repository', { message: 'Write the nightly report', cwd: '/home/me/repo', host: CLOUD, source: 'routine', project: 'Routines' }],
    ['another console agent\'s run', onCloud({ agentId: 'mentor' })],
    ['a run whose instructions need the Mac\'s tools', onCloud(needs('Then run xcodebuild test.'))],
    ['an org start', onCloud({ source: 'org-autostart' })],
    ['a spawn retry the caller pins', onCloud(), { keepHost: true }],
    ['a task whose spawn outcome is unknown (it has a session)', onCloud(), { existingTaskId: 'task-with-session' }],
  ]
  for (const [name, launch, extra] of pinned) {
    it(`stays pending: ${name}`, async () => {
      const f = fleet({ [CLOUD]: { down: true }, __local__: {} })
      const err = await run(launch, f.deps, extra).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostsFullError)
      const detail = (err as HostsFullError).detail
      expect(detail).toMatchObject({ host: CLOUD, reason: DOWN })
      expect(detail.running).toBeUndefined()
      expect(detail.cap).toBeUndefined()
      expect(detail.reason).not.toMatch(/slot/)
      expect(f.admitted).toEqual([])
      expect(f.mkdirs).toEqual([])
    })
  }

  it('a person\'s start is exempt: it is admitted on the host it names and the unavailable fact is not read', async () => {
    const f = fleet({ [CLOUD]: { down: true }, __local__: {} })
    const admit = f.deps.admit
    f.deps.admit = (id, host) => admit(id, host, ADMIT)
    const got = await run(onCloud(), f.deps, { admit: { automatic: false, respectWaiting: false, routine: true } })
    expect(got).toMatchObject({ moved: false, host: CLOUD })
    expect(f.unavailableAsked).toEqual([])
  })

  it('this Mac (the server itself) is never asked whether it is unavailable', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    await run(triage(), f.deps)
    expect(f.unavailableAsked).toEqual([])
  })

  it('a connected clouddev with room admits the run there as before', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    const got = await run(onCloud(), f.deps)
    expect(got).toMatchObject({ moved: false, host: CLOUD })
    expect(f.unavailableAsked).toEqual([CLOUD])
  })

  it('an unavailable fact that fails or never answers counts as available: admitted on its host as before, within the budget', async () => {
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    f.deps.unavailable = async () => { throw new Error('pool closed') }
    expect((await run(onCloud(), f.deps)).host).toBe(CLOUD)
    process.env.WALNUT_ROUTINE_PLACE_MS = '50'
    try {
      const g = fleet({ __local__: {}, [CLOUD]: {} })
      g.deps.unavailable = () => new Promise(() => {})
      const t0 = Date.now()
      expect((await run(onCloud(), g.deps)).host).toBe(CLOUD)
      expect(Date.now() - t0).toBeLessThan(2_000)
    } finally {
      delete process.env.WALNUT_ROUTINE_PLACE_MS
    }
  })

  it('the search from an unavailable host is bounded too: past the budget, the unavailable refusal', async () => {
    process.env.WALNUT_ROUTINE_PLACE_MS = '50'
    try {
      const f = fleet({ [CLOUD]: { down: true }, __local__: {} })
      f.deps.place = () => new Promise(() => {})
      await expect(run(onCloud(), f.deps)).rejects.toMatchObject({ detail: { host: CLOUD, reason: DOWN } })
      expect(f.admitted).toEqual([])
    } finally {
      delete process.env.WALNUT_ROUTINE_PLACE_MS
    }
  })

  it('placement is told the named host is unavailable (it never keeps the work there)', async () => {
    const f = fleet({ [CLOUD]: { down: true }, __local__: {} })
    const seen: Array<string | undefined> = []
    const place = f.deps.place
    f.deps.place = async (input) => { seen.push(input.unavailable); return place(input) }
    await run(onCloud(), f.deps).catch(() => undefined)
    expect(seen).toEqual([DOWN])
    const g = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const seenFull: Array<string | undefined> = []
    const placeG = g.deps.place
    g.deps.place = async (input) => { seenFull.push(input.unavailable); return placeG(input) }
    await run(triage(), g.deps)
    expect(seenFull).toEqual([undefined])
  })
})

describe('sourceDownReason: when a remote host counts as unavailable (awake time its link has been down)', () => {
  afterEach(() => { link.awakeDownMs = null; link.lostSince = null })

  it('0 (never linked, or up) and a drop under 30 s of awake time are not known to be down; 30 s or more is', () => {
    expect(sourceDownReason(0)).toBeNull()
    expect(sourceDownReason(29_999)).toBeNull()
    expect(sourceDownReason(Number.NaN)).toBeNull()
    expect(sourceDownReason(30_000)).toBe('it is not connected (asleep or unreachable)')
    expect(sourceDownReason(10 * 60_000)).toBe('it is not connected (asleep or unreachable)')
  })

  it('the real fact for a host this server never linked to (no pool entry, none in the direct pool) is null', async () => {
    expect(await defaultRunPlacementDeps().unavailable('never-linked-host')).toBeNull()
  })

  it('a Mac that slept 8 h: lost 8 h ago by the wall clock but down under 30 s awake is still available, and the run is not moved', async () => {
    link.lostSince = Date.now() - 8 * 60 * 60_000
    link.awakeDownMs = 10_000
    const deps = defaultRunPlacementDeps()
    expect(await deps.unavailable(CLOUD)).toBeNull()
    const f = fleet({ __local__: {}, [CLOUD]: {} })
    f.deps.unavailable = deps.unavailable
    expect(await run(triage({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut` }), f.deps)).toMatchObject({ moved: false, host: CLOUD })
  })

  it('down 10 minutes of awake time: unavailable, with its name', async () => {
    link.awakeDownMs = 10 * 60_000
    expect(await defaultRunPlacementDeps().unavailable(CLOUD)).toEqual({ label: expect.any(String), reason: 'it is not connected (asleep or unreachable)' })
    expect(await defaultRunPlacementDeps().unavailable('__local__')).toBeNull()
  })
})

describe('mapWalnutHomeCwd: the same place in the other host\'s Walnut home', () => {
  const deps = { localHome: async () => `${MAC_HOME}/`, remoteHome: async (h: string) => (h === CLOUD ? `${CLOUD_HOME}/` : h === 'rootless' ? '/' : null) }
  it('maps the home and a folder in it, either way, and nothing else', async () => {
    expect(await mapWalnutHomeCwd(MAC_HOME, '__local__', CLOUD, deps)).toBe('/home/me/.open-walnut')
    expect(await mapWalnutHomeCwd(`${MAC_HOME}/agents/triage/`, '__local__', CLOUD, deps)).toBe('/home/me/.open-walnut/agents/triage')
    expect(await mapWalnutHomeCwd('/home/me/.open-walnut', CLOUD, '__local__', deps)).toBe(MAC_HOME)
    expect(await mapWalnutHomeCwd(`${MAC_HOME}-old`, '__local__', CLOUD, deps)).toBeNull()
    expect(await mapWalnutHomeCwd(MAC_HOME, '__local__', 'unknown-host', deps)).toBeNull()
    expect(await mapWalnutHomeCwd(MAC_HOME, '__local__', 'rootless', deps)).toBeNull()
  })
})

describe('on the real placement and admission (choosePlacement over hostLoads, the slot lock)', () => {
  const load = { cpus: 8, load: [0.5, 0.5, 0.5], cpuBusy: 0.1, memTotalBytes: 32 * 1024 ** 3, memAvailBytes: 20 * 1024 ** 3, diskPath: '/', diskFreeBytes: 500 * 1024 ** 3, diskTotalBytes: 1000 * 1024 ** 3 }
  const mkdirs: string[] = []
  /** The real admit and place; the link facts of a connected clouddev that mounts the Walnut tools. */
  const deps = (): RunPlacementDeps => ({
    ...defaultRunPlacementDeps(),
    connected: async () => true,
    hasDaemonCap: async () => true,
    remoteHome: async () => CLOUD_HOME,
    closed: async () => false,
    engineOn: async () => undefined,
    engineBlocker: async () => null,
    hasSession: async () => false,
    ensureDir: async (dir, host) => { mkdirs.push(`${host}:${dir}`) },
  })

  beforeAll(async () => {
    // One slot on this Mac, two on clouddev.
    await updateConfig({ hosts: { [CLOUD]: { hostname: 'clouddev.example.test' } }, session_limits: { local: 1, [CLOUD]: 2 } } as never)
    __setHostLoadProberForTesting(async () => ({ ...load, at: new Date().toISOString() }))
  })
  afterEach(() => { __resetHostAdmissionForTesting(); mkdirs.length = 0 })
  afterAll(() => { __setHostLoadProberForTesting(null) })

  const launch = () => triage({ cwd: WALNUT_HOME })
  const opts = (id: string) => ({ admissionId: id, admit: { automatic: true, routine: true }, preassignedSessionId: id })

  it('this Mac full: the run is admitted on clouddev and holds a slot there until released', async () => {
    const other = await admitHostStart('task-on-mac', '__local__', { automatic: true })
    // The admission alone (the routine start before this helper) refuses the run: it would wait for this Mac.
    await expect(admitHostStart('routine-run:a', '__local__', { automatic: true, routine: true })).rejects.toMatchObject({ code: 'hosts_full' })
    const got = await admitRoutineLaunch(launch(), opts('routine-run:a'), deps())
    expect(got).toMatchObject({ moved: true, host: CLOUD, launch: { host: CLOUD, cwd: '/home/me/.open-walnut' } })
    expect(got.reason).toBe('this Mac has no room (all 1 slots taken); clouddev has room (0 of 2 slots taken)')
    expect(startsAdmittedOn(CLOUD)).toBe(1)
    expect(startsAdmittedOn('__local__')).toBe(1)
    got.release()
    expect(startsAdmittedOn(CLOUD)).toBe(0)
    other()
  })

  it('two runs on a full Mac take clouddev\'s two slots; the third gets this Mac\'s refusal and takes nothing', async () => {
    const other = await admitHostStart('task-on-mac', '__local__', { automatic: true })
    const [a, b] = await Promise.all([
      admitRoutineLaunch(launch(), opts('routine-run:a'), deps()),
      admitRoutineLaunch(launch(), opts('routine-run:b'), deps()),
    ])
    expect([a.host, b.host]).toEqual([CLOUD, CLOUD])
    const err = await admitRoutineLaunch(launch(), opts('routine-run:c'), deps()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostsFullError)
    expect((err as HostsFullError).detail.host).toBe('__local__')
    expect(startsAdmittedOn(CLOUD)).toBe(2)
    a.release(); b.release(); other()
    expect(startsAdmittedOn(CLOUD)).toBe(0)
  })

  it('a task whose only session is a start known to have failed may move; one that ran or may still come up keeps its host', async () => {
    const { hasSession } = defaultRunPlacementDeps()
    const record = async (sid: string, taskId: string, updates: Record<string, unknown>) => {
      await createSessionRecord(sid, taskId, 'Ask Inbox Triage', WALNUT_HOME, { initialProcessStatus: 'idle' } as never)
      await updateSessionRecord(sid, updates as never)
    }
    await record('11111111-0000-0000-0000-000000000001', 'task-failed', { process_status: 'error', status_reason: 'api_error', errorMessage: 'spawn refused' })
    await record('11111111-0000-0000-0000-000000000002', 'task-unknown', { process_status: 'error', status_reason: 'spawn_outcome_unknown' })
    await record('11111111-0000-0000-0000-000000000003', 'task-ran', { process_status: 'stopped', status_reason: 'turn_completed' })
    expect(await hasSession('task-none')).toBe(false)
    expect(await hasSession('task-failed')).toBe(false)
    expect(await hasSession('task-unknown')).toBe(true)
    expect(await hasSession('task-ran')).toBe(true)
  })

  it('an asleep clouddev (its last load reading says room): the real placement moves the run to an always-on Mac only, never back to clouddev', async () => {
    const reason = 'it is not connected (asleep or unreachable)'
    const asleep = (macTags: string[] | null): RunPlacementDeps => ({
      ...deps(),
      unavailable: async (h) => (h === CLOUD ? { label: 'clouddev', reason } : null),
      connected: async (h) => h !== CLOUD,
      capabilities: async (h) => (h === '__local__' && macTags ? { tags: macTags } as never : null),
    })
    const onCloud = () => triage({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut` })
    const got = await admitRoutineLaunch(onCloud(), opts('routine-run:a'), asleep(['macos', 'always-on']))
    expect(got).toMatchObject({ moved: true, host: '__local__', launch: { cwd: WALNUT_HOME } })
    expect('host' in got.launch).toBe(false)
    expect(startsAdmittedOn(CLOUD)).toBe(0)
    expect(startsAdmittedOn('__local__')).toBe(1)
    got.release()
    // A Mac that is not always-on (a laptop), or whose card was not read: the unavailable refusal, nothing held.
    for (const tags of [['macos', 'local'], null]) {
      await expect(admitRoutineLaunch(onCloud(), opts('routine-run:c'), asleep(tags)))
        .rejects.toMatchObject({ code: 'hosts_full', detail: { host: CLOUD, reason } })
      expect(startsAdmittedOn('__local__')).toBe(0)
      expect(startsAdmittedOn(CLOUD)).toBe(0)
    }
    // An always-on Mac that is full too: the unavailable refusal on clouddev, nothing held anywhere.
    const other = await admitHostStart('task-on-mac', '__local__', { automatic: true })
    await expect(admitRoutineLaunch(onCloud(), opts('routine-run:b'), asleep(['always-on'])))
      .rejects.toMatchObject({ code: 'hosts_full', detail: { host: CLOUD, reason } })
    expect(startsAdmittedOn(CLOUD)).toBe(0)
    expect(startsAdmittedOn('__local__')).toBe(1)
    other()
  })

  it('a clouddev weighted "never" is no place to go', async () => {
    await updateConfig({ placement_weights: { [CLOUD]: 0 } } as never)
    try {
      const other = await admitHostStart('task-on-mac', '__local__', { automatic: true })
      await expect(admitRoutineLaunch(launch(), opts('routine-run:a'), deps())).rejects.toBeInstanceOf(HostsFullError)
      expect(startsAdmittedOn(CLOUD)).toBe(0)
      expect(mkdirs).toEqual([])
      other()
    } finally {
      await updateConfig({ placement_weights: {} } as never)
    }
  })
})

describe('a routine declares its runs portable: placement { portable, capabilities }', () => {
  it('routinePlacementOf normalizes and checks the declaration', () => {
    expect(routinePlacementOf(undefined)).toEqual({ ok: true })
    expect(routinePlacementOf({ portable: false })).toEqual({ ok: true })
    expect(routinePlacementOf({ portable: true })).toEqual({ ok: true, placement: { portable: true } })
    expect(routinePlacementOf({ portable: true, capabilities: [' Linux ', 'mcp:slack', 'linux'] }))
      .toEqual({ ok: true, placement: { portable: true, capabilities: ['linux', 'mcp:slack'] } })
    const bad: unknown[] = [
      'yes', [], { portable: 'true' }, { portable: true, capabilities: 'linux' }, { portable: true, capabilities: ['two words'] },
      { portable: true, capabilities: [7] }, { portable: true, host: 'clouddev' }, { capabilities: ['linux'] },
      { portable: true, capabilities: Array.from({ length: 17 }, (_, i) => `tag${i}`) },
    ]
    for (const raw of bad) expect(routinePlacementOf(raw)).toMatchObject({ ok: false, error: expect.stringMatching(/placement/) })
  })

  it('the claude-code executor saves it normalized, refuses a bad one, and leaves an ordinary routine as it was', () => {
    const def = createClaudeCodeExecutor()
    expect(def.validate({ instructions: 'x', cwd: '/tmp', placement: { portable: true, capabilities: ['Docker'] } }))
      .toEqual({ ok: true, config: { instructions: 'x', cwd: '/tmp', placement: { portable: true, capabilities: ['docker'] } } })
    expect(def.validate({ instructions: 'x', cwd: '/tmp', placement: { portable: true, capabilities: ['no good'] } })).toMatchObject({ ok: false })
    expect(def.validate({ instructions: 'x', cwd: '/tmp' })).toEqual({ ok: true, config: { instructions: 'x', cwd: '/tmp' } })
    expect(def.validate({ instructions: 'x', cwd: '/tmp', placement: { portable: false } })).toEqual({ ok: true, config: { instructions: 'x', cwd: '/tmp' } })
  })

  it('the executor\'s launch carries the declaration and, behind a batch, the routine\'s own instructions', async () => {
    const launches: RoutineLaunch[] = []
    const starter = async () => ({ start: async (input: { launch: RoutineLaunch }) => { launches.push(input.launch); return { task: { id: 't1' }, confirmed: true } } }) as never
    const def = createClaudeCodeExecutor({ starter })
    const job = { id: 'job-1', name: 'Digest', state: {} } as never
    const config = { instructions: 'Summarize the batch through Walnut tools.', cwd: WALNUT_HOME, placement: { portable: true, capabilities: ['linux'] } }
    await def.run(job, { type: 'claude-code', config } as never, `BATCH\n\n${config.instructions}`)
    await def.run(job, { type: 'claude-code', config } as never, config.instructions)
    await def.run(job, { type: 'claude-code', config: { instructions: 'Plain', cwd: '/srv/repo' } } as never, 'BATCH\n\nPlain')
    expect(launches[0]).toMatchObject({ placement: { portable: true, capabilities: ['linux'] }, requirementsText: config.instructions })
    expect(launches[1].placement).toEqual({ portable: true, capabilities: ['linux'] })
    expect('requirementsText' in launches[1]).toBe(false)
    // A routine that may not move carries neither field: its launch (and its stored copy) is as before.
    expect('placement' in launches[2] || 'requirementsText' in launches[2]).toBe(false)
  })

  it('routineLaunchPlacement gives the registered Triage routine its instructions, and a stored bad declaration nothing', () => {
    const instructions = triageInstructionsFor({ mode: 'ask', autoMarkRead: false } as never)
    expect(routineLaunchPlacement({ instructions, walnutAgent: true, agentId: 'triage' }, `${BATCH}\n\n${instructions}`)).toEqual({ requirementsText: instructions })
    expect(routineLaunchPlacement({ instructions, placement: { portable: 'yes' } }, `${BATCH}\n\n${instructions}`)).toEqual({})
  })

  it('an ordinary routine that declares itself portable moves when its folder is Walnut\'s home', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const launch: RoutineLaunch = { message: 'Digest the new tasks through Walnut tools', cwd: `${MAC_HOME}/digest`, source: 'routine', placement: { portable: true } }
    expect((await run(launch, f.deps)).launch).toMatchObject({ host: CLOUD, cwd: `${CLOUD_HOME}/.open-walnut/digest` })
  })

  it('a declaration does not free a run from its folder: one in a repository keeps its host', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    await expect(run({ message: 'Digest', cwd: '/Users/me/repo', source: 'routine', placement: { portable: true } }, f.deps)).rejects.toBeInstanceOf(HostsFullError)
    expect(f.placements).toHaveLength(0)
  })

  it('the capabilities it declares are required of the host, and the Walnut tools are always', async () => {
    const launch: RoutineLaunch = { message: 'Digest', cwd: MAC_HOME, source: 'routine', placement: { portable: true, capabilities: ['docker'] } }
    const lacks = fleet({ __local__: { full: true }, [CLOUD]: { tags: ['linux'] }, box2: { tags: ['linux', 'docker'] } }, { order: [CLOUD, 'box2'] })
    expect((await run(launch, lacks.deps)).host).toBe('box2')
    const noTools = fleet({ __local__: { full: true }, [CLOUD]: { tags: ['docker'], caps: [] } })
    await expect(run(launch, noTools.deps)).rejects.toBeInstanceOf(HostsFullError)
  })

  it('a stored declaration that is not valid (an older or hand-edited record) keeps the host', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const launch = { message: 'Digest', cwd: MAC_HOME, source: 'routine', placement: { portable: true, capabilities: ['two words'] } } as RoutineLaunch
    await expect(run(launch, f.deps)).rejects.toBeInstanceOf(HostsFullError)
    expect(f.placements).toHaveLength(0)
  })
})

describe('what a run needs is read from its instructions, not from the batch in front of them', () => {
  it('a batch naming iOS, xcodebuild and "my Mac" does not pin Triage; placement is handed the instructions', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const texts: string[] = []
    const place = f.deps.place
    f.deps.place = async (input) => { texts.push(input.text); return place(input) }
    expect((await run(triage(), f.deps)).host).toBe(CLOUD)
    expect(texts).toEqual([TRIAGE_RUN_INSTRUCTIONS])
  })

  it('a Triage launch stored before requirementsText existed is read from its instructions too', async () => {
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    expect((await run(triage({ requirementsText: undefined }), f.deps)).host).toBe(CLOUD)
  })

  it('Triage\'s own instructions in every mode never pin it to a host', async () => {
    const deps = { localHome: async () => MAC_HOME, remoteHome: async () => null }
    for (const mode of ['ask', 'assist', 'auto']) {
      for (const autoMarkRead of [false, true]) {
        const instructions = triageInstructionsFor({ mode, autoMarkRead } as never)
        const got = await portableWorkOf(triage({ message: `${BATCH}\n\n${instructions}`, requirementsText: instructions }), '__local__', deps)
        expect(got, `${mode} ${autoMarkRead}`).toMatchObject({ work: { what: 'Inbox Triage' } })
      }
    }
  })
})

describe('the search is bounded: a host that never answers holds no routine', () => {
  afterEach(() => { delete process.env.WALNUT_ROUTINE_PLACE_MS })

  it('placement that never answers: the named host\'s refusal within the budget', async () => {
    process.env.WALNUT_ROUTINE_PLACE_MS = '50'
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    f.deps.place = () => new Promise(() => {})
    const t0 = Date.now()
    await expect(run(triage(), f.deps)).rejects.toMatchObject({ detail: { host: '__local__' } })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(f.admitted).toEqual([])
  })

  it('an admission that answers after the budget gives its slot back at once', async () => {
    process.env.WALNUT_ROUTINE_PLACE_MS = '50'
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    const admit = f.deps.admit
    // Clouddev's slot lock answers only once the budget has passed (the test lets it go below).
    let answer!: () => void
    const held = new Promise<void>((resolve) => { answer = resolve })
    let late!: Promise<(holdMs?: number) => void>
    f.deps.admit = (id, host, o) => {
      if (host === '__local__') return admit(id, host, o)
      late = held.then(() => admit(id, host, o))
      return late
    }
    await expect(run(triage(), f.deps)).rejects.toBeInstanceOf(HostsFullError)
    expect(f.admitted).toEqual([])
    answer()
    await late
    await vi.waitFor(() => expect(f.released).toEqual([CLOUD]))
    expect(f.admitted).toEqual([CLOUD])
  })

  it('a folder that is still being made past the budget: the slot is given back', async () => {
    process.env.WALNUT_ROUTINE_PLACE_MS = '50'
    const f = fleet({ __local__: { full: true }, [CLOUD]: {} })
    f.deps.ensureDir = () => new Promise(() => {})
    await expect(run(triage(), f.deps)).rejects.toBeInstanceOf(HostsFullError)
    expect(f.released).toEqual([CLOUD])
  })
})

describe('the test seam and the entry points', () => {
  afterEach(() => __setRunPlacementDepsForTesting(null))

  it('__setRunPlacementDepsForTesting replaces only the facts it names', async () => {
    __setRunPlacementDepsForTesting({ remoteHome: async () => '/home/seam' })
    const deps = defaultRunPlacementDeps()
    expect(await deps.remoteHome(CLOUD)).toBe('/home/seam')
    expect(await deps.localHome()).toBe(WALNUT_HOME)
    __setRunPlacementDepsForTesting(null)
    expect(await defaultRunPlacementDeps().remoteHome(CLOUD)).toBeNull()
  })

  it('every routine start builds its launch\'s placement through routineLaunchPlacement, and the queue replays the stored launch as it is', () => {
    const root = path.resolve('src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    const starts: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      // A routine start: the starter's start({ ... launch: { ... } }).
      for (const m of text.matchAll(/(?:routineRunStarter|starter)\(\)\)\.start\(\{/g)) {
        const call = text.slice(m.index!, m.index! + 2_500)
        const launch = call.slice(call.indexOf('launch:'), call.indexOf('\n        },') > 0 ? call.indexOf('\n        },') + 1 : undefined)
        starts.push(`${path.relative(root, file)}: ${launch.includes('routineLaunchPlacement(') ? 'ok' : 'MISSING routineLaunchPlacement'}`)
      }
    }
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect(starts.filter((s) => !s.endsWith(': ok'))).toEqual([])
    const queue = fs.readFileSync(path.join(root, 'core/sessions/start-queue.ts'), 'utf8')
    expect(queue).toMatch(/defaultRunStartDeps\(\)\.launch\(entry\.routine,/)
  })
})
