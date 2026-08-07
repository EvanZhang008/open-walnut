/**
 * Fault-injection interleaving SIMULATOR for the snapshot projection
 * (docs/plan/session-snapshot-source-of-truth.md §6.5).
 *
 * Machine-checks the architecture's core promise: any lost / duplicated /
 * reordered / replayed snapshot delivery, and any daemon or walnut restart,
 * degrades to AT MOST one pull cycle of staleness — never a permanent lie.
 *
 * Layers under test are the REAL production functions:
 *  - daemon side: foldLine / initialFoldState / assembleSnapshot
 *    (src/providers/daemon-fold.ts) driven line-by-line with true byte-offset
 *    `v` coordinates (lineStart + byteLength + 1);
 *  - emit-on-change: a local mirror of snapshotDiffers
 *    (src/providers/daemon-standalone.ts:780) — non-v field compare;
 *  - walnut side: applySnapshot in ENFORCE mode against the REAL
 *    session-tracker over an isolated SQLite (mock-constants tmp home).
 *
 * Determinism: seeded mulberry32 PRNG only (seed constant logged below).
 * NO Math.random / Date.now anywhere in the sim logic.
 *
 * MACHINE SAFETY: isolated tmp WALNUT_HOME; no daemons, no ports, no
 * ~/.open-walnut; single test file, honors the 2-worker budget.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-snap-sim'))

// applySnapshot (enforce) dynamically imports the session runner to sync a
// live instance's in-memory status; no live runner exists in the sim.
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))

import {
  initialFoldState,
  foldLine,
  assembleSnapshot,
  snapshotDiffers,
  type FoldState,
  type SessionSnapshot,
} from '../../src/providers/daemon-fold.js'
import {
  applySnapshot,
  projectProcessStatus,
  setSnapshotModeForTests,
  _resetSnapshotGateForTests,
  _resetSnapshotApplyForTests,
} from '../../src/core/session-snapshot-apply.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { log } from '../../src/logging/index.js'
import { WALNUT_HOME } from '../../src/constants.js'

// ── PRNG (mulberry32, same as daemon-fold.test.ts property test) ─────────────
const BASE_SEED = 0x51AB1E // logged on run; scenario i uses BASE_SEED + i
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── CLI stream line builders (synthetic shapes, mirrors daemon-fold.test.ts) ──
const SID_IN_STREAM = 'sim-stream-sid'
function userEvent(text: string): string {
  return JSON.stringify({ type: 'user', session_id: SID_IN_STREAM, message: { role: 'user', content: [{ type: 'text', text }] } })
}
function walnutInjectedEvent(text: string): string {
  return JSON.stringify({
    type: 'user', subtype: 'walnut-injected', session_id: SID_IN_STREAM,
    message: { role: 'user', content: text }, walnutMessageId: `qm-${text}`,
  })
}
function assistantText(text: string): string {
  return JSON.stringify({ type: 'assistant', session_id: SID_IN_STREAM, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}
function streamEvent(i: number): string {
  return JSON.stringify({ type: 'stream_event', session_id: SID_IN_STREAM, event: { type: 'content_block_delta', i } })
}
function resultEvent(isError: boolean, numTurns = 1): string {
  return JSON.stringify({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError, num_turns: numTurns, result: 'Done', session_id: SID_IN_STREAM,
  })
}
function stateEvent(state: 'running' | 'idle'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: SID_IN_STREAM, state })
}
function taskStarted(taskId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'task_started', session_id: SID_IN_STREAM, task_id: taskId })
}
function taskDone(taskId: string, status = 'completed'): string {
  return JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: SID_IN_STREAM, task_id: taskId, status })
}
function teamCreate(): string {
  return JSON.stringify({
    type: 'assistant', session_id: SID_IN_STREAM,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_tc', name: 'TeamCreate', input: {} }] },
  })
}
function teamDelete(): string {
  return JSON.stringify({
    type: 'assistant', session_id: SID_IN_STREAM,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_td', name: 'TeamDelete', input: {} }] },
  })
}

// ── True-timeline event model ────────────────────────────────────────────────
type SimEvent =
  | { kind: 'line'; raw: string }
  | { kind: 'ctrl-set'; requestId: string; toolName?: string } // permission request intercepted imperatively
  | { kind: 'ctrl-clear' }                                      // permission resolved
  | { kind: 'death'; exitCode: number }                         // CLI process died / reaped
  | { kind: 'daemon-restart' }                                  // rebuild-from-disk + re-push

function describeEvent(ev: SimEvent): string {
  if (ev.kind !== 'line') return ev.kind + ('exitCode' in ev ? `(${ev.exitCode})` : '')
  const p = JSON.parse(ev.raw) as { type?: string; subtype?: string; state?: string; is_error?: boolean; task_id?: string }
  return [p.type, p.subtype, p.state, p.task_id, p.is_error ? 'ERR' : ''].filter(Boolean).join(':')
}

/**
 * Scripted session lifecycle: N turns of (user marker → assistant chatter →
 * optional bg task open/close → optional permission request/resolve → result →
 * idle), with optional mid-turn death, error result, team markers, a
 * possibly-unfinished final turn, and a possibly-unresolved final permission.
 * All randomness from the seeded PRNG.
 *
 * WAITING-BRANCH COVERAGE (why the tail branch below exists): an unresolved
 * MID-TURN permission (the in-loop branch) leaves cliState 'waiting' AND
 * turnActive true — projectProcessStatus's `cliState === 'waiting'` rule is then
 * masked by the `turnActive` rule right below it, so deleting the waiting branch
 * would not change any verdict and the sim would not notice. The blind spot is
 * the POST-SETTLE permission: the turn already settled (result + idle folded, so
 * turnActive is false) when the daemon intercepts a fresh `requires_action`
 * control request. That is a real race — a FIFO-delivered message leaves no
 * stream line until the daemon writes its walnut-injected marker, so the CLI can
 * ask for permission on the new turn's first tool while the fold still reads
 * settled. There the waiting rule is the DECIDING one: 'running' with it, 'idle'
 * (or 'error') without.
 */
