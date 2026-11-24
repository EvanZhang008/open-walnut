/**
 * orphan-stop-v1, daemon side: `stop` with reason 'orphan' ends a session only
 * when THIS daemon proves it spawned the process and nothing keeps it alive.
 * The server may never signal a pid it read from its database (2026-09-26: an
 * ephemeral test server killed the user's live CLIs that way); it asks, and
 * this is the answer.
 *
 * owner-home-v1, same place: every other stop names the asking Walnut, and the
 * spawn journal decides whether that Walnut may stop the session.
 *
 * The daemon is exercised from its own text: cmdStop, orphanStopRefusal and
 * stopOwnerRefusal are sliced out of daemon-standalone.ts and evaluated with
 * every free identifier injected (its per-session gate is the real
 * DaemonSessionGate). stopSessionProcess (the only
 * code that signals) is a stub, and process.kill is spied on and asserted
 * never called. No process, file or socket is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'
import { DaemonSessionGate } from '../../src/providers/daemon-cron-controller.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const REPO_ROOT = nodePath.resolve(__dirname, '../..')
const SID = '11111111-2222-4333-8444-555555555555'
/** Above any real pid limit: nothing can ever answer to it. */
const PID = 2 ** 22 + 11
const PGID_PATH = `/fixture/streams/${SID}.pgid`
const JSONL_PATH = `/fixture/streams/${SID}.jsonl`
const HOME = '/fixture/walnut-home'
const IDLE_WARNING_MS = 5 * 60 * 1000
const IDLE_KILL_MS = 2 * 60 * 60 * 1000

interface Reply { id: number; ok: boolean; error?: string; data?: Record<string, unknown> }

function sliceTopLevelFn(src: string, name: string): string {
  const at = src.search(new RegExp('(?:async )?function ' + name + '\\('))
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end + 2)
}

interface World {
  session: Record<string, unknown> | null
  pgidFile: string | null
  jsonlMtimeMs: number | null
  journaled: Set<string>
  /** sid -> data dir of the Walnut that asked for its first spawn (journal `home`). */
  journalHomes: Map<string, string>
  protection: { source: string | null }
  schedulerFiring: boolean
  serviceMode: boolean
  bootId: string
}

function freshWorld(): World {
  return {
    session: {
      pid: PID, state: 'running', exitCode: null, bootId: 'boot-1',
      pgidPath: PGID_PATH, jsonlPath: JSONL_PATH,
      foldState: { turnActive: false },
    },
    pgidFile: String(PID) + '\n',
    jsonlMtimeMs: Date.now() - 30 * 60 * 1000,   // 30 min of silence: an idle CLI
    journaled: new Set([SID]),
    journalHomes: new Map([[SID, HOME]]),
    protection: { source: null },
    schedulerFiring: false,
    serviceMode: false,
    bootId: 'boot-1',
  }
}

