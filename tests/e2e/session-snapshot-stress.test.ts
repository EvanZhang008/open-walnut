/**
 * BOUNDED STRESS layer for the snapshot source-of-truth feature
 * (docs/plan/session-snapshot-source-of-truth.md — C1 daemon fold + C2 walnut
 * projection).
 *
 * tests/e2e/session-snapshot-live.test.ts proves the chain is CORRECT for one
 * session at a time. This file proves it stays correct under load, and that the
 * load itself is bounded: six real CLI processes folding concurrently on ONE
 * daemon, a 2MB whale turn through the real tailer, and a measured event-loop /
 * heap budget for the test process while it happens.
 *
 * Same live stack as the behaviour suite (nothing mocked but the CLI):
 *   startServer({port:0, dev:true}) → session:start over WS RPC → SessionRunner
 *   → RemoteSessionManager → DaemonConnection → REAL daemon binary in an
 *   isolated dir → mock claude CLI → {ev:'snapshot'} push / getState pull →
 *   applySnapshot (enforce) → real projection + real tracker.
 *
 * THREE scenarios, serial, ONE server + ONE daemon + ≤6 CLI processes:
 *   1. CONCURRENCY — 6 sessions, 2 turns each (snapshot-clean-turn +
 *      armSnapshotNextTurn on one live CLI per session). Poll-assert all 6
 *      records converge to 'idle', each consumedOffset > 0, and NO CROSS-SESSION
 *      BLEED: every record's consumedOffset equals ITS OWN stream file's byte
 *      size, read straight from the daemon's streams dir. Run in ENFORCE mode on
 *      purpose — that is the mode where applySnapshot is the SOLE status writer,
 *      so the record's watermark is the snapshot's `v` and a mis-routed snapshot
 *      shows up immediately as a foreign byte offset.
 *   2. WHALE BURST — one session whose turn emits ~2MB of assistant lines, the
 *      first few written as two half-line writes with a real pause between them
 *      so the 100ms tailer poll lands INSIDE a line and must park the fragment
 *      in its carry. Assert convergence to idle and that the daemon's own
 *      getState snapshot has v === the stream file's byte size (fold consumed
 *      every byte; a dropped torn line would leave v short and turnActive true).
 *   3. EVENT-LOOP + MEMORY — lag sampled in the TEST process every 100ms across
 *      scenario 1, p99 asserted < 2000ms (generous: this box carries mandated
 *      security agents and other agent sessions); heapUsed delta after
 *      everything settles asserted < 200MB. Both numbers are REPORTED, so a
 *      regression is visible even when it stays inside the budget.
 *
 * HARD BOUNDS (law — this box has wedged on test fan-out before):
 *   - LOAD GATE in beforeAll: os.loadavg()[0] > STRESS_LOAD_CEILING skips the
 *     whole suite with an explicit message (pw-gate philosophy). A skip is an
 *     ACCEPTABLE outcome, not a failure — external load on this machine is
 *     routinely 90+, and piling six CLI processes onto that is how the Mac
 *     wedges. Override for a deliberate run: WALNUT_STRESS_LOAD_CEILING=<n>.
 *   - ONE daemon, ≤6 concurrent CLI processes, tests serial (this file assumes
 *     serial execution — run it with --no-file-parallelism).
 *   - isolated tmp WALNUT_HOME (createMockConstants) + isolated
 *     WALNUT_DAEMON_DIR asserted != /tmp/open-walnut; random server port, never
 *     3456/3457.
 *   - afterAll kills the daemon, sweeps every .pgid group, and leak-scans by
 *     tmp-path string (never a name-based pkill — that would reach production).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import {
  DAEMON_BIN,
  MOCK_CLI,
  PROD_DAEMON_DIR,
  connectDaemonWs,
  connectWs,
  createFakeHomeWithClaudeShim,
  daemonRpc,
  haveDaemonBinary,
  pollUntil,
  removeDirs,
  scanForLeaks,
  seedTasksFile,
  sendWsRpc,
  spawnIsolatedDaemon,
  startLagSampler,
  streamsDirFor,
  teardownDaemon,
  type LagSampler,
} from './helpers/snapshot-live-harness.js'

// The daemon dir must be set BEFORE any module reads it (daemon-standalone /
// local-daemon capture it at import time) — vi.hoisted runs before imports.
const isolatedDaemon = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const dir = `/tmp/walnut-snapstress-daemon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  process.env.WALNUT_DAEMON_DIR = dir
  return { dir, previous }
})

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-snapshot-stress'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'
import {
  setSnapshotModeForTests,
  getSnapshotStatusMode,
  isSnapshotCovered,
  _resetSnapshotApplyForTests,
} from '../../src/core/session-snapshot-apply.js'
import type { SessionRecord } from '../../src/core/types.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Concurrent sessions = concurrent CLI processes. 6 is the measured budget for
 *  this 14-core box; 12 wedged it. Do NOT raise this. */