function generateTimeline(rand: () => number): SimEvent[] {
  const events: SimEvent[] = []
  const nTurns = 1 + Math.floor(rand() * 5)
  let bgSeq = 0
  for (let t = 0; t < nTurns; t++) {
    events.push({ kind: 'line', raw: rand() < 0.2 ? walnutInjectedEvent(`go-${t}`) : userEvent(`turn-${t}`) })
    const nChatter = Math.floor(rand() * 3)
    for (let c = 0; c < nChatter; c++) {
      events.push({ kind: 'line', raw: rand() < 0.5 ? assistantText(`chat-${t}-${c}`) : streamEvent(c) })
    }
    const bgId = rand() < 0.35 ? `bg-${bgSeq++}` : null
    if (bgId) events.push({ kind: 'line', raw: taskStarted(bgId) })
    const team = rand() < 0.12
    if (team) events.push({ kind: 'line', raw: teamCreate() })

    if (rand() < 0.3) {
      events.push({ kind: 'ctrl-set', requestId: `req-${t}`, toolName: 'Bash' })
      if (t === nTurns - 1 && rand() < 0.3) return events // left waiting at end → truth 'running'
      events.push({ kind: 'ctrl-clear' })
    }

    if (rand() < 0.08) { // mid-turn death → truth 'error' (non-zero exit)
      events.push({ kind: 'death', exitCode: 137 })
      return events
    }
    if (t === nTurns - 1 && rand() < 0.15) return events // still mid-turn at end → truth 'running'

    const isError = rand() < 0.12
    events.push({ kind: 'line', raw: resultEvent(isError) })
    if (!isError || rand() < 0.5) events.push({ kind: 'line', raw: stateEvent('idle') })
    // bg closes AFTER result/idle sometimes → exercises the late-settle path
    if (bgId) events.push({ kind: 'line', raw: taskDone(bgId) })
    if (team) events.push({ kind: 'line', raw: teamDelete() })
    if (isError) return events // error is terminal for the script → truth 'error'
  }
  // POST-SETTLE unresolved permission: the last turn settled (result + idle
  // folded → turnActive false), then a `requires_action` control request is
  // intercepted and NEVER resolved — no further lines, so quiescence has
  // cliState 'waiting' with turnActive false. This is the only shape where
  // projectProcessStatus's waiting rule DECIDES the verdict (see the
  // generateTimeline header). Mutually exclusive with the reap below: a dead
  // session's cliState is 'dead', which masks 'waiting'.
  if (rand() < 0.18) {
    events.push({ kind: 'ctrl-set', requestId: 'req-tail', toolName: 'Read' })
    return events
  }
  if (rand() < 0.12) events.push({ kind: 'death', exitCode: 0 }) // idle-timer reap → truth 'stopped'
  return events
}

