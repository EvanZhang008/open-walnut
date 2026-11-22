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
import { onTimer, stopTimer } from '../../../src/core/cron/timer.js'
import { missedRuns } from '../../../src/core/cron/run-log.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'
import { notifyOutwardDoorsOpened, setOutwardDoorChecker } from '../../../src/core/leader/switch/doors.js'

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
    // timer.ts: executeJob, and settleSentRuns, which records a run executeJob made whose process
    // stopped after its work went out (sent-run.ts): the same run, never a second one.
    expect(callSites('applyJobResult')).toEqual({ 'core/cron/timer.ts': 2, 'core/cron/trigger-apply.ts': 2 })
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
  setOutwardDoorChecker(null)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

/**
 * The write permission (switchable_leader): `refuse(n)` makes the door refuse from its n-th
 * check on (0: every check), `allow()` lets every check through. Returns the checks asked.
 */
function permit(): { refuse: (from?: number) => void; allow: () => void; asked: string[] } {
  const asked: string[] = []
  let from = Infinity
  setOutwardDoorChecker((kind, opId) => {
    asked.push(`${kind} ${opId}`)
    if (asked.length > from) {
      throw Object.assign(new Error('this machine does not hold the write permission'), { name: 'PermitNotHeld' })
    }
  }, () => !Number.isFinite(from))
  return { refuse: (n = 0) => { from = asked.length + n }, allow: () => { from = Infinity }, asked }
}

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

describe.each(ENTRIES)('$name, on a machine without the write permission', ({ drive }) => {
  it('takes no slot and leaves it due; once the permission arrives, ONE run stands for it', async () => {
    const { storePath, id } = await routineDueSince()
    const doors = permit()
    doors.refuse()
    const at = D1 + 3 * HOUR
    const state = await drive(storePath, id, at)
    expect(executed).toEqual([])
    const held = await stored(state, id)
    expect(held.state.nextRunAtMs).toBe(D1)
    expect(held.state.runningAtMs).toBeUndefined()
    expect(held.state.runLog ?? []).toEqual([])

    doors.allow()
    const later = D1 + 5 * HOUR
    const after = await drive(storePath, id, later)
    expect(executed).toEqual([later])
    const ran = await stored(after, id)
    expect(ran.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 })
    expect(missedRuns(ran, later + HOUR)).toEqual([])

    // The slot is done: it never runs a second time.
    await drive(storePath, id, D1 + 6 * HOUR)
    expect(executed).toEqual([later])
  })
})

describe('the door at a Run and at the one entry', () => {
  it("a due Run without the permission answers 'not-permitted' before it marks the slot running", async () => {
    const { storePath, id } = await routineDueSince()
    permit().refuse()
    now.value = D1 + HOUR
    const state = makeState(storePath)
    await expect(ops.run(state, id, 'due')).resolves.toEqual({ ok: true, ran: false, reason: 'not-permitted' })
    const j = await stored(state, id)
    expect(j.state.runningAtMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(D1)
    expect(executed).toEqual([])
  })

  it('a permission lost between the Run and the entry releases the running marker and keeps the slot due', async () => {
    const { storePath, id } = await routineDueSince()
    const doors = permit()
    // run() asks first and passes; executeJob asks next and is refused.
    doors.refuse(1)
    now.value = D1 + HOUR
    const state = makeState(storePath)
    // Not reported as a run: nothing ran.
    await expect(ops.run(state, id, 'due')).resolves.toEqual({ ok: true, ran: false, reason: 'not-permitted' })
    expect(doors.asked).toEqual([`cron-fire ${id}:${D1}`, `cron-fire ${id}:${D1}`])
    expect(executed).toEqual([])
    const j = await stored(state, id)
    expect(j.state.runningAtMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(D1)
    expect(j.state.runLog ?? []).toEqual([])
  })
})

describe('the timer of a machine without the write permission', () => {
  it('polls once a minute and ticks the moment the permission arrives: the due slot runs once', async () => {
    const { storePath, id } = await routineDueSince()
    const doors = permit()
    doors.refuse()
    now.value = D1 + HOUR
    const state = makeState(storePath, true)
    await onTimer(state)
    expect(executed).toEqual([])
    // Held back: a minute's poll, never a 0 ms loop over the due slot.
    expect(state.timer).not.toBeNull()

    doors.allow()
    notifyOutwardDoorsOpened()
    for (let i = 0; i < 100 && executed.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(executed).toEqual([D1 + HOUR])
    for (let i = 0; i < 100 && state.running; i++) await new Promise((r) => setTimeout(r, 10))
    const ran = await stored(state, id)
    expect(ran.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 })
    stopTimer(state)
  })

  it('a timer stopped while it waits for the permission is not armed again by the opening', async () => {
    const { storePath } = await routineDueSince()
    const doors = permit()
    doors.refuse()
    now.value = D1 + HOUR
    const state = makeState(storePath, true)
    await onTimer(state)
    stopTimer(state)
    doors.allow()
    notifyOutwardDoorsOpened()
    await new Promise((r) => setTimeout(r, 30))
    expect(state.timer).toBeNull()
    expect(executed).toEqual([])
  })
})