const CONCURRENCY = 6
/** Turns per concurrent session (turn 1 rides session:start, turn 2 session:send
 *  onto the SAME live CLI via the mock's armSnapshotNextTurn). */
const TURNS_PER_SESSION = 2
/** 1-minute load average above which the whole suite refuses to run. */
const STRESS_LOAD_CEILING = Number(process.env.WALNUT_STRESS_LOAD_CEILING ?? 24)
/** Event-loop p99 budget for the TEST process (generous — shared machine). */
const LAG_P99_BUDGET_MS = 2000
/** Minimum lag samples before the p99 means anything. At 100ms/sample this is a
 *  ~4s observation window; scenario 1 itself converges in ~2s on a quiet box, so
 *  the sampler is deliberately kept running a little past it rather than reporting
 *  a p99 derived from a dozen points. */
const LAG_MIN_SAMPLES = 40
/** Heap growth budget across the whole suite. */
const HEAP_DELTA_BUDGET_BYTES = 200 * 1024 * 1024

/** Bounded overload wait before giving up (pw-gate's "wait rather than pile on").
 *  A single instantaneous reading is too twitchy here: this file's own collect
 *  phase (real server + daemon modules) plus the machine-wide vitest gate queue
 *  can spike the 1-min average for tens of seconds, and skipping on that
 *  transient wastes a perfectly runnable window. Kept short so the suite's total
 *  runtime bound still holds. */
const LOAD_WAIT_MAX_MS = Number(process.env.WALNUT_STRESS_LOAD_WAIT_MS ?? 60_000)
const LOAD_WAIT_POLL_MS = 5_000

const HAVE_BIN = haveDaemonBinary()

/** Current 1-min average, re-read after a bounded wait if the first read is hot. */
let loadAtStart = os.loadavg()[0]
if (HAVE_BIN && loadAtStart > STRESS_LOAD_CEILING) {
  const deadline = Date.now() + LOAD_WAIT_MAX_MS
  // eslint-disable-next-line no-console
  console.warn(
    `[snapshot-stress] load ${loadAtStart.toFixed(2)} > ceiling ${STRESS_LOAD_CEILING} — `
    + `waiting up to ${Math.round(LOAD_WAIT_MAX_MS / 1000)}s for the box to settle before deciding`,
  )
  // Top-level await: resolves before `describe.runIf` below is evaluated.
  while (Date.now() < deadline && os.loadavg()[0] > STRESS_LOAD_CEILING) {
    await new Promise((r) => setTimeout(r, LOAD_WAIT_POLL_MS))
  }
  loadAtStart = os.loadavg()[0]
}

const LOAD_OK = loadAtStart <= STRESS_LOAD_CEILING
const GATE_OPEN = HAVE_BIN && LOAD_OK

if (!HAVE_BIN) {
  // eslint-disable-next-line no-console
  console.warn(`[snapshot-stress] SKIPPED: needs the real darwin-arm64 daemon binary at ${DAEMON_BIN}`)
} else if (!LOAD_OK) {
  // eslint-disable-next-line no-console
  console.warn(
    `[snapshot-stress] SKIPPED BY LOAD GATE: 1-min load average is ${loadAtStart.toFixed(2)}, `
    + `ceiling is ${STRESS_LOAD_CEILING}. Six concurrent CLI processes on an already-saturated `
    + `box is how this Mac wedges, so the suite refuses rather than piling on. `
    + `Re-run when the box is quiet, or override with WALNUT_STRESS_LOAD_CEILING=<n>.`,
  )
}

const STREAMS_DIR = streamsDirFor(isolatedDaemon.dir)

let fakeHome = ''
let daemonProc: ChildProcess | null = null
let daemonPort = 0
let server: HttpServer
let port = 0
let lag: LagSampler | null = null
let heapAtStart = 0