/** Insert 0–2 daemon restarts at seeded positions. */
function withDaemonRestarts(events: SimEvent[], rand: () => number): SimEvent[] {
  if (rand() < 0.35) {
    const n = 1 + (rand() < 0.3 ? 1 : 0)
    for (let k = 0; k < n; k++) {
      const at = Math.floor(rand() * (events.length + 1))
      events.splice(at, 0, { kind: 'daemon-restart' })
    }
  }
  return events
}

// ── Daemon model: real fold + emit-on-change ─────────────────────────────────

// Emit-on-change: the REAL `snapshotDiffers`, imported directly.
// It used to be a hand-written mirror of a copy in daemon-standalone.ts, guarded
// by a source-parity regex test. Both twins' copies were collapsed into the
// zero-import, side-effect-free daemon-fold.ts (C19), which the sim can simply
// import — so the mirror AND its anti-drift guard are gone: the sim now models
// the daemon's push decision by CONSTRUCTION, not by textual agreement.

interface DaemonRun {
  emitted: SessionSnapshot[]
  finalTrue: SessionSnapshot
}

/**
 * Fold the scripted events through the REAL reducer, producing the true
 * snapshot sequence with correct `v` per line (lineStart + byteLength + 1).
 * Emits only when non-v fields change (snapshotDiffers), like the daemon.
 * daemon-restart: rebuild from line 0 — asserted equal to the incremental
 * state (sanity invariant) — then re-push the current snapshot unconditionally
 * (reconnect re-announce). pendingCtrl survives the restart: the
 * requires_action control request is re-intercepted from the stream on re-read.
 */
function runDaemon(events: SimEvent[]): DaemonRun {
  let fold: FoldState = initialFoldState(0)
  const lines: string[] = []
  let v = 0
  let ctrl: { requestId: string; toolName?: string } | null = null
  let dead = false
  let exitCode: number | null = null
  let pid: number | null = 4242
  const emitted: SessionSnapshot[] = []
  let last: SessionSnapshot | null = null
  const assemble = (): SessionSnapshot =>
    assembleSnapshot({ foldState: fold, pendingCtrl: ctrl, dead, pid, exitCode })

  for (const ev of events) {
    let force = false
    if (ev.kind === 'line') {
      v += Buffer.byteLength(ev.raw, 'utf8') + 1
      fold = foldLine(fold, ev.raw, v)
      lines.push(ev.raw)
    } else if (ev.kind === 'ctrl-set') {
      ctrl = { requestId: ev.requestId, ...(ev.toolName !== undefined ? { toolName: ev.toolName } : {}) }
    } else if (ev.kind === 'ctrl-clear') {
      ctrl = null
    } else if (ev.kind === 'death') {
      dead = true
      exitCode = ev.exitCode
      pid = null
    } else { // daemon-restart
      let rebuilt = initialFoldState(0)
      let rv = 0
      for (const l of lines) {
        rv += Buffer.byteLength(l, 'utf8') + 1
        rebuilt = foldLine(rebuilt, l, rv)
      }
      // SANITY INVARIANT: rebuild-from-zero ≡ incremental fold. If this ever
      // fails it is a REAL daemon-fold bug (impure/statful reducer).
      expect(rebuilt, 'daemon restart rebuild must equal incremental fold state').toEqual(fold)
      force = true
    }
    const snap = assemble()
    if (force || !last || snapshotDiffers(last, snap)) {
      emitted.push(snap)
      last = snap
    }
  }
  return { emitted, finalTrue: assemble() }
}

