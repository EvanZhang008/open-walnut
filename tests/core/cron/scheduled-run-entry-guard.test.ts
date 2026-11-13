/**
 * Guard: every path that runs a routine's due slot on the server's clock goes through ONE entry
 * (src/core/cron/timer.ts executeJob), which alone decides the slots the run stands for
 * (run-log.ts runSlots). That entry is what keeps a slot from being skipped behind a run that has
 * not started (2026-11-12, Inbox Triage) and a downtime slot from being called missed (2026-11-12,
 * the downtime report). A new scheduler path that runs an executor or records a run some other way
 * would bring both bugs back, so:
 *  - the source may call the dispatch core, the slot rule and the run recorder only from that
 *    entry (counted per file; a new call site fails here until it is reviewed and listed);
 *  - each scheduler entry that exists (the tick, the boot catch-up, a due Run) is driven through
 *    the same two scenarios, a downtime and a held run, and must merge, not skip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { onTimer } from '../../../src/core/cron/timer.js'
import { missedRuns } from '../../../src/core/cron/run-log.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/** Call sites of `name(` per file (relative to src/), its own definition not counted. */
function callSites(name: string): Record<string, number> {
  const call = new RegExp(`(?<![\\w.$])${name}\\(`, 'g')
  const def = new RegExp(`function\\s+${name}\\(`, 'g')
  const out: Record<string, number> = {}
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, 'utf-8').replace(/^\s*(\/\/|\*).*$/gm, '')
    const n = (text.match(call)?.length ?? 0) - (text.match(def)?.length ?? 0)
    if (n > 0) out[path.relative(SRC, file)] = n
  }
  return out
}

describe('one entry for every scheduled run (source)', () => {
  it('the dispatch core runs only from executeJob', () => {
    expect(callSites('executeJobCore')).toEqual({ 'core/cron/timer.ts': 1 })
  })

  it('the slot rule is read only by executeJob', () => {
    expect(callSites('runSlots')).toEqual({ 'core/cron/timer.ts': 1 })
  })

  it('executeJob is called by the tick, the boot catch-up and Run, and nothing else', () => {
    // timer.ts: onTimer. ops.ts: start (boot catch-up) and run (Run now / a due run).
    // A new caller: add it to the entry table below so it is driven through both scenarios.
    expect(callSites('executeJob')).toEqual({ 'core/cron/timer.ts': 1, 'core/cron/ops.ts': 2 })
  })

  it('a run is recorded only by the timer (executeJob) and by a host clock’s report (clock-fire)', () => {
    expect(callSites('runEntry')).toEqual({ 'core/cron/timer.ts': 1, 'core/cron/clock-fire.ts': 1 })
    // trigger-apply.ts records a check's run: a trigger stands for no slot (it has no run log).
    expect(callSites('applyJobResult')).toEqual({ 'core/cron/timer.ts': 1, 'core/cron/trigger-apply.ts': 2 })
  })

  it('the wiring carries the held signal and a catch-up’s slot from the action and to the executor', () => {
    const server = fs.readFileSync(path.join(SRC, 'web/server.ts'), 'utf-8')
    expect(server).toMatch(/if \(ar\.status === 'skipped'\) return \{[^}]*heldBy: ar\.heldBy/)
    expect(server).toMatch(/runExecutor: async \(job, executor, message, ctx\) => \{[\s\S]{0,200}runExecutor\(job, executor, message, ctx\)/)
    const triage = fs.readFileSync(path.join(SRC, 'actions/inbox-triage-batch.ts'), 'utf-8')
    expect(triage).toMatch(/heldBy: held\.waiting/)
  })
})

// ── Every entry, the same two scenarios ──

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const BASE = Date.UTC(2026, 10, 12, 16, 0, 0)
const D1 = Date.UTC(2026, 10, 13, 8, 0, 0)

let now: { value: number }
let counter = 0
let holding = false
let executed: number[] = []

function makeState(storePath: string, cronEnabled = false): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath, cronEnabled,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }),
      runAction: vi.fn(async () => holding
        ? { status: 'skipped' as const, summary: 'earlier run not started', heldBy: 't-wait' }
        : { status: 'ok' as const, summary: 'BATCH' }),
      runExecutor: vi.fn(async () => { executed.push(now.value); return { status: 'ok' as const, summary: 'started' } }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const daily: CronJobCreate = {
  name: 'reflection', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
  initProcessor: { actionId: 'batch' },
  executor: { type: 'claude-code', config: { instructions: 'Reflect.', cwd: '/tmp/x' } },
}

type Entry = { name: string; drive: (storePath: string, id: string, at: number) => Promise<CronServiceState> }

/** Each scheduler entry that runs a due slot, as a fresh server process would take it. */
const ENTRIES: Entry[] = [
  { name: 'timer tick (onTimer)', drive: async (storePath, _id, at) => {
    now.value = at
    const s = makeState(storePath)
    await onTimer(s)
    return s
  } },
  { name: 'boot catch-up (start)', drive: async (storePath, _id, at) => {
    now.value = at
    const s = makeState(storePath, true)
    await ops.start(s)
    ops.stop(s)
    return s
  } },
  { name: 'a due Run (run due)', drive: async (storePath, id, at) => {
    now.value = at
    const s = makeState(storePath)
    await ops.run(s, id, 'due')
    return s
  } },
]

async function stored(state: CronServiceState, id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true, recompute: false })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

async function routineDueSince(): Promise<{ storePath: string; id: string }> {
  const storePath = path.join(WALNUT_HOME, `guard-${++counter}`, 'cron-jobs.json')
  await fsp.mkdir(path.dirname(storePath), { recursive: true })
  now.value = BASE
  const job = await ops.add(makeState(storePath), daily)
  return { storePath, id: job.id }
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  now = { value: BASE }
  holding = false
  executed = []
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe.each(ENTRIES)('$name', ({ drive }) => {
  it('after three slots nobody ran, makes ONE run that stands for all of them; none is missed', async () => {
    const { storePath, id } = await routineDueSince()
    const at = D1 + 2 * DAY + 3 * HOUR
    const state = await drive(storePath, id, at)
    expect(executed).toEqual([at])
    const j = await stored(state, id)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 + 2 * DAY, firstSlotMs: D1 })
    expect(missedRuns(j, at + HOUR)).toEqual([])
  })

  it('a run held behind one that has not started keeps its slots owed and looks again soon', async () => {
    const { storePath, id } = await routineDueSince()
    holding = true
    const at = D1 + DAY + 3 * HOUR
    const state = await drive(storePath, id, at)
    expect(executed).toEqual([])
    const j = await stored(state, id)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'skipped', heldBy: 't-wait', slotMs: D1 + DAY, firstSlotMs: D1 })
    expect(j.state.owedFromMs).toBe(D1)
    expect(j.state.nextRunAtMs).toBeLessThan(D1 + 2 * DAY)
    expect(missedRuns(j, at + 2 * HOUR)).toEqual([])
  })
})