const taskIds = Array.from({ length: CONCURRENCY }, (_, i) => `snap-stress-task-${i + 1}`)
const WHALE_TASK_ID = 'snap-stress-whale-task'

async function record(sid: string): Promise<SessionRecord | undefined> {
  return await getSessionByClaudeId(sid)
}

/** The session record's claude id for a task, once the runner has persisted one. */
async function sessionIdForTask(taskId: string, timeoutMs = 120_000): Promise<string> {
  return await pollUntil(async () => {
    const records = await getSessionsForTask(taskId)
    return records[0]?.claudeSessionId
  }, `a session record for task ${taskId}`, timeoutMs)
}

function jsonlPathFor(sid: string): string {
  return path.join(STREAMS_DIR, `${sid}.jsonl`)
}

function jsonlSize(sid: string): number {
  try { return fs.statSync(jsonlPathFor(sid)).size } catch { return -1 }
}

/** Terminal `result` lines in a session's stream file = folded turns. */
function resultLineCount(sid: string): number {
  try {
    return fs.readFileSync(jsonlPathFor(sid), 'utf-8')
      .split('\n')
      .filter((l) => l.includes('"type":"result"') && !l.includes('"kind":"task-notification"'))
      .length
  } catch { return 0 }
}

beforeAll(async () => {
  if (!GATE_OPEN) return

  // ── isolation guards ──
  if (path.resolve(isolatedDaemon.dir) === path.resolve(PROD_DAEMON_DIR)) {
    throw new Error('refusing to run against the production daemon dir')
  }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await seedTasksFile(TASKS_FILE, [
    ...taskIds.map((id, i) => ({ id, title: `Snapshot stress session ${i + 1}` })),
    { id: WHALE_TASK_ID, title: 'Snapshot stress whale session' },
  ])

  fakeHome = createFakeHomeWithClaudeShim('walnut-snapstress-home-')

  const spawned = await spawnIsolatedDaemon({
    daemonDir: isolatedDaemon.dir,
    fakeHome,
    extraEnv: {
      // Whale knobs — scenario 2. ~2MB in 64KB lines, the first 3 written as two
      // half-line writes 250ms apart so the 100ms tailer poll must carry a torn
      // tail across ≥2 ticks. Lower WALNUT_STRESS_WHALE_KB for a smoke run.
      MOCK_SNAPSHOT_WHALE_KB: process.env.WALNUT_STRESS_WHALE_KB ?? '2048',
      MOCK_SNAPSHOT_WHALE_LINE_KB: '64',
      MOCK_SNAPSHOT_WHALE_TORN: '3',
      MOCK_SNAPSHOT_WHALE_TEAR_MS: '250',
    },
  })
  daemonProc = spawned.proc
  daemonPort = spawned.port

  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemonPort}`)
  sessionRunner.setCliCommand(MOCK_CLI) // harmless; the daemon path uses the shim

  // Enforce mode: applySnapshot is the SOLE status writer for covered sessions,
  // which is what makes "consumedOffset === my own stream file size" a real
  // no-bleed assertion (in shadow mode the watermark comes from the runner's own
  // result-line offset instead, and never reaches the file's end).
  _resetSnapshotApplyForTests()
  setSnapshotModeForTests('enforce')

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  heapAtStart = process.memoryUsage().heapUsed
  lag = startLagSampler(100)
}, 180_000)

afterAll(async () => {
  lag?.stop()
  setSnapshotModeForTests(null)
  _resetSnapshotApplyForTests()
  sessionRunner.setTestDaemonUrl(undefined)
  try { await stopServer() } catch { /* best effort */ }

  await teardownDaemon({ proc: daemonProc, streamsDir: STREAMS_DIR })
  daemonProc = null

  if (GATE_OPEN) {
    const leaked = scanForLeaks([isolatedDaemon.dir, fakeHome])
    if (leaked) {
      // eslint-disable-next-line no-console
      console.error('[snapshot-stress] LEAKED processes referencing our tmp dirs:\n' + leaked)
    }
    expect(leaked, 'no process may still reference this suite\'s tmp dirs').toBe('')
  }

  await removeDirs([WALNUT_HOME, isolatedDaemon.dir, STREAMS_DIR, fakeHome])
  if (isolatedDaemon.previous === undefined) delete process.env.WALNUT_DAEMON_DIR
  else process.env.WALNUT_DAEMON_DIR = isolatedDaemon.previous
}, 120_000)

describe.runIf(GATE_OPEN)('snapshot source-of-truth — bounded stress (6 concurrent CLIs + whale burst on ONE daemon)', () => {
  /** Measured in scenario 1, asserted in scenario 3. */
  let lagP99 = 0
  let lagP50 = 0
  let lagSampleCount = 0

  // ── Scenario 1: concurrency + no cross-session bleed ──
  it(`1. ${CONCURRENCY} concurrent sessions × ${TURNS_PER_SESSION} turns all converge to idle with NO cross-session snapshot bleed`, async () => {
    expect(getSnapshotStatusMode()).toBe('enforce')

    const ws = await connectWs(port)
    try {
      // ── Turn 1 for all six, launched together (one daemon, six spawns) ──
      // Each session's payload length differs (`-`.repeat(i)) so its stream file
      // ends at a DISTINCT byte offset. That distinctness is what makes the
      // per-session offset assertion below able to detect a mis-routed snapshot
      // at all; it is asserted explicitly so the test can never go vacuous.
      const starts = await Promise.all(taskIds.map((taskId, i) =>
        sendWsRpc(ws, 'session:start', {
          taskId,
          message: `snapshot-clean-turn:stress-${i + 1}-turn1${'-'.repeat(i * 7)}`,
          project: 'Walnut',
          cwd: os.tmpdir(),
        }, 60_000)))
      for (const [i, rpc] of starts.entries()) {
        expect(rpc.ok, `session:start ${i + 1} must be accepted`).toBe(true)
      }

      const sids = await Promise.all(taskIds.map((t) => sessionIdForTask(t)))
      expect(new Set(sids).size, 'each task must get its OWN session id').toBe(CONCURRENCY)

      // Turn 1 settles for everyone. The mock stays alive after `idle` (real
      // FIFO-mode CLI behavior), so this is 'idle', never 'stopped'.
      await pollUntil(async () => {
        const recs = await Promise.all(sids.map(record))
        return recs.every((r) => r?.process_status === 'idle') ? true : undefined
      }, `all ${CONCURRENCY} records to reach process_status=idle after turn 1`, 180_000)

      // GUARD: the MOCK CLI must be what ran on every session. The daemon spawns
      // a bare `claude` through a login shell, and an earlier revision of the
      // behaviour suite lost that race to the user's real CLI — the suite then
      // silently exercised the live model. `model` comes from the init event.
      for (const [i, r] of (await Promise.all(sids.map(record))).entries()) {
        expect(r?.model, `session ${i + 1}: the mock CLI must have won the \`claude\` resolution`).toBe('mock-model')
      }

      // Every sid must be snapshot-covered — the live proof that push/pull
      // actually reached applySnapshot for ALL of them, not just the lucky few.
      // Without this, a green "converged" could just mean "no snapshots arrived
      // and the legacy writers did the work".
      await pollUntil(async () => sids.every(isSnapshotCovered) || undefined,
        `all ${CONCURRENCY} sids to be snapshot-covered`, 60_000)

      // ── Turn 2 for all six, on the SAME live CLIs (armSnapshotNextTurn) ──
      const sends = await Promise.all(sids.map((sid, i) =>
        sendWsRpc(ws, 'session:send', {
          sessionId: sid,
          message: `snapshot-clean-turn:stress-${i + 1}-turn2${'-'.repeat(i * 11)}`,
        }, 60_000)))
      for (const [i, rpc] of sends.entries()) {
        expect(rpc.ok, `session:send ${i + 1} must be accepted`).toBe(true)
      }

      // ── Convergence: BOTH turns folded, every record idle, watermark at its
      //    own file end ──
      // The turn-count half is load-bearing, not decoration: `idle` +
      // `consumedOffset === fileSize` ALSO holds for turn 1 alone (turn 2's idle
      // looks identical and the file has not grown yet), so without counting
      // result lines this poll returns the instant turn 1 settles and the whole
      // scenario silently degrades to "6 concurrent single-turn sessions".
      // Measured: it did exactly that on the first run.
      const readRows = async (): Promise<Array<{
        sid: string
        status: string | undefined
        consumedOffset: number | null
        fileSize: number
        results: number
      }>> => {
        const recs = await Promise.all(sids.map(record))
        return recs.map((r, i) => ({
          sid: sids[i],
          status: r?.process_status,
          consumedOffset: r?.consumedOffset ?? null,
          fileSize: jsonlSize(sids[i]),
          results: resultLineCount(sids[i]),
        }))
      }
      // Kept outside the poll so the timeout message can name WHICH session
      // stalled and on which condition — a bare "timeout" here is unactionable.
      let lastRows: Awaited<ReturnType<typeof readRows>> = []
      const converged = await pollUntil(async () => {
        const rows = await readRows()
        lastRows = rows
        const done = rows.every((row) =>
          row.status === 'idle'
          && row.results >= TURNS_PER_SESSION
          && typeof row.consumedOffset === 'number'
          && row.consumedOffset > 0
          && row.consumedOffset === row.fileSize)
        return done ? rows : undefined
      }, `all ${CONCURRENCY} records idle after ${TURNS_PER_SESSION} folded turns with consumedOffset === their OWN `
        + `stream file size — last seen: ${JSON.stringify(lastRows)}`, 180_000)
        .catch((err) => {
          throw new Error(`${(err as Error).message}\nrows: ${JSON.stringify(lastRows, null, 2)}`)
        })

      // ── The no-bleed assertions, restated explicitly on the settled state ──
      for (const row of converged) {
        expect(row.status, `${row.sid}: settled status`).toBe('idle')
        expect(row.results, `${row.sid}: expected ${TURNS_PER_SESSION} result lines (one per turn)`)
          .toBeGreaterThanOrEqual(TURNS_PER_SESSION)
        expect(row.consumedOffset, `${row.sid}: watermark must have advanced`).toBeGreaterThan(0)
        expect(
          row.consumedOffset,
          `${row.sid}: consumedOffset must equal ITS OWN stream file size — a foreign value here `
          + `means a snapshot was applied to the wrong record (cross-session bleed)`,
        ).toBe(row.fileSize)
      }
      // Non-vacuity: the six offsets must be pairwise distinct, otherwise
      // "equals my own file size" would also hold for a swapped snapshot.
      const offsets = converged.map((r) => r.consumedOffset as number)
      expect(
        new Set(offsets).size,
        `the ${CONCURRENCY} stream files must end at distinct offsets or the no-bleed check is vacuous `
        + `(offsets: ${JSON.stringify(offsets)})`,
      ).toBe(CONCURRENCY)
    } finally {
      // Freeze the lag numbers measured across THIS scenario (the loaded
      // window) in a finally: a failed assertion above must not leave scenario
      // 3 reading an empty sampler and reporting a second, misleading failure.
      //
      // Six sessions × two turns against a mock CLI converge in ~2s on a quiet
      // box, which is only ~20 samples — too few for a meaningful p99. Keep
      // sampling briefly past convergence so the window covers the tail of the
      // snapshot fan-out (the pushes and applies that trail the last idle) too.
      const waitDeadline = Date.now() + 6000
      while ((lag?.samples.length ?? 0) < LAG_MIN_SAMPLES && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      lag?.stop()
      lagP99 = lag?.percentile(99) ?? 0
      lagP50 = lag?.percentile(50) ?? 0
      lagSampleCount = lag?.samples.length ?? 0
      ws.close()
    }
  }, 300_000)

  // ── Scenario 2: whale burst ──
  it('2. a ~2MB whale turn (with mid-line torn writes) converges to idle and the daemon fold consumes every byte', async () => {
    const whaleKb = Number(process.env.WALNUT_STRESS_WHALE_KB ?? 2048)
    const ws = await connectWs(port)
    try {
      const rpc = await sendWsRpc(ws, 'session:start', {
        taskId: WHALE_TASK_ID,
        message: 'snapshot-whale-turn',
        project: 'Walnut',
        cwd: os.tmpdir(),
      }, 60_000)
      expect(rpc.ok).toBe(true)

      const sid = await sessionIdForTask(WHALE_TASK_ID)
      expect(sid).toBeTruthy()

      // The record converges to idle even though the turn shipped megabytes and
      // tore lines across tailer polls.
      const settled = await pollUntil(async () => {
        const r = await record(sid)
        return r?.process_status === 'idle' ? r : undefined
      }, `whale record ${sid} to reach process_status=idle`, 180_000)
      expect(settled.process_status).toBe('idle')
      expect(settled.model, 'the mock CLI must have won the `claude` resolution').toBe('mock-model')

      const size = jsonlSize(sid)
      expect(
        size,
        `the whale turn must actually be a whale (expected ≳${whaleKb}KB, got ${size} bytes)`,
      ).toBeGreaterThan(whaleKb * 1024 * 0.9)

      // ── The headline: the DAEMON's own fold consumed every byte ──
      // Pulled straight off the daemon over its WS (`getState`), i.e. the same
      // snapshot the health monitor's pull path would receive. A torn line the
      // carry failed to hold would advance `v` past the fragment and the
      // `v > foldState.v` guard would skip the real line forever: `v` would sit
      // short of the file size and turnActive would stay true.
      const dws = await connectDaemonWs(daemonPort)
      try {
        const snap = await pollUntil(async () => {
          const res = await daemonRpc(dws, { cmd: 'getState', sid }, 20_000)
          if (res.ok !== true) return undefined
          const s = res.snapshot as SessionSnapshot | undefined
          if (!s) return undefined
          const current = jsonlSize(sid)
          return s.v === current && s.turnActive === false ? { snap: s, current } : undefined
        }, `daemon getState snapshot for ${sid} to reach v === stream file size with turnActive=false`, 90_000, 1000)

        expect(snap.snap.v, 'snapshot.v must equal the stream file byte size (fold consumed every byte)')
          .toBe(snap.current)
        expect(snap.snap.turnActive, 'the whale turn must be settled').toBe(false)
        expect(snap.snap.cliState, 'the CLI stays alive after idle (FIFO mode)').toBe('idle')
        expect(snap.snap.lastResult).toMatchObject({ isError: false })

        // eslint-disable-next-line no-console
        console.log(`[snapshot-stress] whale: ${snap.current} bytes folded, snapshot.v=${snap.snap.v}`)
      } finally {
        dws.close()
      }
    } finally {
      ws.close()
    }
  }, 300_000)

  // ── Scenario 3: event-loop + memory budget ──
  it('3. event-loop p99 and heap growth stayed inside budget while all of the above ran', async () => {
    // Let the last pushes and any trailing writes drain before measuring heap.
    await new Promise((r) => setTimeout(r, 2000))

    const heapDelta = process.memoryUsage().heapUsed - heapAtStart

    // eslint-disable-next-line no-console
    console.log(
      `[snapshot-stress] load@start=${loadAtStart.toFixed(2)} `
      + `event-loop lag over scenario 1 (n=${lagSampleCount}): p50=${lagP50}ms p99=${lagP99}ms `
      + `max=${lag?.max() ?? 0}ms | heapUsed delta=${(heapDelta / 1024 / 1024).toFixed(1)}MB`,
    )

    expect(
      lagSampleCount,
      `the lag sampler must have collected ≥${LAG_MIN_SAMPLES} samples across scenario 1 — `
      + `fewer means the p99 below is noise, not a measurement`,
    ).toBeGreaterThanOrEqual(LAG_MIN_SAMPLES)
    expect(
      lagP99,
      `event-loop p99 in the test process was ${lagP99}ms (budget ${LAG_P99_BUDGET_MS}ms) — `
      + `a blown budget here means the snapshot fan-out is starving the loop (cross-check with `
      + `scripts/walnut-logs.sh busstorm)`,
    ).toBeLessThan(LAG_P99_BUDGET_MS)
    expect(
      heapDelta,
      `heapUsed grew ${(heapDelta / 1024 / 1024).toFixed(1)}MB across the suite `
      + `(budget ${HEAP_DELTA_BUDGET_BYTES / 1024 / 1024}MB) — suspect an unbounded snapshot/appliedV map`,
    ).toBeLessThan(HEAP_DELTA_BUDGET_BYTES)
  }, 60_000)
})

// A skipped suite must still say WHY, loudly, in the reporter output — a silent
// zero-test file reads as "passed" and the load gate would be invisible.
describe.runIf(!GATE_OPEN)('snapshot source-of-truth — bounded stress (gated off)', () => {
  it('is skipped by the load gate / missing daemon binary (see the console warning above)', () => {
    const reason = !HAVE_BIN
      ? `missing daemon binary at ${DAEMON_BIN}`
      : `1-min load average ${loadAtStart.toFixed(2)} > ceiling ${STRESS_LOAD_CEILING}`
    // eslint-disable-next-line no-console
    console.warn(`[snapshot-stress] not run: ${reason}`)
    expect(GATE_OPEN).toBe(false)
  })
})