// ── Lossy channel ────────────────────────────────────────────────────────────
type Delivery = { kind: 'deliver'; snap: SessionSnapshot } | { kind: 'walnut-restart' }

const P_DROP = 0.2
const P_DUP = 0.1
const P_REORDER = 0.15
const REORDER_WINDOW = 3

function lossyChannel(emitted: SessionSnapshot[], rand: () => number, scriptLog: string[]): Delivery[] {
  const out: Delivery[] = []
  for (const s of emitted) {
    if (rand() < P_DROP) { scriptLog.push(`drop    v=${s.v} ${s.cliState}`); continue }
    out.push({ kind: 'deliver', snap: s })
    scriptLog.push(`deliver v=${s.v} ${s.cliState}`)
    if (rand() < P_DUP) { out.push({ kind: 'deliver', snap: s }); scriptLog.push(`dup     v=${s.v} ${s.cliState}`) }
  }
  // Reorder within a window of 3 (swap i with i+1..i+2); swaps can chain.
  for (let i = 0; i < out.length; i++) {
    if (rand() < P_REORDER) {
      const j = i + 1 + Math.floor(rand() * (REORDER_WINDOW - 1))
      if (j < out.length) {
        const t = out[i]; out[i] = out[j]; out[j] = t
        scriptLog.push(`swap    slots ${i}<->${j}`)
      }
    }
  }
  // Walnut restart: clear the in-memory appliedV map mid-delivery.
  if (rand() < 0.35 && out.length > 0) {
    const at = Math.floor(rand() * (out.length + 1))
    out.splice(at, 0, { kind: 'walnut-restart' })
    scriptLog.push(`walnut-restart at slot ${at}`)
  }
  return out
}

// ── Walnut model: real applySnapshot in ENFORCE mode over the real tracker ───

async function seedSession(sid: string, startStatus: 'running' | 'idle'): Promise<void> {
  await createSessionRecord(sid, '', 'sim-proj', '/tmp/snap-sim', { pid: 4242 })
  await updateSessionRecord(sid, { process_status: startStatus } as never)
}

function simulateWalnutRestart(): void {
  // Process death loses both in-memory structures; mode re-derives from env
  // (still enforce on the restarted process).
  _resetSnapshotApplyForTests()
  _resetSnapshotGateForTests()
  setSnapshotModeForTests('enforce')
}

interface WalnutRunResult { appliedVs: number[] }

async function runWalnut(sid: string, deliveries: Delivery[]): Promise<WalnutRunResult> {
  const appliedVs: number[] = []
  let lastOffset = 0
  for (const d of deliveries) {
    if (d.kind === 'walnut-restart') { simulateWalnutRestart(); continue }
    const res = await applySnapshot(sid, d.snap, 'daemon-push')
    if (res.outcome === 'applied') appliedVs.push(d.snap.v)
    const rec = await getSessionByClaudeId(sid)
    const off = typeof rec?.consumedOffset === 'number' ? rec.consumedOffset : 0
    // MONOTONICITY INVARIANT: the durable watermark never decreases.
    expect(off, `consumedOffset regressed (${lastOffset} → ${off}) after delivering v=${d.snap.v}`)
      .toBeGreaterThanOrEqual(lastOffset)
    // TURN-END WATERMARK INVARIANT (C15): consumedOffset is a turn-END byte
    // position — foldSessionTail synthesizes its whale-turn anchor there and the
    // replay guards read `v <= consumedOffset` as "already fully processed". So
    // it may only ever equal the v of a snapshot that was SETTLED or DEAD; a
    // mid-turn running/waiting v must never be adopted.
    if (off > lastOffset) {
      const legal = d.snap.cliState === 'dead'
        || (d.snap.cliState !== 'waiting' && !d.snap.turnActive)
      expect(legal, `mid-turn watermark adoption: v=${d.snap.v} advanced consumedOffset to ${off} `
        + `from a ${d.snap.cliState}/turnActive=${d.snap.turnActive} snapshot`).toBe(true)
      expect(off, 'the adopted watermark must be exactly the snapshot v').toBe(d.snap.v)
    }
    lastOffset = off
  }
  // NO-REPLAY-OVERWRITE INVARIANT: applied snapshot v sequence is sorted —
  // a stale-v (replayed) snapshot never overwrote a newer application.
  for (let i = 1; i < appliedVs.length; i++) {
    expect(appliedVs[i], `applied v sequence not sorted: ${appliedVs.join(',')}`)
      .toBeGreaterThanOrEqual(appliedVs[i - 1])
  }
  return { appliedVs }
}

