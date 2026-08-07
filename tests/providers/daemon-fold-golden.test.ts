/**
 * Golden incident-shape replays for daemon-fold.ts — contract §6.2
 * (docs/plan/session-snapshot-source-of-truth.md).
 *
 * Each block reproduces the SHAPE of a historical status-mismatch incident
 * with SYNTHETIC stream content (public repo — never real conversation text)
 * and asserts the fold + assembleSnapshot reach the verdict the incident's
 * legacy writers got wrong.
 */

import { describe, it, expect } from 'vitest'
import {
  initialFoldState,
  foldLine,
  foldLines,
  assembleSnapshot,
  type FoldState,
  type SessionSnapshot,
} from '../../src/providers/daemon-fold.js'

const SID = 'golden-sid'

function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SID, ...obj })
}
const userLine = (text = 'please tidy the demo garden') =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const markerLine = (text = 'follow-up request') =>
  line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: text }, walnutMessageId: 'qm-7-x' })
const resultLine = (isError = false) =>
  line({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, num_turns: 3, result: 'done' })
const stateLine = (state: string) => line({ type: 'system', subtype: 'session_state_changed', state })
const initLine = () => line({ type: 'system', subtype: 'init', cwd: '/tmp/demo', model: 'mock-model' })
const taskStartLine = (id: string) => line({ type: 'system', subtype: 'task_started', task_id: id })
const taskDoneLine = (id: string) => line({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } })
const assistantLine = (text: string) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

function fold(lines: string[], baseV = 0): FoldState {
  return foldLines(lines.join('\n') + '\n', baseV)
}
function snap(s: FoldState, over: Partial<Parameters<typeof assembleSnapshot>[0]> = {}): SessionSnapshot {
  return assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 4242, exitCode: null, ...over })
}

describe('golden 1 — queued-send race', () => {
  // Shape: turn N settles (result + idle), a queued message is delivered
  // immediately (marker appended) and the CLI starts turn N+1. Legacy writers
  // that keyed off the settled result showed 'idle' while the CLI was working.
  it('result → new user marker → running keeps turnActive=true', () => {
    const s = fold([
      userLine(), resultLine(), stateLine('idle'),
      markerLine('queued follow-up'), stateLine('running'),
    ])
    expect(s.turnActive).toBe(true)
    expect(s.lastResult).toBe(null) // the old result cannot judge the new turn
    expect(snap(s).cliState).toBe('running')
  })

  it('marker alone (running not yet echoed) already flips turnActive', () => {
    const s = fold([userLine(), resultLine(), stateLine('idle'), markerLine('queued follow-up')])
    expect(s.turnActive).toBe(true)
    expect(snap(s).cliState).toBe('running')
  })
})

describe('golden 2 — requires_action pause (the 15h waiting incident shape)', () => {
  // requires_action is NOT folded — the daemon tailer intercepts the
  // control_request imperatively; foldLine only sees running. pendingCtrl
  // joins in assembleSnapshot and must surface as 'waiting'.
  it('running turn + pendingCtrl assembles to waiting with the permission payload', () => {
    const s = fold([userLine(), assistantLine('about to run a tool'), stateLine('running')])
    expect(s.turnActive).toBe(true)
    const snapshot = snap(s, { pendingCtrl: { requestId: 'req-9', toolName: 'Bash', sinceTs: 1_754_000_000_000 } })
    expect(snapshot.cliState).toBe('waiting')
    expect(snapshot.pendingPermission).toEqual({ requestId: 'req-9', toolName: 'Bash', sinceTs: 1_754_000_000_000 })
    expect(snapshot.turnActive).toBe(true) // the turn is paused, not over
  })

  it('permission resolved (pendingCtrl cleared) → back to running', () => {
    const s = fold([userLine(), stateLine('running')])
    expect(snap(s, { pendingCtrl: null }).cliState).toBe('running')
  })
})

describe('golden 3 — restart-in-result-window (server restart landed between result and status write)', () => {
  // Shape: the turn ended cleanly on disk (result + companion idle) but the
  // server restarted before persisting it — record wedged at 'running'. A
  // rebuild-from-disk fold must land on settled → 'idle'.
  it('rebuild over result + idle settles → snapshot idle', () => {
    const s = fold([initLine(), userLine(), assistantLine('working'), resultLine(), stateLine('idle')])
    expect(s.turnActive).toBe(false)
    const snapshot = snap(s)
    expect(snapshot.cliState).toBe('idle')
    expect(snapshot.lastResult?.isError).toBe(false)
    expect(snapshot.gatingBgCount).toBe(0)
  })
})

