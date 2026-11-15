/**
 * The armed set for host aliases that reach one daemon (compileTriggersForHost `sameDaemon`).
 *
 * The daemon keeps one set per Walnut, so the set pushed under any alias of it is every alias's:
 * the checks of each, and the clock routines placed on each, each clock held under its own alias
 * (2026-11-15: an SSH row and a `-net` row of one machine; the net row's push of its own empty
 * set disarmed the SSH row's 78 triggers). One reply settles them all: each alias keeps exactly
 * the clocks the daemon reports, and a refused push hands back what it handed over, per alias.
 *
 * A real cron store on disk and the real handover (clock-handover.ts); the daemon's replies are
 * hand-written. Its pool side (which aliases are one daemon): tests/providers/daemon-trigger-same-daemon.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { placeClocks, revertClocks, settleClocks } from '../../../src/core/cron/clock-handover.js'
import { __setClockPlacementDepsForTesting, _resetClockPlacementForTest } from '../../../src/core/routines/clock-placement.js'
import { compileTriggersForHost } from '../../../src/core/routines/trigger-push.js'
import { setCronService } from '../../../src/web/routes/cron.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const SSH = 'studio'
const NET = 'studio-net'
const BOTH = [SSH, NET]
const T0 = Date.UTC(2026, 10, 15, 12, 0, 1)

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
}

let state: CronServiceState
let counter = 0

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => T0,
      log: mockLog(),
      storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`),
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }),
      runExecutor: vi.fn().mockResolvedValue({ status: 'ok' }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const check = (name: string, host: string): CronJobCreate => ({
  name, enabled: true, wakeMode: 'now',
  schedule: { kind: 'every', everyMs: 300_000 },
  check: { run: `./watch-${name}.sh`, host },
  executor: { type: 'session', config: { target: 'task-watch', prompt: 'Read what changed' } },
})

const clock = (name: string, executor: CronJobCreate['executor']): CronJobCreate => ({
  name, enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, executor,
})

async function stored(id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true, recompute: false })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

let ids: { sshCheck: string; netCheck: string; netClock: string; sshClock: string }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  state = makeState()
  setCronService({
    list: (o: Parameters<typeof ops.list>[1]) => ops.list(state, o),
    placeClocks: (host: string, o: Parameters<typeof placeClocks>[2]) => placeClocks(state, host, o),
    settleClocks: (host: string, reply: Parameters<typeof settleClocks>[2]) => settleClocks(state, host, reply),
    revertClocks: (host: string, handed: readonly string[]) => revertClocks(state, host, handed),
  } as never)
  // The routine's task runs its session on the net alias; nothing here is portable or started on the host.
  __setClockPlacementDepsForTesting({
    hosts: async () => new Set(BOTH),
    getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }),
    sessionsForTask: async (id) => id === 'task-net' ? [{ process_status: 'idle', host: NET }] : [],
    connected: async () => true,
    routineStart: undefined,
    portable: undefined,
    offline: undefined,
  })
  ids = {
    sshCheck: (await ops.add(state, check('ssh-watch', SSH))).id,
    netCheck: (await ops.add(state, check('net-watch', NET))).id,
    netClock: (await ops.add(state, clock('net-review', { type: 'session', config: { target: 'task-net', prompt: 'Review the queue' } }))).id,
    sshClock: (await ops.add(state, clock('ssh-build', { type: 'claude-code', config: { cwd: '/repo', host: SSH, instructions: 'Build it' } }))).id,
  }
})

afterEach(async () => {
  setCronService(null)
  __setClockPlacementDepsForTesting(null)
  _resetClockPlacementForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

const idsOf = (c: Awaited<ReturnType<typeof compileTriggersForHost>>) => (c?.payload.triggers ?? []).map((t) => t.id).sort()

describe('the set for aliases of one daemon', () => {
  it('an alias alone gets only its own checks and clocks, as before', async () => {
    const net = await compileTriggersForHost(NET, { clock: 'yes' })
    expect(idsOf(net)).toEqual([ids.netCheck, ids.netClock].sort())
    expect((await stored(ids.sshClock)).state.clockHost).toBeUndefined()
  })

  it('under either alias, the set is every alias\'s checks and clocks, each clock held by its own alias', async () => {
    const all = [ids.sshCheck, ids.netCheck, ids.netClock, ids.sshClock].sort()
    const fromNet = await compileTriggersForHost(NET, { clock: 'yes', sameDaemon: BOTH, fresh: true })
    expect(idsOf(fromNet)).toEqual(all)
    expect((await stored(ids.netClock)).state.clockHost).toBe(NET)
    expect((await stored(ids.sshClock)).state.clockHost).toBe(SSH)
    // The other alias compiles the very same set: one push never replaces the other's.
    const fromSsh = await compileTriggersForHost(SSH, { clock: 'yes', sameDaemon: BOTH })
    expect(idsOf(fromSsh)).toEqual(all)
    expect(fromSsh?.hash).toBe(fromNet?.hash)
    // One def per id, whichever alias it came from.
    expect(fromSsh?.payload.triggers.length).toBe(4)
  })

  it('the one reply settles each alias\'s clocks: kept where reported, taken back where not', async () => {
    const set = await compileTriggersForHost(NET, { clock: 'yes', sameDaemon: BOTH })
    const net = await stored(ids.netClock)
    await set!.applied!({ clocks: [{ id: ids.netClock, fromMs: net.state.clockFromMs, nextRunAtMs: net.state.nextRunAtMs }], released: [] })
    expect((await stored(ids.netClock)).state.clockHost).toBe(NET)
    // Absent from the daemon's report: that alias's clock comes back to the server.
    expect((await stored(ids.sshClock)).state.clockHost).toBeUndefined()
  })

  it('a refused push hands back what it handed over, for every alias', async () => {
    const set = await compileTriggersForHost(SSH, { clock: 'yes', sameDaemon: BOTH })
    expect((await stored(ids.netClock)).state.clockHost).toBe(NET)
    await set!.rejected!()
    expect((await stored(ids.netClock)).state.clockHost).toBeUndefined()
    expect((await stored(ids.sshClock)).state.clockHost).toBeUndefined()
  })

  it('a daemon that holds no clocks gets every alias\'s checks and no clock', async () => {
    const set = await compileTriggersForHost(NET, { clock: 'no', sameDaemon: BOTH })
    expect(idsOf(set)).toEqual([ids.sshCheck, ids.netCheck].sort())
  })
})