interface ScenarioResult {
  /** The record was WRONG before the pull (the channel actually broke it). */
  wasStaleBeforePull: boolean
  /** Quiescence left the CLI in the waiting state (permission-branch coverage). */
  endedWaiting: boolean
  /** …and with turnActive false, i.e. the waiting rule DECIDED the verdict. */
  endedWaitingDecisive: boolean
  /** The projection never needed to write (seed status already correct + no
   *  watermark to adopt) — the record is right, just not authored by us. */
  neverWritten: boolean
}

/** One full scenario: timeline → daemon fold → lossy delivery → ONE pull → invariant. */
async function runScenario(seed: number): Promise<ScenarioResult> {
  const rand = mulberry32(seed)
  const scriptLog: string[] = []
  const events = withDaemonRestarts(generateTimeline(rand), rand)
  const sid = `sim-${seed}`
  try {
    _resetSnapshotApplyForTests() // fresh walnut memory per scenario (fresh session anyway)
    const { emitted, finalTrue } = runDaemon(events)
    const deliveries = lossyChannel(emitted, rand, scriptLog)
    await seedSession(sid, rand() < 0.5 ? 'running' : 'idle')
    const { appliedVs } = await runWalnut(sid, deliveries)

    const expected = projectProcessStatus(finalTrue)
    const beforePull = await getSessionByClaudeId(sid)
    const wasStaleBeforePull = beforePull?.process_status !== expected

    // ONE pull cycle after quiescence — the architecture's staleness bound.
    const pull = await applySnapshot(sid, finalTrue, 'pull-30s')

    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status, 'CORE INVARIANT: after quiescence + one pull, the record equals the true projection')
      .toBe(expected)
    // AUTHORSHIP: whenever the projection actually wrote, it must own the record.
    // It legitimately writes NOTHING when the seeded status already matches AND
    // there is no turn-END watermark to adopt (C15: a mid-turn running/waiting
    // snapshot writes process_status only). "Correct without a write" is a pass,
    // not a miss — but it must not be silently the common case, so the sweep
    // asserts a floor on real writes below.
    const written = appliedVs.length > 0 || pull.outcome === 'applied'
    if (written) expect(rec?.status_changed_by).toBe('snapshot')
    return {
      wasStaleBeforePull,
      endedWaiting: finalTrue.cliState === 'waiting',
      endedWaitingDecisive: finalTrue.cliState === 'waiting' && !finalTrue.turnActive,
      neverWritten: !written,
    }
  } catch (e) {
    // Reproduction bundle: seed + full timeline + channel script.
    throw new Error(
      `[sim] INVARIANT VIOLATION — seed=${seed} (0x${seed.toString(16)})\n`
      + `timeline (${events.length} events):\n  ${events.map(describeEvent).join('\n  ')}\n`
      + `channel script:\n  ${scriptLog.join('\n  ')}\n\n`
      + `cause: ${e instanceof Error ? e.stack : String(e)}`,
    )
  }
}

// ── suite lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  // eslint-disable-next-line no-console
  console.log(`[sim] base seed = 0x${BASE_SEED.toString(16)} (${BASE_SEED}); scenario i uses seed BASE+i`)
})