describe('golden 4 — whale turn (multi-MB single turn, incident 57b125ab shape)', () => {
  it('folds a ~3MB assistant flood and still settles on the trailing result + idle', () => {
    const filler = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } })
    const lines = [initLine(), userLine('the whale turn')]
    for (let i = 0; i < 750; i++) lines.push(filler) // ~3MB
    lines.push(resultLine(), stateLine('idle'))
    const content = lines.join('\n') + '\n'

    const s = foldLines(content)
    expect(s.turnActive).toBe(false)
    expect(snap(s).cliState).toBe('idle')
    // v accounts for every byte — the idempotency coordinate equals file size.
    expect(s.v).toBe(Buffer.byteLength(content, 'utf8'))
  })
})

describe('golden 5 — bg-gating hold (#870 premature-idle shape)', () => {
  it('result + idle with one non-backgrounded bg task open → turnActive stays true; terminal update settles', () => {
    const held = fold([userLine(), taskStartLine('bg-worker'), resultLine(), stateLine('idle')])
    expect(held.turnActive).toBe(true)
    expect(snap(held).cliState).toBe('running')
    expect(snap(held).gatingBgCount).toBe(1)

    // The terminal bookend arrives → gate drops → the already-folded
    // result+idle settle the turn on that very line.
    const doneLine = taskDoneLine('bg-worker')
    const settled = foldLine(held, doneLine, held.v + Buffer.byteLength(doneLine, 'utf8') + 1)
    expect(settled.turnActive).toBe(false)
    expect(snap(settled).cliState).toBe('idle')
    expect(snap(settled).gatingBgCount).toBe(0)
  })
})

describe('golden 6 — replay storm (determinism across a rebuild)', () => {
  // Shape: daemon restart → foldState rebuilt by re-streaming the whole file.
  // The rebuilt state must equal the live-folded one exactly, and folding the
  // same content twice from the same base must be byte-identical.
  it('second pass from a rebuilt state equals the first (deep-equal, incl. v)', () => {
    const lines = [
      initLine(), userLine(),
      taskStartLine('bg-a'), taskStartLine('bg-b'),
      resultLine(), taskDoneLine('bg-a'), taskDoneLine('bg-b'), stateLine('idle'),
      markerLine('next turn'), stateLine('running'),
      resultLine(true),
    ]
    const content = lines.join('\n') + '\n'
    const first = foldLines(content, 100)
    const second = foldLines(content, 100)
    expect(second).toEqual(first)
    expect(snap(second)).toEqual(snap(first))

    // Incremental live fold ≡ batch rebuild (the daemon-restart equivalence).
    let live = initialFoldState(100)
    let v = 100
    for (const l of lines) {
      v += Buffer.byteLength(l, 'utf8') + 1
      live = foldLine(live, l, v)
    }
    expect(live).toEqual(first)
  })
})

describe('golden 7 — error result and dead process', () => {
  it('error result → settled with lastResult.isError=true; live process assembles to idle-with-error evidence', () => {
    const s = fold([userLine(), assistantLine('attempting'), resultLine(true)])
    expect(s.turnActive).toBe(false) // error is terminal without a companion idle
    const alive = snap(s)
    expect(alive.cliState).toBe('idle')
    expect(alive.lastResult?.isError).toBe(true)
  })

  it('dead + nonzero exit → dead snapshot carrying the error result', () => {
    const s = fold([userLine(), resultLine(true)])
    const dead = snap(s, { dead: true, pid: null, exitCode: 1 })
    expect(dead.cliState).toBe('dead')
    expect(dead.exitCode).toBe(1)
    expect(dead.pid).toBe(null)
    expect(dead.lastResult?.isError).toBe(true)
  })

  it('dead mid-turn (crash before any result) → dead snapshot with turnActive still true', () => {
    const s = fold([userLine(), stateLine('running')])
    const dead = snap(s, { dead: true, pid: null, exitCode: -1 })
    expect(dead.cliState).toBe('dead')
    expect(dead.turnActive).toBe(true)
    expect(dead.lastResult).toBe(null)
  })
})
