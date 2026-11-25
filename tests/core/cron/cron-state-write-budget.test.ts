/**
 * cron-state.json (the machine-local runtime sidecar, about 1.1 MB on the Mac) is rewritten in full
 * by every write. A quiet trigger check changes only what it records, so the checks of a span share
 * ONE write (trigger-apply.ts persistRoutineCheck, ROUTINE_WRITE_DELAY_MS). 2026-11-25, the live
 * server: still about 5 full rewrites a minute with 216 triggers, because two more clocks wrote the
 * waiting lines early: the 30 s reread of the files (store.ts ensureLoaded) and a write timer an
 * earlier check armed, which ran a few seconds after a fire's or an edit's write.
 *
 * Guards: (1) a production-shaped quiet cycle writes the sidecar at most once per
 * ROUTINE_WRITE_DELAY_MS, and loses no check line; (2) reads, lists and reloads that change nothing
 * write nothing; (3) every call site that writes the store is enumerated, so a new writer is a
 * decision (an event write, or a routine record through persistRoutineCheck), never an accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { applyTriggerChecked, flushRoutineChecks, ROUTINE_WRITE_DELAY_MS } from '../../../src/core/cron/trigger-apply.js'
import { CRON_REREAD_MAX_MS, cronStatePath } from '../../../src/core/cron/store.js'
import type { CronServiceState } from '../../../src/core/cron/types.js'
import type { TriggerCheckedEvent } from '../../../src/providers/trigger-check-core.js'
import { _resetJsonIoForTesting, jsonIoTop } from '../../../src/core/observability/json-io.js'

const SEC = 1000
const MIN = 60 * SEC
const now = { value: Date.UTC(2026, 10, 25, 16, 0, 0) }

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, 'cron-write-budget.json'), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

async function addTriggers(state: CronServiceState, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const job = await ops.add(state, {
      name: `Watch ${i}`, enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: MIN },
      executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } },
      check: { run: 'true', host: '__local__' },
    } as any)
    ids.push(job.id)
  }
  return ids
}

const quiet = (id: string, atMs: number): TriggerCheckedEvent =>
  ({ type: 'trigger.checked', id, atMs, outcome: 'quiet', reason: 'all-seen', durationMs: 120, nextRunAtMs: atMs + MIN, consecutiveErrors: 0 }) as TriggerCheckedEvent

const writesOf = (file: string) => jsonIoTop(50).find((r) => r.file === file)?.writes ?? 0
const readsOf = (file: string) => jsonIoTop(50).find((r) => r.file === file)?.reads ?? 0

function tick(ms: number): void {
  now.value += ms
  vi.setSystemTime(now.value)
}

/**
 * The server's write timer, driven by the test clock: the real one is armed by persistRoutineCheck
 * (a real setTimeout of ROUTINE_WRITE_DELAY_MS), and runs flushRoutineChecks when it ends.
 */
