/**
 * Which claude-code routines a host may start itself while the Mac is away, and
 * what the clock def tells it (clock-host-start-v1: src/core/routines/clock-placement.ts
 * routineStartOf and placeClocksForHost).
 *
 * Why: the host starts a real CLI from these fields with nobody watching, so the def
 * carries a `start` only when the host can do exactly what this Mac's executor would
 * (executors/claude-code.ts, quickStartSession), and only for a daemon that said it
 * can and holds the routine template. Everything else is today's behaviour: the run
 * waits on the host for the Mac. A real config and cron store on a temp home.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-clock-host-start-placement'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import * as ops from '../../../src/core/cron/ops.js'
import { placeClocks, revertClocks, settleClocks } from '../../../src/core/cron/clock-handover.js'
import { _resetClockPlacementForTest, placeClocksForHost, routineStartOf, type ClockService, type PlacementDeps } from '../../../src/core/routines/clock-placement.js'
import { START_TASK_TOKEN, type ClockStartSpec } from '../../../src/providers/trigger-clock-core.js'
import { validateTriggerDef } from '../../../src/providers/trigger-check-core.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const HOST = 'marina'
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)

const job = (config: Record<string, unknown>, over: Partial<CronJob> = {}): CronJob => ({
  id: 'job-1', name: 'Nightly report', enabled: true, wakeMode: 'now', createdAtMs: BASE, updatedAtMs: BASE,
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'claude-code', config: { cwd: '/srv/repo', host: HOST, instructions: 'Write the nightly report', ...config } },
  state: {}, ...over,
} as unknown as CronJob)

describe('routineStartOf: the run the Mac would start, or none', () => {
  beforeAll(async () => {
    await updateConfig({ hosts: { [HOST]: { hostname: 'marina.example.test' }, other: { hostname: 'other.example.test' } } } as never)
  })
  afterEach(async () => {
    // updateConfig skips an undefined key: each section goes back to an explicit empty one.
    await updateConfig({ defaults: {}, session_server: { enabled: false }, agent: {} } as never)
  })

  it('fills every field as the executor would: the instructions, the folder, the title and project defaults, the mode, the context', async () => {
    const spec = await routineStartOf(job({ model: 'opus' }), HOST)
    expect(spec).toMatchObject({
      home: WALNUT_HOME, host: HOST, title: 'Routine: Nightly report', project: 'Routines', cwd: '/srv/repo',
      message: 'Write the nightly report', mode: 'bypass', model: 'opus',
    })
    expect(spec!.effort).toBeUndefined()
    // The context this Mac appends, for the task the host will make: its id is the token.
    expect(spec!.context).toContain(`You are working on the task "Routine: Nightly report" (id ${START_TASK_TOKEN}, project "Routines")`)
    // It rides a def the daemon reads as it is.
    const def = validateTriggerDef({ id: 'job-1', name: 'n', clock: { schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, fromMs: BASE }, start: spec })
    expect(def.ok && def.def.start).toEqual(spec)
  })

  it('the routine\'s own title and project, and the configured session effort', async () => {
    await updateConfig({ agent: { session_effort: 'high' } } as never)
    const spec = await routineStartOf(job({ taskTitle: 'Digest of the week', project: 'Reports' }), HOST)
    expect(spec).toMatchObject({ title: 'Digest of the week', project: 'Reports', effort: 'high' })
    expect(spec!.context).toContain('(id __WALNUT_ROUTINE_TASK_ID__, project "Reports")')
  })

  it('none for a routine the host cannot run as the Mac would', async () => {
    const cases: Array<[string, CronJob]> = [
      ['a console agent', job({ walnutAgent: true })],
      ['an agent id', job({ agentId: 'mentor' })],
      ['a title template', job({ titleTemplate: 'Triage {time}' })],
      ['another host', job({ host: 'other' })],
      ['the Mac itself', job({ host: undefined })],
      ['a relative folder', job({ cwd: 'repo' })],
      ['instructions the Mac spills to a file', job({ instructions: 'x'.repeat(25_001) })],
      ['a task pill the Mac adds a card for', job({ instructions: 'see <task-ref id="abc123" />' })],
      ['a batch count hint', job({ instructions: 'WALNUT_TRIAGE_COUNT: 3\nGo' })],
      ['a model value the daemon would refuse', job({ model: 'opus; rm -rf /' })],
      ['not a claude-code routine', job({}, { executor: { type: 'session', config: { target: 't', prompt: 'p' } } } as never)],
    ]
    for (const [why, j] of cases) expect(await routineStartOf(j, HOST), why).toBeNull()
    // A host the config does not name.
    expect(await routineStartOf(job({ host: 'ghost' }), 'ghost')).toBeNull()
  })

  it('none when the Mac would run it on another engine or through the SDK session server', async () => {
    await updateConfig({ defaults: { engine: 'codex' } } as never)
    // An ACP default is dropped for a remote launch, so Claude Code still runs it.
    const codex = await routineStartOf(job({}), HOST)
    await updateConfig({ defaults: {}, session_server: { enabled: true } } as never)
    expect(await routineStartOf(job({}), HOST)).toBeNull()
    // Whatever the engine registry says of codex on a remote host, the start says the same.
    const { normalizeEngine } = await import('../../../src/core/agents/engine-registry.js')
    const { resolveDefaultEngine } = await import('../../../src/core/agents/default-engine.js')
    const remote = normalizeEngine(resolveDefaultEngine({ defaults: { engine: 'codex' } } as never, { host: HOST }))
    expect(codex === null).toBe(remote !== undefined)
  })
})

describe('placeClocksForHost: the start rides the def only for a daemon that can take it', () => {
  let dir: string
  let counter = 0
  const spec: ClockStartSpec = { home: WALNUT_HOME, host: HOST, title: 'Routine: Build', project: 'Routines', cwd: '/srv/repo', message: 'Build it', mode: 'bypass' }
  let asked: string[]

  function makeState(): CronServiceState {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
    return {
      deps: {
        nowMs: () => BASE + 1_000, log, storePath: path.join(dir, `cron-${++counter}.json`), cronEnabled: false,
        broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(), onEvent: vi.fn(),
      },
      store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
    }
  }
  const serviceOf = (state: CronServiceState): ClockService => ({
    placeClocks: (host, opts) => placeClocks(state, host, opts),
    settleClocks: (host, reply) => settleClocks(state, host, reply),
    revertClocks: (host, handed) => revertClocks(state, host, handed),
  })
  const deps = (start: ClockStartSpec | null = spec): PlacementDeps => ({
    hosts: async () => new Set([HOST]),
    getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }),
    sessionsForTask: async () => [{ process_status: 'idle', host: HOST }],
    routineStart: async (j) => { asked.push(j.id); return start },
  })
  const routine = (over: Partial<CronJobCreate> = {}): CronJobCreate => ({
    name: 'Build', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    executor: { type: 'claude-code', config: { cwd: '/srv/repo', host: HOST, instructions: 'Build it' } }, ...over,
  })

  beforeEach(async () => {
    dir = path.join(WALNUT_HOME, 'placement')
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    asked = []
    _resetClockPlacementForTest()
  })

  it('a claude-code def carries the start; a session routine\'s def delivers and is never asked', async () => {
    const state = makeState()
    const code = await ops.add(state, routine())
    const session = await ops.add(state, routine({ name: 'Review', executor: { type: 'session', config: { target: 'task-remote', prompt: 'Review', instructions: 'Review' } } }))
    const placed = await placeClocksForHost(serviceOf(state), HOST, await ops.list(state, { includeDisabled: true, recompute: false }), 'yes', deps(), { hostStart: true })
    const defs = new Map(placed.defs.map((d) => [d.id, d]))
    expect(defs.get(code.id)?.start).toEqual(spec)
    expect(defs.get(session.id)?.start).toBeUndefined()
    expect(defs.get(session.id)?.deliver).toBeDefined()
    expect(asked).toEqual([code.id])
  })

  it('no start without hostStart (an older daemon, no routine template yet), or for an ineligible routine', async () => {
    const state = makeState()
    const code = await ops.add(state, routine())
    const jobs = async () => await ops.list(state, { includeDisabled: true, recompute: false })
    const plain = await placeClocksForHost(serviceOf(state), HOST, await jobs(), 'yes', deps())
    expect(plain.defs.find((d) => d.id === code.id)).toBeDefined()
    expect(plain.defs.find((d) => d.id === code.id)?.start).toBeUndefined()
    expect(asked).toEqual([])
    const none = await placeClocksForHost(serviceOf(state), HOST, await jobs(), 'yes', deps(null), { hostStart: true })
    expect(none.defs.find((d) => d.id === code.id)?.start).toBeUndefined()
    // A daemon without clocks gets no def at all, start or not.
    const old = await placeClocksForHost(serviceOf(state), HOST, await jobs(), 'no', deps(), { hostStart: true })
    expect(old.defs).toEqual([])
  })
})