function buildDaemon(world: World) {
  const replies: Reply[] = []
  const stops: string[] = []
  const disables: string[] = []
  const stopVersions = new Map<string, number>()
  const sessions = new Map<string, Record<string, unknown>>()
  if (world.session) sessions.set(SID, world.session)
  // orphanStopRefusal's first look at daemon state is `sessions.get(sid)`, and
  // stopSessionProcess is stubbed: a get means the ownership check has started.
  const ownershipChecks: string[] = []
  const registryGet = sessions.get.bind(sessions)
  sessions.get = (sid: string) => { ownershipChecks.push(sid); return registryGet(sid) }
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const injected: Record<string, unknown> = {
    sessions,
    SERVICE_MODE: world.serviceMode,
    // The runtime's late values, asked on use (daemon-session-stop.ts takes getters).
    daemonBootId: () => world.bootId,
    fs: {
      readFileSync: (p: string) => {
        if (p === PGID_PATH && world.pgidFile !== null) return world.pgidFile
        throw enoent()
      },
      statSync: (p: string) => {
        if (p === JSONL_PATH && world.jsonlMtimeMs !== null) return { mtimeMs: world.jsonlMtimeMs }
        throw enoent()
      },
    },
    journaledIds: () => world.journaled,
    journaledHome: (sid: string) => world.journalHomes.get(sid),
    // No Walnut server runs here, so no data dir maps to a leader (host-server-core.ts walnutOf): a
    // home is its own Walnut and the replica stop fence never applies. Cases for those live in
    // tests/providers/host-server-own-session-owner-twins.test.ts, against real daemons.
    walnutOfHome: (home: string) => home,
    servedStopRefusal: () => null,
    SESSION_IDLE_WARNING_MS: () => IDLE_WARNING_MS,
    SESSION_IDLE_KILL_MS: () => IDLE_KILL_MS,
    deriveSessionProtection: () => ({ source: world.protection.source, killMs: IDLE_KILL_MS }),
    hasRecentSchedulerFiring: () => world.schedulerFiring,
    sessionStopVersions: stopVersions,
    cronRuntime: () => ({ get: () => null, disable: async (sid: string) => { disables.push(sid) } }),
    stopSessionProcess: async (_ws: unknown, id: number, sid: string) => {
      stops.push(sid)
      replies.push({ id, ok: true, data: { stopped: true } })
    },
    logMsg: () => {},
    sendOk: (_ws: unknown, id: number, data: Record<string, unknown>) => { replies.push({ id, ok: true, data }) },
    sendError: (_ws: unknown, id: number, error: string) => { replies.push({ id, ok: false, error }) },
  }
  const src = daemonRuntimeText()
  const code = ['cmdStop', 'orphanStopRefusal', 'stopOwnerRefusal'].map((n) => sliceTopLevelFn(src, n)).join('\n')
  const js = ts.transpileModule(code + '\nreturn { cmdStop, orphanStopRefusal, stopOwnerRefusal, sessionStartGate };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const names = Object.keys(injected)
  const values = names.map((n) => injected[n])
  // The per-session gate the daemon really uses (DaemonSessionGate), injected.
  const built = new Function(...names, 'sessionStartGate', js)(...values, new DaemonSessionGate())
  const stop = (cmd: Record<string, unknown>) => built.cmdStop({}, 1, { sid: SID, home: HOME, ...cmd }) as Promise<unknown>
  const gateRun = built.sessionStartGate.run.bind(built.sessionStartGate) as (sid: string, work: () => Promise<unknown>) => Promise<unknown>
  return { stop, replies, stops, disables, stopVersions, ownershipChecks, gateRun }
}

describe('stop reason "orphan"', () => {
  let world: World
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    world = freshWorld()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('the orphan harness must never reach process.kill')
    }) as typeof process.kill)
  })

  afterEach(() => {
    expect(killSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  async function refusal(): Promise<Record<string, unknown>> {
    const daemon = buildDaemon(world)
    await daemon.stop({ reason: 'orphan', expectPid: PID })
    expect(daemon.stops, 'a refused orphan stop must not reach stopSessionProcess').toEqual([])
    expect(daemon.stopVersions.size).toBe(0)
    expect(daemon.replies).toHaveLength(1)
    expect(daemon.replies[0].ok).toBe(true)
    return daemon.replies[0].data!
  }

  it('ends a session it owns once every proof holds and nothing keeps it alive', async () => {
    const daemon = buildDaemon(world)
    await daemon.stop({ reason: 'orphan', expectPid: PID })
    expect(daemon.stops).toEqual([SID])
    expect(daemon.replies).toEqual([{ id: 1, ok: true, data: { stopped: true } }])
    expect(daemon.stopVersions.get(SID)).toBe(1)
    expect(daemon.disables, 'an orphan stop never touches cron supervision').toEqual([])
  })

  it('a sid this daemon never spawned is not_owned (the ephemeral-server incident)', async () => {
    world.session = null
    expect(await refusal()).toEqual({ stopped: false, reason: 'not_owned', detail: 'not_in_registry' })
  })

  it('a pid other than the one this daemon holds for the sid is not_owned', async () => {
    world.session!.pid = PID + 1
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'pid_mismatch' })
  })

  it.each([
    ['missing', null],
    ['naming another group', String(PID + 3)],
    ['unreadable garbage', 'not-a-pid'],
  ])('a .pgid file %s is not_owned', async (_label, pgid) => {
    world.pgidFile = pgid
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'pgid_mismatch' })
  })

  it('a sid absent from the spawn journal is not_owned', async () => {
    world.journaled = new Set()
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'not_journaled' })
  })

  it('a session this daemon spawned for ANOTHER Walnut is not_owned (a shared remote daemon)', async () => {
    world.journalHomes.set(SID, '/another/walnut-home')
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'other_walnut' })
  })

  it('a journal line that names no Walnut (a backfilled record) is not_owned', async () => {
    world.journalHomes.clear()
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'no_journaled_walnut' })
  })

  it.each([[undefined], [''], [42]])('home %s is a bad request and ends nothing', async (home) => {
    const daemon = buildDaemon(world)
    await daemon.stop({ reason: 'orphan', expectPid: PID, home })
    expect(daemon.stops).toEqual([])
    expect(daemon.replies[0].data).toMatchObject({ stopped: false, reason: 'bad_request' })
  })

  it('a service daemon does not claim a process from a previous boot', async () => {
    world.serviceMode = true
    world.bootId = 'boot-2'
    expect(await refusal()).toMatchObject({ reason: 'not_owned', detail: 'previous_boot' })
  })

  it('a session that already died is not_running', async () => {
    world.session!.state = 'dead'
    world.session!.exitCode = 0
    expect(await refusal()).toMatchObject({ reason: 'not_running' })
  })

  it('output in the last five minutes refuses (the owner reads its own stream file)', async () => {
    world.jsonlMtimeMs = Date.now() - 60 * 1000
    expect(await refusal()).toMatchObject({ reason: 'recent_output' })
  })

  it('no stream file to judge activity by refuses', async () => {
    world.jsonlMtimeMs = null
    expect(await refusal()).toMatchObject({ reason: 'protected', detail: 'no-stream-file' })
  })

  it('a turn in flight refuses', async () => {
    world.session!.foldState = { turnActive: true }
    expect(await refusal()).toMatchObject({ reason: 'protected', detail: 'turn-active' })
  })

  it.each([['cron'], ['team'], ['bg-task'], ['turn-retry']])('the idle scanner protection %s refuses', async (source) => {
    world.protection.source = source
    expect(await refusal()).toMatchObject({ reason: 'protected', detail: source })
  })

  it('a recent scheduler firing in the CLI debug log refuses', async () => {
    world.schedulerFiring = true
    expect(await refusal()).toMatchObject({ reason: 'protected', detail: 'cron-debug-log' })
  })

  it.each([[undefined], [1], [0], [-1], [-PID], [1.5], [String(PID)]])('expectPid %s is a bad request and ends nothing', async (expectPid) => {
    const daemon = buildDaemon(world)
    await daemon.stop({ reason: 'orphan', expectPid })
    expect(daemon.stops).toEqual([])
    expect(daemon.replies[0].data).toMatchObject({ stopped: false, reason: 'bad_request' })
  })

  it('the other reasons are untouched: an unknown reason is still refused outright', async () => {
    const daemon = buildDaemon(world)
    await daemon.stop({ reason: 'bogus', expectPid: PID })
    expect(daemon.replies).toEqual([{ id: 1, ok: false, error: 'stop: invalid reason' }])
    expect(daemon.stops).toEqual([])
  })
})