function writeTimer(state: CronServiceState) {
  let seen: unknown
  let armedAt = 0
  return async () => {
    const t = state.routineWriteTimer
    if (t !== seen) { seen = t; armedAt = now.value }
    if (t && now.value - armedAt >= ROUTINE_WRITE_DELAY_MS) await flushRoutineChecks(state)
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now.value)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetJsonIoForTesting()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a quiet check cycle rewrites cron-state.json at most once per ROUTINE_WRITE_DELAY_MS', () => {
  it('checks every second, reads five times a second, one edit halfway: writes far apart, no line lost', async () => {
    const state = makeState()
    const ids = await addTriggers(state, 12)
    await flushRoutineChecks(state)
    const sidecar = cronStatePath(state.deps.storePath)
    const runTimer = writeTimer(state)
    _resetJsonIoForTesting()

    const SPAN_MS = 4 * MIN
    const EDIT_AT_MS = 95 * SEC
    const writes: Array<{ atMs: number; edit: boolean; stop?: boolean }> = []
    const lastCheck = new Map<string, number>()
    let sidecarReads = 0
    for (let t = SEC; t <= SPAN_MS; t += SEC) {
      tick(SEC)
      const id = ids[(t / SEC) % ids.length]!
      await applyTriggerChecked(state, quiet(id, now.value))
      lastCheck.set(id, now.value)
      // The page, the agents' tools, other checks: every op forces a reload of the store.
      for (let r = 0; r < 5; r++) await ops.list(state, { includeDisabled: true, recompute: r % 2 === 0 })
      await ops.status(state)
      const edit = t === EDIT_AT_MS
      // An edit is an event write: it goes at once and carries the lines waiting.
      if (edit) await ops.update(state, ids[0]!, { name: 'Watch 0, renamed' } as any)
      await runTimer()
      const w = writesOf(sidecar)
      if (w > 0) { sidecarReads += readsOf(sidecar); writes.push({ atMs: now.value, edit }); _resetJsonIoForTesting() }
    }
    sidecarReads += readsOf(sidecar)
    // A stop writes what waits at once (ops.stop), as here.
    await flushRoutineChecks(state)
    if (writesOf(sidecar) > 0) writes.push({ atMs: now.value, edit: false, stop: true })

    // Every write that carried only check lines came at least the delay after the write before it.
    const gaps = writes.map((w, i) => ({ w, gap: i === 0 ? Infinity : w.atMs - writes[i - 1]!.atMs }))
      .filter(({ w }) => !w.edit && !w.stop).map(({ gap }) => gap)
    expect(writes.some((w) => w.edit), 'the edit wrote at once').toBe(true)
    expect(gaps.every((g) => g >= ROUTINE_WRITE_DELAY_MS), `quiet writes too close: gaps ${gaps.join(', ')} ms`).toBe(true)
    expect(writes.length).toBeLessThanOrEqual(Math.ceil(SPAN_MS / ROUTINE_WRITE_DELAY_MS) + 2)
    // The reread still ran in between: at least once per reread window plus one write delay (a
    // store kept for good while checks wait, or a write that moved the read clock, fails here).
    expect(sidecarReads, 'rereads of the sidecar').toBeGreaterThanOrEqual(Math.floor(SPAN_MS / (CRON_REREAD_MAX_MS + ROUTINE_WRITE_DELAY_MS)))
    // Nothing a reader needs is lost: the file holds each trigger's latest check.
    const onDisk = JSON.parse(await fs.readFile(sidecar, 'utf-8')) as { states: Record<string, { lastCheck?: { atMs: number } }> }
    for (const [id, atMs] of lastCheck) expect(onDisk.states[id]?.lastCheck?.atMs, id).toBe(atMs)
  })

  it('reads, lists and reloads that change nothing write neither file, past many reread windows', async () => {
    const state = makeState()
    await addTriggers(state, 3)
    await flushRoutineChecks(state)
    _resetJsonIoForTesting()
    for (let t = 0; t < 3 * MIN; t += 5 * SEC) {
      tick(5 * SEC)
      await ops.list(state, { includeDisabled: true })
      await ops.list(state, { includeDisabled: true, recompute: false })
      await ops.status(state)
    }
    expect(writesOf(cronStatePath(state.deps.storePath))).toBe(0)
    expect(writesOf(state.deps.storePath)).toBe(0)
    expect(state.routineWriteTimer).toBeUndefined()
  })
})

/**
 * A boot: every host's first configure replays each trigger's latest check (daemon-trigger-set.ts
 * cmdTriggersConfigure, replayChecks), the in-process daemon's with the next run its boot re-arm
 * moved, and a remote host's after the checks it ran while no server was here. 2026-11-25, the live
 * server: each of those replays rewrote the 1.1 MB sidecar at once, 87 to 225 times in the first one
 * or two minutes after a restart. They change only the check record, so they share the routine write.
 */
describe('a boot\'s replayed checks share the routine write', () => {
  it('200 triggers reporting in after a restart write the sidecar a handful of times, the final state on disk', async () => {
    // Before the restart: every trigger's check recorded, and written by the stop.
    const old = makeState()
    const ids = await addTriggers(old, 200)
    for (const id of ids) await applyTriggerChecked(old, quiet(id, now.value))
    await ops.stop(old)
    const recordedAt = now.value

    // The new process, on the files the old one left.
    tick(20 * SEC)
    const state = makeState()
    const sidecar = cronStatePath(state.deps.storePath)
    const runTimer = writeTimer(state)
    _resetJsonIoForTesting()
    const startAt = now.value
    let writes = 0
    const want = new Map<string, { atMs: number; nextRunAtMs: number; rows: number[] }>()
    const errorId = ids[150]!
    for (const [i, id] of ids.entries()) {
      tick(200)
      if (i < 100) {
        // The in-process daemon's trigger: its latest check is recorded, its next run moved.
        const nextRunAtMs = now.value + 15 * SEC
        await applyTriggerChecked(state, { ...quiet(id, recordedAt), nextRunAtMs, replay: true })
        want.set(id, { atMs: recordedAt, nextRunAtMs, rows: [recordedAt] })
      } else {
        // A remote host's: a check kept from before the recorded one, the two it ran while the
        // server was down, then its latest check again with the next run it holds.
        const kept = [recordedAt - 30 * SEC, recordedAt + 5 * SEC, recordedAt + 15 * SEC]
        for (const atMs of kept) await applyTriggerChecked(state, { ...quiet(id, atMs), replay: true })
        const nextRunAtMs = now.value + 40 * SEC
        await applyTriggerChecked(state, { ...quiet(id, kept[2]!), nextRunAtMs, replay: true })
        want.set(id, { atMs: kept[2]!, nextRunAtMs, rows: [...kept, recordedAt] })
      }
      if (id === errorId) {
        // A live error in the middle of the burst still writes at once, its count on disk.
        tick(SEC)
        await applyTriggerChecked(state, { ...quiet(id, now.value), outcome: 'error', error: 'exit 1', reason: undefined, consecutiveErrors: 1 })
        const onDisk = JSON.parse(await fs.readFile(sidecar, 'utf-8')) as { states: Record<string, { consecutiveErrors?: number }> }
        expect(onDisk.states[id]?.consecutiveErrors, 'the error count is written at once').toBe(1)
        want.delete(id)
      }
      await runTimer()
      writes += writesOf(sidecar)
      _resetJsonIoForTesting()
    }
    const spanMs = now.value - startAt
    await ops.stop(state)
    writes += writesOf(sidecar)

    // The burst's shared writes, the error's own, and the stop's.
    expect(writes, 'sidecar writes during the boot burst').toBeLessThanOrEqual(Math.ceil(spanMs / ROUTINE_WRITE_DELAY_MS) + 2)
    // Nothing a reader needs is lost: each trigger's latest check, its next run and every row.
    const onDisk = JSON.parse(await fs.readFile(sidecar, 'utf-8')) as {
      states: Record<string, { lastCheck?: { atMs: number }; nextRunAtMs?: number; checkLog?: Array<{ atMs: number }> }>
    }
    for (const [id, w] of want) {
      const s = onDisk.states[id]
      expect(s?.lastCheck?.atMs, id).toBe(w.atMs)
      expect(s?.nextRunAtMs, id).toBe(w.nextRunAtMs)
      expect((s?.checkLog ?? []).map((e) => e.atMs).sort((a, b) => a - b), id).toEqual([...w.rows].sort((a, b) => a - b))
    }
  })
})