beforeEach(() => {
  setSnapshotModeForTests('enforce')
  bus.clear()
  // Silence per-apply info/warn spam (300 scenarios × several writes each);
  // errors stay visible.
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  vi.spyOn(log.session, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

// ── the 300-scenario sweep ───────────────────────────────────────────────────

describe('snapshot projection — fault-injection interleaving simulator (§6.5)', () => {
  it('300 seeded scenarios: any drop/dup/reorder/replay/restart converges after one pull', async () => {
    let healedByPull = 0
    let endedWaiting = 0
    let endedWaitingDecisive = 0
    let neverWritten = 0
    for (let i = 0; i < 300; i++) {
      const r = await runScenario(BASE_SEED + i)
      if (r.wasStaleBeforePull) healedByPull++
      if (r.endedWaiting) endedWaiting++
      if (r.endedWaitingDecisive) endedWaitingDecisive++
      if (r.neverWritten) neverWritten++
    }
    // Coverage proof: the channel must have actually broken convergence in a
    // meaningful fraction of scenarios (pushes alone were insufficient), or
    // the sweep is testing nothing. Deterministic count for the fixed seed.
    // eslint-disable-next-line no-console
    console.log(`[sim] ${healedByPull}/300 scenarios were stale before the pull and healed by it`)
    expect(healedByPull).toBeGreaterThan(20)

    // Coverage proof #2 — projectProcessStatus's WAITING branch. The generator
    // ends some scenarios on an unresolved permission; `Decisive` counts the
    // ones where turnActive is ALSO false, which is the only shape where the
    // waiting rule changes the verdict (mid-turn waiting is masked by the
    // turnActive rule below it). Without a non-zero Decisive count the branch
    // could be deleted and this sweep would stay green.
    // eslint-disable-next-line no-console
    console.log(`[sim] quiescence in 'waiting': ${endedWaiting}/300 (${endedWaitingDecisive} decisive)`)
    expect(endedWaiting).toBeGreaterThan(10)
    expect(endedWaitingDecisive).toBeGreaterThan(10)

    // Coverage proof #3 — the authorship assertion must be exercised. A scenario
    // where the projection never writes (seeded status already correct AND no
    // turn-END watermark to adopt — C15) is a legitimate pass, but if that were
    // MOST scenarios the sweep would be asserting almost nothing about writes.
    // eslint-disable-next-line no-console
    console.log(`[sim] projection never needed to write in ${neverWritten}/300 scenarios`)
    expect(neverWritten, 'the vast majority of scenarios must exercise a real write').toBeLessThan(60)
  }, 120_000)

  it('the daemon twins hold NO private copy of snapshotDiffers (single-source guard)', async () => {
    // The sim's emit-on-change imports the real snapshotDiffers from
    // daemon-fold.ts. That is only a faithful model of the daemon while the
    // daemon has no private copy of its own: a re-duplicated
    // `function snapshotDiffers` in either twin could drift (e.g. dropping a
    // field from the compare = a silently suppressed push) and the whole
    // 300-scenario sweep would validate a daemon that no longer exists.
    for (const file of ['daemon-standalone.ts', 'daemon-source.ts']) {
      const src = await fsp.readFile(new URL(`../../src/providers/${file}`, import.meta.url), 'utf-8')
      expect(
        /function\s+snapshotDiffers\s*\(/.test(src),
        `RE-DUPLICATION: src/providers/${file} declares its own snapshotDiffers again. It must `
        + 'consume the single exported copy from src/providers/daemon-fold.ts (imported by the '
        + 'standalone twin, textually injected as __SNAPSHOT_DIFFERS__ into the source twin), '
        + 'or this sim silently models a different daemon.',
      ).toBe(false)
    }
    // …and the shared copy is actually reachable + behaving (bare v advance is
    // not a change; a real state flip is).
    const base: SessionSnapshot = {
      v: 10, cliState: 'running', turnActive: true, pendingPermission: null,
      gatingBgCount: 0, teamActive: false, lastResult: null, pid: 1, exitCode: null,
    }
    expect(snapshotDiffers(base, { ...base, v: 999 })).toBe(false)
    expect(snapshotDiffers(base, { ...base, cliState: 'idle', turnActive: false })).toBe(true)
  })

  it('generator + channel are deterministic for a fixed seed', () => {
    const gen = (seed: number): string => {
      const r1 = mulberry32(seed)
      const events = withDaemonRestarts(generateTimeline(r1), r1)
      const { emitted } = runDaemon(events)
      const scriptLog: string[] = []
      lossyChannel(emitted, r1, scriptLog)
      return JSON.stringify({ events, scriptLog })
    }
    expect(gen(BASE_SEED)).toBe(gen(BASE_SEED))
    expect(gen(BASE_SEED + 42)).toBe(gen(BASE_SEED + 42))
  })
})

// ── hand-written incident-shaped scenarios ───────────────────────────────────

describe('incident-shaped scenarios', () => {
  it('(a) push storm dropped entirely — pull alone converges', async () => {
    // Two clean turns; EVERY push is lost. The record keeps its stale seed
    // status until the single pull heals it.
    const events: SimEvent[] = [
      { kind: 'line', raw: userEvent('turn-0') },
      { kind: 'line', raw: assistantText('working') },
      { kind: 'line', raw: resultEvent(false) },
      { kind: 'line', raw: stateEvent('idle') },
      { kind: 'line', raw: userEvent('turn-1') },
      { kind: 'line', raw: resultEvent(false) },
      { kind: 'line', raw: stateEvent('idle') },
    ]
    const { emitted, finalTrue } = runDaemon(events)
    expect(emitted.length).toBeGreaterThan(0) // pushes existed — and all get dropped
    const sid = 'sim-incident-a'
    _resetSnapshotApplyForTests()
    await seedSession(sid, 'running') // stale lie: walnut believes running

    // deliver NOTHING (100% push loss), then one pull.
    await applySnapshot(sid, finalTrue, 'pull-30s')
    const rec = await getSessionByClaudeId(sid)
    expect(projectProcessStatus(finalTrue)).toBe('idle')
    expect(rec?.process_status).toBe('idle')
    expect(rec?.consumedOffset).toBe(finalTrue.v)
  })

  it('(b) walnut restart mid-turn — appliedV reseeds from consumedOffset; replayed idle cannot regress a running record', async () => {
    // Turn 1 settles (idle snapshot v=V1); turn 2 starts (running snapshot
    // v=V2 > V1). Walnut restarts, losing the in-memory appliedV map. A
    // REPLAY of the old idle snapshot then arrives. The gate must reseed from
    // the durable record.consumedOffset (V2) and drop the replay as stale —
    // the record must NOT regress to idle while the CLI is mid-turn.
    const events: SimEvent[] = [
      { kind: 'line', raw: userEvent('turn-0') },
      { kind: 'line', raw: resultEvent(false) },
      { kind: 'line', raw: stateEvent('idle') },
      { kind: 'line', raw: userEvent('turn-1') }, // mid-turn at end
    ]
    const { emitted, finalTrue } = runDaemon(events)
    const idleSnap = emitted.find((s) => s.cliState === 'idle')
    const runningSnaps = emitted.filter((s) => s.cliState === 'running')
    const lastRunning = runningSnaps[runningSnaps.length - 1]
    expect(idleSnap).toBeTruthy()
    expect(lastRunning).toBeTruthy()
    expect(lastRunning!.v).toBeGreaterThan(idleSnap!.v)

    const sid = 'sim-incident-b'
    _resetSnapshotApplyForTests()
    await seedSession(sid, 'idle')

    // First sight: gate floor is the fresh record's consumedOffset (0), so the
    // idle snapshot is live evidence and applies (adopting the turn-END v=V1).
    expect((await applySnapshot(sid, idleSnap!, 'daemon-push')).outcome).toBe('applied')
    expect((await applySnapshot(sid, lastRunning!, 'daemon-push')).outcome).toBe('applied')
    let rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('running')
    // C15: the MID-TURN running snapshot moved process_status but NOT the
    // turn-END watermark — it still points at turn 1's settle (V1).
    expect(rec?.consumedOffset).toBe(idleSnap!.v)

    simulateWalnutRestart() // appliedV map gone; durable consumedOffset survives

    // The replay now arrives at EXACTLY the reseeded floor (V1) rather than
    // below it, so the stale-drop no longer catches it — the equal-v tiebreaker
    // (C16) is what refuses it: at an unchanged watermark a stream-derived
    // projection carries no evidence the record has not already consumed, so it
    // must not regress a live turn to idle. These two guards are complementary,
    // and after the C15 change this scenario needs the second one.
    const replay = await applySnapshot(sid, idleSnap!, 'daemon-push')
    expect(replay).toMatchObject({ outcome: 'skipped', reason: 'predicate-false' })
    rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('running') // NO regression to idle
    expect(rec?.consumedOffset).toBe(idleSnap!.v) // and no watermark churn

    // A replay from BELOW the floor is still caught by the cheap stale gate.
    const belowFloor = await applySnapshot(sid, { ...idleSnap!, v: idleSnap!.v - 1 }, 'daemon-push')
    expect(belowFloor.outcome).toBe('stale')

    // And the pull (true state: still mid-turn) keeps it running.
    await applySnapshot(sid, finalTrue, 'pull-30s')
    rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('running')
  })

  it('(c) daemon restart mid-turn — rebuilt snapshot converges, v continuity preserved', async () => {
    const events: SimEvent[] = [
      { kind: 'line', raw: userEvent('turn-0') },
      { kind: 'line', raw: assistantText('mid-turn work') },
      { kind: 'daemon-restart' }, // rebuild from line 0 + re-push (asserted ≡ incremental inside runDaemon)
      { kind: 'line', raw: resultEvent(false) },
      { kind: 'line', raw: stateEvent('idle') },
    ]
    const { emitted, finalTrue } = runDaemon(events)
    // v continuity: the emitted sequence never regresses across the restart.
    for (let i = 1; i < emitted.length; i++) {
      expect(emitted[i].v).toBeGreaterThanOrEqual(emitted[i - 1].v)
    }
    // The restart re-push is a duplicate of the pre-restart running snapshot.
    const runningEmits = emitted.filter((s) => s.cliState === 'running')
    expect(runningEmits.length).toBeGreaterThanOrEqual(2)

    const sid = 'sim-incident-c'
    _resetSnapshotApplyForTests()
    await seedSession(sid, 'idle')
    const { appliedVs } = await runWalnut(sid, emitted.map((snap) => ({ kind: 'deliver' as const, snap })))
    for (let i = 1; i < appliedVs.length; i++) {
      expect(appliedVs[i]).toBeGreaterThanOrEqual(appliedVs[i - 1])
    }
    await applySnapshot(sid, finalTrue, 'pull-30s')
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe(projectProcessStatus(finalTrue))
    expect(projectProcessStatus(finalTrue)).toBe('idle')
  })

  it('(d) post-settle unresolved permission — waiting decides the verdict, one pull heals the stale idle', async () => {
    // The generator's tail branch, hand-pinned: the turn settles (result +
    // idle → turnActive false), THEN a permission request is intercepted and
    // never resolved. This is the ONLY shape where projectProcessStatus's
    // `cliState === 'waiting'` rule decides alone — mid-turn waiting is masked
    // by the turnActive rule right below it.
    const events: SimEvent[] = [
      { kind: 'line', raw: userEvent('turn-0') },
      { kind: 'line', raw: resultEvent(false) },
      { kind: 'line', raw: stateEvent('idle') },
      { kind: 'ctrl-set', requestId: 'req-tail', toolName: 'Read' },
    ]
    const { emitted, finalTrue } = runDaemon(events)
    expect(finalTrue.cliState).toBe('waiting')
    expect(finalTrue.turnActive).toBe(false) // masking guard: waiting is load-bearing here
    expect(projectProcessStatus(finalTrue)).toBe('running')

    const sid = 'sim-incident-d'
    _resetSnapshotApplyForTests()
    await seedSession(sid, 'running')

    // Channel drops the waiting push; only the settled idle snapshot lands.
    const idleSnap = emitted.find((s) => s.cliState === 'idle')
    expect(idleSnap).toBeTruthy()
    await applySnapshot(sid, idleSnap!, 'daemon-push')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle') // stale lie

    await applySnapshot(sid, finalTrue, 'pull-30s')
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('running')
    expect(rec?.consumedOffset).toBe(finalTrue.v)
  })
})