/**
 * The orphan decision runs under the per-session gate that starts and resumes
 * hold. Without it, the ownership proof could read the registry halfway through
 * a respawn of the same sid and end the process that respawn just handed over.
 */
describe('an orphan stop waits for the per-session gate', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('the orphan harness must never reach process.kill')
    }) as typeof process.kill)
  })

  afterEach(() => {
    expect(killSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  /** Hold the sid's gate, as a queued start or resume does, until `release()`. */
  function holdGate(daemon: ReturnType<typeof buildDaemon>, sid: string) {
    let release!: () => void
    const held = daemon.gateRun(sid, () => new Promise<void>((resolve) => { release = resolve }))
    return { held, release: () => release() }
  }

  /** Several macrotask turns: anything not parked behind the gate has run by now. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('checks nothing and stops nothing while the gate is held, then ends the session once it is released', async () => {
    const daemon = buildDaemon(freshWorld())
    const gate = holdGate(daemon, SID)
    const stopping = daemon.stop({ reason: 'orphan', expectPid: PID })
    await drain()
    expect(daemon.ownershipChecks, 'orphanStopRefusal must not run inside the held gate').toEqual([])
    expect(daemon.stops, 'stopSessionProcess must not run inside the held gate').toEqual([])
    expect(daemon.replies).toEqual([])
    gate.release()
    await gate.held
    await stopping
    expect(daemon.ownershipChecks).toEqual([SID])
    expect(daemon.stops).toEqual([SID])
    expect(daemon.replies).toEqual([{ id: 1, ok: true, data: { stopped: true } }])
  })

  it('decides on the registry as the gate holder left it: a respawn to a new pid is not_owned', async () => {
    const world = freshWorld()
    const daemon = buildDaemon(world)
    const gate = holdGate(daemon, SID)
    const stopping = daemon.stop({ reason: 'orphan', expectPid: PID })
    await drain()
    // The queued start respawned the session: the registry now holds a new process.
    world.session!.pid = PID + 1
    world.pgidFile = String(PID + 1) + '\n'
    gate.release()
    await gate.held
    await stopping
    expect(daemon.stops, 'the process the respawn handed over must not be ended').toEqual([])
    expect(daemon.replies).toEqual([{ id: 1, ok: true, data: { stopped: false, reason: 'not_owned', detail: 'pid_mismatch' } }])
  })

  it('a gate held for a different sid does not delay the stop', async () => {
    const daemon = buildDaemon(freshWorld())
    const other = holdGate(daemon, '99999999-2222-4333-8444-555555555555')
    await daemon.stop({ reason: 'orphan', expectPid: PID })
    expect(daemon.stops).toEqual([SID])
    other.release()
    await other.held
  })
})

/**
 * owner-home-v1: every stop a server decided on (user, maintenance, idle) names
 * the asking Walnut, and the spawn journal's first line for the sid decides who
 * may stop it. A refusal changes nothing: no supervision disabled, no start
 * fenced, no process touched.
 */
describe('stop names the asking Walnut (owner-home-v1)', () => {
  const DECIDED = ['user', 'maintenance', 'idle'] as const
  const INITIATORS = ['human', 'automatic'] as const
  let world: World
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    world = freshWorld()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('the owner-home harness must never reach process.kill')
    }) as typeof process.kill)
  })

  afterEach(() => {
    expect(killSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  async function outcome(cmd: Record<string, unknown>) {
    const daemon = buildDaemon(world)
    await daemon.stop(cmd)
    expect(daemon.replies).toHaveLength(1)
    return daemon
  }

  async function expectRefused(cmd: Record<string, unknown>, detail: string) {
    const daemon = await outcome(cmd)
    expect(daemon.replies[0]).toEqual({ id: 1, ok: true, data: { stopped: false, reason: 'not_owned', detail } })
    expect(daemon.stops, 'a refused stop must not reach stopSessionProcess').toEqual([])
    expect(daemon.disables, 'a refused stop must not disable cron supervision').toEqual([])
    expect(daemon.stopVersions.size, 'a refused stop must not fence a start').toBe(0)
  }

  async function expectStopped(cmd: Record<string, unknown>) {
    const daemon = await outcome(cmd)
    expect(daemon.stops).toEqual([SID])
    expect(daemon.replies[0]).toEqual({ id: 1, ok: true, data: { stopped: true } })
  }

  const every = DECIDED.flatMap((reason) => INITIATORS.flatMap((initiator) =>
    [false, true].map((strict) => ({ reason, initiator, strict }))))

  it.each(every)('the journaled Walnut may stop its session: $reason / $initiator / strict $strict', async (cmd) => {
    await expectStopped({ ...cmd, home: HOME })
  })

  it.each(every)('another Walnut is refused for every stop: $reason / $initiator / strict $strict', async (cmd) => {
    await expectRefused({ ...cmd, home: '/another/walnut-home' }, 'other_walnut')
  })

  it('another Walnut is refused even when it sends no initiator', async () => {
    for (const reason of DECIDED) await expectRefused({ reason, home: '/another/walnut-home' }, 'other_walnut')
  })

  describe('a journal line that names no Walnut (a backfilled session)', () => {
    beforeEach(() => { world.journalHomes.clear() })

    it.each(DECIDED.flatMap((reason) => INITIATORS.map((initiator) => ({ reason, initiator }))))(
      'the production server keeps today\'s behaviour: $reason / $initiator stops',
      async (cmd) => { await expectStopped(cmd) },
    )

    it.each(DECIDED.flatMap((reason) => INITIATORS.map((initiator) => ({ reason, initiator }))))(
      'an ephemeral server (strict) is refused: $reason / $initiator',
      async (cmd) => { await expectRefused({ ...cmd, strict: true }, 'no_journaled_walnut') },
    )
  })

  describe('a session with no journal line at all', () => {
    beforeEach(() => { world.journaled = new Set(); world.journalHomes.clear() })

    it.each(DECIDED)('an automatic %s stop is refused', async (reason) => {
      await expectRefused({ reason, initiator: 'automatic' }, 'not_journaled')
    })

    it.each(DECIDED)('a person\'s %s stop is allowed (a legacy session)', async (reason) => {
      await expectStopped({ reason, initiator: 'human' })
    })

    it('with no initiator, only reason user counts as a person', async () => {
      await expectStopped({ reason: 'user' })
      await expectRefused({ reason: 'idle' }, 'not_journaled')
      await expectRefused({ reason: 'maintenance' }, 'not_journaled')
    })

    it.each(INITIATORS)('an ephemeral server (strict) is refused even for a %s stop', async (initiator) => {
      await expectRefused({ reason: 'user', initiator, strict: true }, 'not_journaled')
    })
  })

  it('a request with no home comes from an older server and keeps today\'s behaviour', async () => {
    world.journaled = new Set()
    world.journalHomes.clear()
    for (const reason of DECIDED) await expectStopped({ reason, home: undefined, initiator: 'automatic' })
  })

  it.each([[''], [42], [null]])('home %s is a bad request and stops nothing', async (home) => {
    const daemon = await outcome({ reason: 'user', home, initiator: 'human' })
    expect(daemon.replies[0].data).toMatchObject({ stopped: false, reason: 'bad_request' })
    expect(daemon.stops).toEqual([])
    expect(daemon.disables).toEqual([])
  })

  it('an orphan stop keeps its own, stricter proof (a matching home alone is not enough)', async () => {
    world.pgidFile = null
    const daemon = await outcome({ reason: 'orphan', expectPid: PID })
    expect(daemon.replies[0].data).toMatchObject({ stopped: false, reason: 'not_owned', detail: 'pgid_mismatch' })
  })
})