/**
 * Every write of the routines store goes through store.ts persist(); these are its call sites. A
 * new one (or one more in a file) fails here: decide what it records. A write that only records a
 * quiet routine check calls persistRoutineCheck (it shares the delayed write); an event a reader or
 * a restart needs at once (a fire, an error count, an edit, a run) calls persist. Then record it.
 * Files that name cron-state.json are listed too: a second writer of the file beside persist
 * (outside the host replica's copy) would bypass every guard above.
 */
describe('the writers of the routines store are enumerated', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const PERSIST_CALLS: Record<string, number> = {
    // persistRoutineCheck's flush, a check that is no routine record, persistRecord on a stopped
    // engine, and the fire paths; a quiet check, live or replayed, and a replay's history row or
    // re-armed next run wait (persistRoutineCheck).
    'src/core/cron/trigger-apply.ts': 8,
    // Adds, edits, removals, runs, boot catch-up, recomputes that changed a next run.
    'src/core/cron/ops.ts': 16,
    // A due run's marks and results, the tick's recompute when it changed something.
    'src/core/cron/timer.ts': 8,
    // A clock routine handed to a host or taken back.
    'src/core/cron/clock-handover.ts': 5,
    // ensureLoaded's migration of what an older version wrote.
    'src/core/cron/store.ts': 1,
  }
  const NAMES_THE_FILE = [
    'src/core/cron/store.ts', // cronStatePath: the one writer, persist()
    'src/core/replication/kinds/routines.ts', // reads it for the host replica's copy
    'src/core/replication/kinds/routines-follower.ts', // the copy on a host replica (no engine runs there)
    'src/core/home-manifest/home-entries.ts', // names it in the home manifest
    'src/core/leader/switch/home-path-rules.ts', // a leader switch keeps it machine-local
    'src/integrations/git-sync.ts', // never synced
  ]

  function sources(dir: string): string[] {
    const out: string[] = []
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...sources(p))
      else if (e.name.endsWith('.ts')) out.push(p)
    }
    return out
  }

  it('every persist() call site is recorded', () => {
    const found: Record<string, number> = {}
    for (const file of sources(path.join(ROOT, 'src'))) {
      const text = fsSync.readFileSync(file, 'utf-8')
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      const importsPersist = /import\s*\{[^}]*\bpersist\b[^}]*\}\s*from\s*'[./]*(?:cron\/)?store\.js'/.test(text)
      if (!importsPersist && rel !== 'src/core/cron/store.ts') continue
      const n = (text.match(/\bpersist\(state\)/g) ?? []).length
      if (n > 0) found[rel] = n
    }
    expect(found).toEqual(PERSIST_CALLS)
  })

  it('only the known files name cron-state.json', () => {
    const found = sources(path.join(ROOT, 'src'))
      .filter((f) => fsSync.readFileSync(f, 'utf-8').includes("'cron-state.json'"))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort()
    expect(found).toEqual([...NAMES_THE_FILE].sort())
  })
})
