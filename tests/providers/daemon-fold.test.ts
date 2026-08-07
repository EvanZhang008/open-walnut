/**
 * Unit tests for daemon-fold.ts — the pure incremental foldLine reducer that
 * ports foldSessionTail's semantics (src/core/session-reconcile.ts:203-415)
 * into the daemon's per-line tailer feed.
 *
 * Contract: docs/plan/session-snapshot-source-of-truth.md §2. The batch fold
 * must satisfy `lines.reduce(foldLine, initialFoldState())` ≡ foldSessionTail
 * verdict on the same content — the property test at the bottom checks this
 * against the REAL foldSessionTail on seeded random sequences.
 */

import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

// foldSessionTail's module pulls in logging → constants; isolate all paths so
// importing it can never touch production dirs.
vi.mock('../../src/constants.js', () => createMockConstants())

import {
  initialFoldState,
  foldLine,
  foldLines,
  assembleSnapshot,
  type FoldState,
} from '../../src/providers/daemon-fold.js'
import { foldSessionTail } from '../../src/core/session-reconcile.js'

const SID = 'fold-unit-sid'

// ── Fixture builders (synthetic shapes, mirrors session-reconcile.test.ts) ──

function initEvent(): string {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: SID, cwd: '/tmp/x', model: 'mock-model' })
}
function userEvent(text = 'hello'): string {
  return JSON.stringify({ type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'text', text }] } })
}
function userStringEvent(text = 'plain'): string {
  return JSON.stringify({ type: 'user', session_id: SID, message: { role: 'user', content: text } })
}
function toolResultUserEvent(): string {
  return JSON.stringify({
    type: 'user', session_id: SID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'ok' }] },
  })
}
function subagentUserEvent(parentToolUseId: string): string {
  return JSON.stringify({
    type: 'user', session_id: SID, parent_tool_use_id: parentToolUseId,
    message: { role: 'user', content: [{ type: 'text', text: 'subagent prompt' }] },
  })
}
function walnutInjectedEvent(text = 'continue'): string {
  return JSON.stringify({
    type: 'user', subtype: 'walnut-injected', session_id: SID,
    message: { role: 'user', content: text }, walnutMessageId: 'qm-1-a',
  })
}
function resultEvent(isError = false, numTurns = 1): string {
  return JSON.stringify({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError, num_turns: numTurns, result: 'Done', session_id: SID,
  })
}
function notificationOriginResult(): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'bg summary',
    session_id: SID, origin: { kind: 'task-notification' },
  })
}
function stateEvent(state: 'running' | 'idle' | 'requires_action'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: SID, state })
}
function taskStarted(taskId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'task_started', session_id: SID, task_id: taskId })
}
function taskProgress(taskId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'task_progress', session_id: SID, task_id: taskId })
}
function taskUpdated(taskId: string, patch: Record<string, unknown>): string {
  return JSON.stringify({ type: 'system', subtype: 'task_updated', session_id: SID, task_id: taskId, patch })
}
function taskDone(taskId: string, status = 'completed'): string {
  return JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: SID, task_id: taskId, status })
}
function bgTasksChanged(taskIds: string[]): string {
  return JSON.stringify({
    type: 'system', subtype: 'background_tasks_changed', session_id: SID,
    tasks: taskIds.map((id) => ({ task_id: id, status: 'running' })),
  })
}
function teamCreate(): string {
  return JSON.stringify({
    type: 'assistant', session_id: SID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'TeamCreate', input: {} }] },
  })
}
function teamDelete(): string {
  return JSON.stringify({
    type: 'assistant', session_id: SID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'TeamDelete', input: {} }] },
  })
}

function fold(lines: string[], baseV = 0): FoldState {
  return foldLines(lines.join('\n') + '\n', baseV)
}
function gating(s: FoldState): number {
  return assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 1, exitCode: null }).gatingBgCount
}

// ── Anchor rules ──

describe('foldLine — turn anchors', () => {
  it('real user line (array content) anchors: turnActive=true', () => {
    const s = fold([userEvent()])
    expect(s.sawAnchor).toBe(true)
    expect(s.turnActive).toBe(true)
  })

  it('real user line (string content) anchors', () => {
    const s = fold([userStringEvent()])
    expect(s.turnActive).toBe(true)
  })

  it('walnut-injected delivery marker anchors (plain-text FIFO send trace)', () => {
    const s = fold([walnutInjectedEvent()])
    expect(s.sawAnchor).toBe(true)
    expect(s.turnActive).toBe(true)
  })

  it('system/init anchors and clears a prior result (inc-1783644415695 shape)', () => {
    const s = fold([userEvent(), resultEvent(true), stateEvent('idle'), initEvent()])
    expect(s.lastResult).toBe(null)
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('tool_result echo does NOT anchor and does NOT clear a result', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle'), toolResultUserEvent()])
    // Settled turn stays settled; the echo is mid-turn noise, not a new turn.
    expect(s.lastResult).not.toBe(null)
    expect(s.turnActive).toBe(false)
  })

  it('inline subagent user line (parent_tool_use_id) does NOT anchor', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle'), subagentUserEvent('tu_task_1')])
    expect(s.lastResult).not.toBe(null)
    expect(s.turnActive).toBe(false)
  })

  it('real user line AFTER a settled result re-opens the turn and clears the result', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle'), userEvent('follow-up')])
    expect(s.lastResult).toBe(null)
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  // The `sawAnchor &&` half of the settle expression: without it, ANY stream
  // that merely lacks a result would report turnActive=true — including a
  // freshly-rebuilt fold over a file that holds no turn-start evidence at all
  // (mid-file rebuild base, bookkeeping-only tail). That would project a dead
  // quiet session as 'running' forever.
  it('NO anchor at all → turnActive stays false even with nothing to settle', () => {
    const s = fold([
      taskStarted('bg-orphan'), // gating bg task, no result: settled=false
      JSON.stringify({ type: 'stream_event', session_id: SID, event: { i: 1 } }),
      '{"type":"user","message":{"content":[{"ty', // torn fragment
    ])
    expect(s.sawAnchor).toBe(false)
    expect(s.lastResult).toBe(null)
    expect(s.turnActive).toBe(false)
    expect(gating(s)).toBe(1) // gate is open, yet no turn is claimed
    const snap = assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 7, exitCode: null })
    expect(snap.cliState).toBe('idle')
  })

  it('anchorless bookkeeping-only tail assembles idle; a later anchor flips it running', () => {
    const quiet = fold([stateEvent('idle'), taskDone('bg-x')])
    expect(quiet.sawAnchor).toBe(false)
    expect(quiet.turnActive).toBe(false)
    const line = userEvent('now a real turn')
    const active = foldLine(quiet, line, quiet.v + Buffer.byteLength(line, 'utf8') + 1)
    expect(active.sawAnchor).toBe(true)
    expect(active.turnActive).toBe(true)
  })
})

// ── result / idle / running ──

describe('foldLine — result and state transitions', () => {
  it('result without trailing idle does not settle (companion idle must arrive)', () => {
    const s = fold([userEvent(), resultEvent()])
    expect(s.lastResult).not.toBe(null)
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('result + trailing idle settles the turn', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle')])
    expect(s.trailingIdle).toBe(true)
    expect(s.turnActive).toBe(false)
  })

  it('idle BEFORE the result does not count as trailing (ordering matters)', () => {
    const s = fold([userEvent(), stateEvent('idle'), resultEvent()])
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('idle without any result does not set trailingIdle', () => {
    const s = fold([userEvent(), stateEvent('idle')])
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('state:running invalidates a prior result (new turn began)', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle'), stateEvent('running')])
    expect(s.lastResult).toBe(null)
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('state:running alone marks the turn active (marker-less legacy send trace)', () => {
    const s = fold([stateEvent('running')])
    expect(s.turnActive).toBe(true)
  })

  it('error result settles WITHOUT a companion idle (CLI may bail)', () => {
    const s = fold([userEvent(), resultEvent(true)])
    expect(s.lastResult?.isError).toBe(true)
    expect(s.turnActive).toBe(false)
  })

  it('notification-origin result is bookkeeping — never recorded, never settles', () => {
    const s = fold([userEvent(), notificationOriginResult(), stateEvent('idle')])
    expect(s.lastResult).toBe(null)
    expect(s.turnActive).toBe(true)
  })

  it('a fresh result resets trailingIdle (its own companion idle must still arrive)', () => {
    const s = fold([userEvent(), resultEvent(), stateEvent('idle'), stateEvent('running'), resultEvent()])
    expect(s.lastResult).not.toBe(null)
    expect(s.trailingIdle).toBe(false)
    expect(s.turnActive).toBe(true)
  })

  it('result endOffset carries the daemon v coordinate (lineEndV of the result line)', () => {
    const lines = [userEvent(), resultEvent(), stateEvent('idle')]
    const base = 1000
    const s = fold(lines, base)
    const expected = base
      + Buffer.byteLength(lines[0], 'utf8') + 1
      + Buffer.byteLength(lines[1], 'utf8') + 1
    expect(s.lastResult?.endOffset).toBe(expected)
    expect(s.lastResult?.numTurns).toBe(1)
  })

  it('requires_action is NOT folded (pendingCtrl joins in assembleSnapshot)', () => {
    const before = fold([userEvent()])
    const line = stateEvent('requires_action')
    const after = foldLine(before, line, before.v + Buffer.byteLength(line, 'utf8') + 1)
    expect({ ...after, v: 0 }).toEqual({ ...before, v: 0 })
    expect(after.v).toBeGreaterThan(before.v)
  })
})

// ── bg tasks ──

describe('foldLine — background task gating (#870 semantics)', () => {
  it('running bg task gates settle; terminal notification un-gates', () => {
    const held = fold([userEvent(), taskStarted('bg-A'), resultEvent(), stateEvent('idle')])
    expect(gating(held)).toBe(1)
    expect(held.turnActive).toBe(true)

    const drained = fold([userEvent(), taskStarted('bg-A'), resultEvent(), taskDone('bg-A'), stateEvent('idle')])
    expect(gating(drained)).toBe(0)
    expect(drained.turnActive).toBe(false)
  })

  it('terminal-is-terminal: a late task_started cannot revive a completed task', () => {
    const s = fold([userEvent(), taskStarted('bg-A'), taskDone('bg-A'), taskStarted('bg-A'), resultEvent(), stateEvent('idle')])
    expect(s.bgTasks['bg-A'].terminal).toBe(true)
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  it('terminal-is-terminal: task_progress after terminal keeps terminal', () => {
    const s = fold([userEvent(), taskStarted('bg-A'), taskUpdated('bg-A', { status: 'failed' }), taskProgress('bg-A')])
    expect(s.bgTasks['bg-A'].terminal).toBe(true)
  })

  it('task_updated with terminal status ends the task', () => {
    const s = fold([userEvent(), taskStarted('bg-A'), taskUpdated('bg-A', { status: 'stopped' }), resultEvent(), stateEvent('idle')])
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  // ── revival: task_updated / task_notification take their status VERBATIM ──
  // The stickiness above is scoped to task_started/task_progress. A patch or a
  // notification carrying a NON-terminal status after a terminal one revives
  // the task and re-gates the turn (session-reconcile.ts:331/:338).
  // Adjudicated 2026-08-05: premature settle is the unsafe direction.

  it('task_updated{running} REVIVES a completed task and re-gates the turn', () => {
    const s = fold([
      userEvent(), taskStarted('bg-A'),
      taskUpdated('bg-A', { status: 'completed' }),
      taskUpdated('bg-A', { status: 'running' }), // revival
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].terminal).toBe(false)
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('task_notification{running} REVIVES a completed task and re-gates the turn', () => {
    const s = fold([
      userEvent(), taskStarted('bg-A'),
      taskDone('bg-A'),               // terminal notification
      taskDone('bg-A', 'running'),    // revival via notification
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].terminal).toBe(false)
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('a revived task settles again on the next terminal status (both directions)', () => {
    const viaUpdated = fold([
      userEvent(), taskStarted('bg-A'), taskDone('bg-A'), taskUpdated('bg-A', { status: 'running' }),
      resultEvent(), stateEvent('idle'),
      taskUpdated('bg-A', { status: 'failed' }),
    ])
    expect(viaUpdated.bgTasks['bg-A'].terminal).toBe(true)
    expect(gating(viaUpdated)).toBe(0)
    expect(viaUpdated.turnActive).toBe(false)

    const viaNotification = fold([
      userEvent(), taskStarted('bg-A'), taskUpdated('bg-A', { status: 'completed' }), taskDone('bg-A', 'running'),
      resultEvent(), stateEvent('idle'),
      taskDone('bg-A'), // default status = 'completed'
    ])
    expect(viaNotification.bgTasks['bg-A'].terminal).toBe(true)
    expect(gating(viaNotification)).toBe(0)
    expect(viaNotification.turnActive).toBe(false)
  })

  it('task_updated WITHOUT a status field keeps the previous terminal flag (patch fallback)', () => {
    // No `status` key → nothing verbatim to take, so prev survives. This is the
    // `prev?.status` leg of the reference expression, distinct from revival.
    const s = fold([
      userEvent(), taskStarted('bg-A'), taskDone('bg-A'),
      taskUpdated('bg-A', { is_backgrounded: false }), // status-less patch
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].terminal).toBe(true)
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  it('revival does NOT clear sticky isBackgrounded (still un-gated)', () => {
    const s = fold([
      userEvent(), taskStarted('bg-A'), taskUpdated('bg-A', { is_backgrounded: true }),
      taskDone('bg-A'), taskUpdated('bg-A', { status: 'running' }),
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].terminal).toBe(false)
    expect(s.bgTasks['bg-A'].isBackgrounded).toBe(true)
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  it('sticky isBackgrounded: backgrounded task never gates again (INCIDENT D)', () => {
    const s = fold([
      userEvent(), taskStarted('bg-grep'), taskUpdated('bg-grep', { is_backgrounded: true }),
      taskUpdated('bg-grep', { status: 'running' }), // later patch WITHOUT the flag — stickiness under test
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-grep'].isBackgrounded).toBe(true)
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  it('late gating bg task re-opens a settled turn; terminal patch re-settles it', () => {
    const settled = fold([userEvent(), resultEvent(), stateEvent('idle')])
    expect(settled.turnActive).toBe(false)
    const reopened = fold([userEvent(), resultEvent(), stateEvent('idle'), taskStarted('bg-late')])
    expect(reopened.turnActive).toBe(true)
    const resettled = fold([
      userEvent(), resultEvent(), stateEvent('idle'), taskStarted('bg-late'),
      taskUpdated('bg-late', { status: 'completed' }),
    ])
    expect(resettled.turnActive).toBe(false)
  })

  it('background_tasks_changed level reconcile: omitted ever-listed task is absent-marked (excluded from gating)', () => {
    const s = fold([
      userEvent(),
      taskStarted('bg-A'), taskStarted('bg-B'),
      bgTasksChanged(['bg-A', 'bg-B']), // both listed → in the level universe
      bgTasksChanged(['bg-B']),         // bg-A omitted → terminal bookend lost → endedPerLevel
      taskDone('bg-B'),
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].endedPerLevel).toBe(true)
    expect(gating(s)).toBe(0)
    expect(s.turnActive).toBe(false)
  })

  it('level reconcile universe guard: a never-listed task is NOT absent-marked', () => {
    const s = fold([
      userEvent(),
      taskStarted('bg-sync'),    // e.g. a live sync subagent — never in any level payload
      bgTasksChanged(['bg-B']),  // bg-sync absent but outside the universe
      taskDone('bg-B'),
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-sync'].endedPerLevel).toBeUndefined()
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('level reconcile mark is reversible: re-listing clears endedPerLevel', () => {
    const s = fold([
      userEvent(),
      taskStarted('bg-A'), bgTasksChanged(['bg-A']),
      bgTasksChanged([]),        // absent-marked
      bgTasksChanged(['bg-A']),  // re-listed — the mark was wrong, task is alive
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].endedPerLevel).toBeUndefined()
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('level reconcile never touches a terminal task', () => {
    const s = fold([
      userEvent(),
      taskStarted('bg-A'), bgTasksChanged(['bg-A']), taskDone('bg-A'),
      bgTasksChanged([]),
    ])
    expect(s.bgTasks['bg-A'].terminal).toBe(true)
    expect(s.bgTasks['bg-A'].endedPerLevel).toBeUndefined()
  })

  it('level snapshot introduces a previously-unseen task as running', () => {
    const s = fold([userEvent(), bgTasksChanged(['bg-new']), resultEvent(), stateEvent('idle')])
    expect(s.bgTasks['bg-new']).toBeDefined()
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })
})

// ── C2: a real user anchor resets the bg/team universe (contract §2) ──
// Executed repro of the permanent cross-turn wedge this fixes: an orphan bg
// task (never terminal, never listed by a background_tasks_changed payload, so
// the level-reconcile universe guard can NEVER absent-mark it) kept the gate
// open forever. Without the reset, turn 4's clean result+idle cannot settle and
// EVERY future turn of the session reports running.

describe('foldLine — a real user anchor resets bgTasks / seenInLevel / teamActive', () => {
  it('turn-3 orphan bg task does NOT gate turn 4 (permanent cross-turn wedge)', () => {
    const s = fold([
      // turn 3: an orphan task starts and never gets a terminal bookend, and is
      // never listed at level (a live sync subagent shape).
      userEvent('turn 3'), taskStarted('bg-orphan'), resultEvent(), stateEvent('idle'),
      // turn 4: clean and complete.
      userEvent('turn 4'), resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-orphan'], 'the anchor must clear the pre-anchor bg map').toBeUndefined()
    expect(gating(s)).toBe(0)
    expect(s.turnActive, 'a never-bookended turn-3 task wedged turn 4 forever').toBe(false)
    expect(assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 9, exitCode: null }).cliState).toBe('idle')
  })

  it('reference agreement: the reference tail fold on the same content also says turnEnded', () => {
    // The adjudication anchor — foldSessionTail's window STARTS at the last real
    // user line, so pre-anchor bg state is invisible to it BY DESIGN. This is the
    // divergence the reset removes.
    const lines = [
      userEvent('turn 3'), taskStarted('bg-orphan'), resultEvent(), stateEvent('idle'),
      userEvent('turn 4'), resultEvent(), stateEvent('idle'),
    ]
    const tail = foldSessionTail(lines.join('\n'), 0)
    expect(tail.foundTurnAnchor).toBe(true)
    expect(tail.turnEnded).toBe(true)
    expect(fold(lines).turnActive).toBe(!tail.turnEnded)
  })

  it('an anchor also clears teamActive (a lost TeamDelete cannot wedge the next turn)', () => {
    const s = fold([
      userEvent('turn A'), teamCreate(), resultEvent(), stateEvent('idle'), // TeamDelete never arrives
      userEvent('turn B'), resultEvent(), stateEvent('idle'),
    ])
    expect(s.teamActive).toBe(false)
    expect(s.turnActive).toBe(false)
  })

  it('an anchor clears seenInLevel so a re-used task id starts outside the universe', () => {
    const s = fold([
      userEvent('turn A'), taskStarted('bg-A'), bgTasksChanged(['bg-A']), // bg-A joins the universe
      resultEvent(), stateEvent('idle'),
      userEvent('turn B'), taskStarted('bg-A'),  // same id, new turn
      bgTasksChanged([]),                        // absent — but the universe was reset
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A'].endedPerLevel,
      'a stale pre-anchor level universe absent-marked a fresh task').toBeUndefined()
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('a genuinely-running cross-turn bg task RE-ENTERS the fold on its next event (eventual re-gating)', () => {
    // The reset's safety argument: the gate self-heals within one event, whereas
    // the wedge never healed.
    const s = fold([
      userEvent('turn A'), taskStarted('bg-live'), resultEvent(), stateEvent('idle'),
      userEvent('turn B'), resultEvent(), stateEvent('idle'),
      taskProgress('bg-live'), // still alive → re-gates
    ])
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })

  it('init and state:running are anchor-EQUIVALENT but do NOT reset the universe', () => {
    // Auto-continuation / mid-turn re-activation is the SAME turn's work — the
    // running bg task must keep gating it.
    const viaInit = fold([userEvent(), taskStarted('bg-A'), resultEvent(), stateEvent('idle'), initEvent()])
    expect(viaInit.bgTasks['bg-A']).toBeDefined()
    expect(gating(viaInit)).toBe(1)
    expect(viaInit.turnActive).toBe(true)

    const viaRunning = fold([userEvent(), teamCreate(), resultEvent(), stateEvent('idle'), stateEvent('running')])
    expect(viaRunning.teamActive).toBe(true)
    expect(viaRunning.turnActive).toBe(true)
  })

  it('tool_result echoes and inline subagent user lines do NOT reset the universe', () => {
    const s = fold([
      userEvent(), taskStarted('bg-A'), teamCreate(),
      toolResultUserEvent(), subagentUserEvent('tu_x'),
      resultEvent(), stateEvent('idle'),
    ])
    expect(s.bgTasks['bg-A']).toBeDefined()
    expect(s.teamActive).toBe(true)
    expect(gating(s)).toBe(1)
    expect(s.turnActive).toBe(true)
  })
})

// ── team markers ──

describe('foldLine — team markers', () => {
  it('TeamCreate blocks settle; TeamDelete releases it', () => {
    const held = fold([userEvent(), teamCreate(), resultEvent(), stateEvent('idle')])
    expect(held.teamActive).toBe(true)
    expect(held.turnActive).toBe(true)

    const released = fold([userEvent(), teamCreate(), teamDelete(), resultEvent(), stateEvent('idle')])
    expect(released.teamActive).toBe(false)
    expect(released.turnActive).toBe(false)
  })

  it('late TeamDelete settles an already-folded result+idle', () => {
    const s = fold([userEvent(), teamCreate(), resultEvent(), stateEvent('idle'), teamDelete()])
    expect(s.turnActive).toBe(false)
  })
})

// ── v coordinate / unknown lines / purity ──

describe('foldLine — v coordinate and unknown lines', () => {
  it('unknown line types advance v only', () => {
    const before = fold([userEvent(), resultEvent()])
    const line = JSON.stringify({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta' } })
    const after = foldLine(before, line, before.v + Buffer.byteLength(line, 'utf8') + 1)
    expect({ ...after, v: 0 }).toEqual({ ...before, v: 0 })
    expect(after.v).toBe(before.v + Buffer.byteLength(line, 'utf8') + 1)
  })

  it('torn/unparseable line advances v only (belt-and-suspenders)', () => {
    const before = fold([userEvent()])
    const after = foldLine(before, '{"type":"user","message":{"content":[{"ty', before.v + 42)
    expect({ ...after, v: 0 }).toEqual({ ...before, v: 0 })
    expect(after.v).toBe(before.v + 42)
  })

  it('empty/whitespace line advances v only', () => {
    const before = fold([userEvent()])
    const after = foldLine(before, '   ', before.v + 4)
    expect(after.v).toBe(before.v + 4)
    expect(after.turnActive).toBe(before.turnActive)
  })

  it('v is monotonic: a stale lineEndV never regresses it', () => {
    const before = fold([userEvent(), resultEvent()])
    const after = foldLine(before, stateEvent('idle'), 1) // bogus low offset
    expect(after.v).toBe(before.v)
    expect(after.trailingIdle).toBe(true) // the line still folds
  })

  it('foldLine never mutates its input state', () => {
    const before = fold([userEvent(), taskStarted('bg-A')])
    const frozen = JSON.parse(JSON.stringify(before))
    foldLine(before, taskDone('bg-A'), before.v + 100)
    foldLine(before, resultEvent(), before.v + 200)
    expect(before).toEqual(frozen)
  })

  it('initialFoldState honors baseV; ignores non-positive/undefined', () => {
    expect(initialFoldState(500).v).toBe(500)
    expect(initialFoldState().v).toBe(0)
    expect(initialFoldState(0).v).toBe(0)
    expect(initialFoldState(-5).v).toBe(0)
  })

  it('foldLines v equals the true byte size for an unterminated (torn) tail', () => {
    const content = [userEvent(), resultEvent()].join('\n') + '\n' + '{"type":"system","subty'
    expect(foldLines(content).v).toBe(Buffer.byteLength(content, 'utf8'))
    // Newline-terminated content is unchanged (the +1 belongs to each segment).
    const whole = [userEvent(), resultEvent()].join('\n') + '\n'
    expect(foldLines(whole).v).toBe(Buffer.byteLength(whole, 'utf8'))
  })

  // ── P6: cheap substring prefilter before JSON.parse ──
  // A whale turn is ~99% stream_event deltas plus multi-KB tool_result lines;
  // parsing every one made the fold the tailer's dominant cost. Only lines that
  // CAN change state are parsed — `v` still advances for all the rest.
  it('a 1MB stream_event line advances v only, with no parse and no semantic change', () => {
    const before = fold([userEvent(), taskStarted('bg-A'), teamCreate()])
    const whale = JSON.stringify({
      type: 'stream_event', session_id: SID,
      event: { type: 'content_block_delta', delta: { text: 'x'.repeat(1024 * 1024) } },
    })
    const bytes = Buffer.byteLength(whale, 'utf8')
    const after = foldLine(before, whale, before.v + bytes + 1)
    expect({ ...after, v: 0 }).toEqual({ ...before, v: 0 })
    expect(after.v).toBe(before.v + bytes + 1)
  })

  it('does NOT call JSON.parse for a prefiltered line (the whole point of P6)', () => {
    // Behavioral proof, not a shape assertion: previously the fold parsed EVERY
    // tailer line, including the ~99% of a whale turn that is stream_event
    // deltas (the L2 task-state feed has always substring-prefiltered). Counting
    // JSON.parse calls is what makes removing the prefilter fail this test.
    const before = fold([userEvent()])
    const real = JSON.parse
    let calls = 0
    try {
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { calls++; return real(...args) }) as typeof JSON.parse
      const whale = JSON.stringify({ type: 'stream_event', event: { delta: { text: 'x'.repeat(200_000) } } })
      foldLine(before, whale, before.v + Buffer.byteLength(whale, 'utf8') + 1)
      expect(calls, 'foldLine parsed a line that cannot change fold state').toBe(0)
      // …and a state-bearing line IS still parsed.
      calls = 0
      foldLine(before, resultEvent(), before.v + 500)
      expect(calls, 'foldLine skipped a line that DOES change fold state').toBe(1)
    } finally {
      JSON.parse = real
    }
  })

  it('prefiltered line kinds all advance v only (stream_event, tool_use, control_*)', () => {
    const before = fold([userEvent()])
    const skippable = [
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta' } }),
      JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }),
      JSON.stringify({ type: 'control_response', response: { request_id: 'r1' } }),
      // An assistant line with NO team marker: prefiltered out, so a whale
      // tool_use payload is never parsed.
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    ]
    let s = before
    for (const l of skippable) s = foldLine(s, l, s.v + Buffer.byteLength(l, 'utf8') + 1)
    expect({ ...s, v: 0 }).toEqual({ ...before, v: 0 })
    expect(s.v).toBeGreaterThan(before.v)
  })

  it('prefilter still folds team markers hidden inside assistant tool_use lines', () => {
    // The needle list matches TeamCreate/TeamDelete BY NAME precisely because an
    // '"type":"assistant"' needle would match every assistant line and defeat
    // the filter. Dropping the name needles would silently lose team gating.
    const held = fold([userEvent(), teamCreate(), resultEvent(), stateEvent('idle')])
    expect(held.teamActive).toBe(true)
    expect(held.turnActive).toBe(true)
    const released = foldLine(held, teamDelete(), held.v + 100)
    expect(released.teamActive).toBe(false)
    expect(released.turnActive).toBe(false)
  })

  it('prefilter does not drop a non-compact-spaced line (falls through to the parse)', () => {
    // Only lines positively recognized as compact-typed JSON are skippable; an
    // oddly-spaced producer must still be folded, not silently ignored.
    const before = fold([userEvent(), resultEvent()])
    const spaced = '{"type": "system", "subtype": "session_state_changed", "state": "idle"}'
    const after = foldLine(before, spaced, before.v + Buffer.byteLength(spaced, 'utf8') + 1)
    expect(after.trailingIdle).toBe(true)
    expect(after.turnActive).toBe(false)
  })

  it('foldLines computes the same byte offsets as manual per-line folding', () => {
    const lines = [userEvent('multi-byte ✓ content'), resultEvent(), stateEvent('idle')]
    const batch = fold(lines, 10)
    let manual = initialFoldState(10)
    let v = 10
    for (const l of lines) {
      v += Buffer.byteLength(l, 'utf8') + 1
      manual = foldLine(manual, l, v)
    }
    expect(batch).toEqual(manual)
  })
})

// ── settle condition (the R1 rule, all four legs) ──

describe('foldLine — settle condition needs result + trailingIdle + gating 0 + no team', () => {
  it('all four legs → settled', () => {
    const s = fold([userEvent(), taskStarted('bg-A'), resultEvent(), taskDone('bg-A'), stateEvent('idle')])
    expect(s.turnActive).toBe(false)
  })
  it('missing result → active', () => {
    expect(fold([userEvent(), stateEvent('idle')]).turnActive).toBe(true)
  })
  it('missing trailingIdle → active', () => {
    expect(fold([userEvent(), resultEvent()]).turnActive).toBe(true)
  })
  it('gating bg task → active', () => {
    expect(fold([userEvent(), taskStarted('bg-A'), resultEvent(), stateEvent('idle')]).turnActive).toBe(true)
  })
  it('team active → active', () => {
    expect(fold([userEvent(), teamCreate(), resultEvent(), stateEvent('idle')]).turnActive).toBe(true)
  })

  // The adjudicated proof sequence (contract §2): a revival mid-stream must
  // keep the WHOLE turn open through the result + idle that follow it.
  it('proof sequence: revived bg task holds the turn open across result → idle', () => {
    const s = fold([
      userEvent(),
      taskStarted('T'),
      taskUpdated('T', { status: 'completed' }),
      taskUpdated('T', { status: 'running' }),
      resultEvent(),
      stateEvent('idle'),
    ])
    expect(s.turnActive).toBe(true)
    expect(gating(s)).toBe(1)
    expect(assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 3, exitCode: null }).cliState).toBe('running')
  })
})

// ── assembleSnapshot (pure part) ──

describe('assembleSnapshot — cliState derivation', () => {
  const settled = fold([userEvent(), resultEvent(), stateEvent('idle')])
  const active = fold([userEvent()])

  it('dead wins over everything', () => {
    const snap = assembleSnapshot({
      foldState: active, pendingCtrl: { requestId: 'r1' }, dead: true, pid: null, exitCode: 1,
    })
    expect(snap.cliState).toBe('dead')
    expect(snap.exitCode).toBe(1)
  })

  it('pendingCtrl → waiting (over running)', () => {
    const snap = assembleSnapshot({
      foldState: active, pendingCtrl: { requestId: 'r1', toolName: 'Bash', sinceTs: 123 },
      dead: false, pid: 42, exitCode: null,
    })
    expect(snap.cliState).toBe('waiting')
    expect(snap.pendingPermission).toEqual({ requestId: 'r1', toolName: 'Bash', sinceTs: 123 })
    expect(snap.turnActive).toBe(true)
  })

  it('turnActive → running', () => {
    const snap = assembleSnapshot({ foldState: active, pendingCtrl: null, dead: false, pid: 42, exitCode: null })
    expect(snap.cliState).toBe('running')
    expect(snap.pid).toBe(42)
  })

  it('settled → idle, lastResult carried with endOffset in v coordinate', () => {
    const snap = assembleSnapshot({ foldState: settled, pendingCtrl: null, dead: false, pid: 42, exitCode: null })
    expect(snap.cliState).toBe('idle')
    expect(snap.turnActive).toBe(false)
    expect(snap.lastResult?.isError).toBe(false)
    expect(typeof snap.lastResult?.endOffset).toBe('number')
    expect(snap.v).toBe(settled.v)
  })

  it('gatingBgCount excludes terminal, backgrounded, and endedPerLevel tasks', () => {
    const s = fold([
      userEvent(),
      taskStarted('gates'),                                     // gating
      taskStarted('done'), taskDone('done'),                    // terminal
      taskStarted('bg'), taskUpdated('bg', { is_backgrounded: true }), // backgrounded
      taskStarted('lost'), bgTasksChanged(['lost']), bgTasksChanged([]), // endedPerLevel
    ])
    const snap = assembleSnapshot({ foldState: s, pendingCtrl: null, dead: false, pid: 1, exitCode: null })
    expect(snap.gatingBgCount).toBe(1)
  })
})

// ── PROPERTY: reduce(foldLine) ≡ foldSessionTail verdict on the same content ──
//
// SCOPING NOTE (relaxed 2026-08-06 by the C2 anchor-reset adjudication):
// foldSessionTail backward-scans for the LAST real user line and folds ONLY what
// follows it — anything before that anchor (bg task starts, TeamCreate) is
// outside its window by design. foldLine now mirrors that window semantics: a
// real user anchor RESETS bgTasks/seenInLevel/teamActive (contract §2), so the
// two agree on MULTI-anchor content too, not just single-anchor content. The
// generator therefore emits 1-3 real-user/marker anchors per sequence (the old
// version could only put one at position 0). Still no `init` lines: init is
// anchor-EQUIVALENT for foldLine's sawAnchor but is NOT an anchor for
// foldSessionTail's backward scan, so an init-only sequence has no shared
// window. Init coverage lives in the unit tests above.
// VOCABULARY NOTE: the generator MUST be able to emit a NON-terminal status via
// task_updated/task_notification after a terminal one — that revival class is
// where the port originally diverged (an unwidened generator emitted only
// terminal statuses, so a wrong terminal-is-terminal on those two branches was
// invisible; the widened vocabulary found it in ~4% of sequences).
describe('property — batch foldLines matches foldSessionTail verdict (3000 seeded sequences)', () => {
  // mulberry32 — seeded PRNG, NO Math.random (deterministic CI).
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function generateSequence(rand: () => number): { lines: string[]; anchorCount: number } {
    const anchor = (): string =>
      rand() < 0.5 ? userEvent('turn start') : walnutInjectedEvent('go')
    const lines: string[] = [anchor()]
    // 1-3 real-user anchors per sequence (was: exactly one, at position 0).
    // Multi-anchor became testable once foldLine's anchor reset matched the
    // reference's window semantics — see the SCOPING NOTE above.
    let anchorsLeft = Math.floor(rand() * 3) // 0-2 extra anchors
    let anchorCount = 1
    const taskIds = ['bg-1', 'bg-2', 'bg-3']
    // Terminal AND non-terminal statuses, so any ordering (terminal → running,
    // running → terminal, status-less patch) is reachable.
    const statuses = ['completed', 'failed', 'stopped', 'cancelled', 'running', 'pending', 'queued']
    const n = 2 + Math.floor(rand() * 14)
    for (let i = 0; i < n; i++) {
      const roll = rand()
      const tid = taskIds[Math.floor(rand() * taskIds.length)]
      const st = statuses[Math.floor(rand() * statuses.length)]
      // Re-anchor anywhere mid-sequence (incl. as the very last line, which
      // leaves the reference an empty post-anchor window — a real shape).
      if (anchorsLeft > 0 && roll < 0.09) { lines.push(anchor()); anchorsLeft--; anchorCount++ }
      else if (roll < 0.13) lines.push(resultEvent(rand() < 0.25))
      else if (roll < 0.24) lines.push(stateEvent('idle'))
      else if (roll < 0.31) lines.push(stateEvent('running'))
      else if (roll < 0.38) lines.push(taskStarted(tid))
      else if (roll < 0.45) lines.push(taskDone(tid, st))                  // any status, incl. revival
      else if (roll < 0.49) lines.push(taskDone(tid))                      // default 'completed'
      else if (roll < 0.53) lines.push(taskUpdated(tid, { is_backgrounded: true }))
      else if (roll < 0.60) lines.push(taskUpdated(tid, { status: st }))   // any status, incl. revival
      else if (roll < 0.63) lines.push(taskUpdated(tid, {}))               // status-less patch (prev fallback)
      else if (roll < 0.67) lines.push(bgTasksChanged(taskIds.filter(() => rand() < 0.5)))
      else if (roll < 0.73) lines.push(toolResultUserEvent())
      else if (roll < 0.76) lines.push(subagentUserEvent('tu_sub'))
      else if (roll < 0.80) lines.push(teamCreate())
      else if (roll < 0.83) lines.push(teamDelete())
      else if (roll < 0.86) lines.push(notificationOriginResult())
      else if (roll < 0.92) lines.push(taskProgress(tid))
      else lines.push(JSON.stringify({ type: 'stream_event', session_id: SID, event: { i } }))
    }
    return { lines, anchorCount }
  }

  it('verdict fields agree on every generated sequence (multi-anchor included)', () => {
    const rand = mulberry32(0xC0FFEE) // fixed seed — reproducible
    let multiAnchorRuns = 0
    for (let run = 0; run < 3000; run++) {
      const { lines, anchorCount } = generateSequence(rand)
      if (anchorCount > 1) multiAnchorRuns++
      const content = lines.join('\n')
      const base = 1 + Math.floor(rand() * 10_000)

      const tail = foldSessionTail(content, base)
      const state = foldLines(content + '\n', base)
      const snap = assembleSnapshot({ foldState: state, pendingCtrl: null, dead: false, pid: 1, exitCode: null })
      const label = `run ${run} (${anchorCount} anchors): ${lines.map((l) => JSON.parse(l).subtype ?? JSON.parse(l).type).join(' → ')}`

      // turnActive ≡ NOT turnEnded. Both now fold the SAME window: the
      // reference's window starts at the last real user line, and foldLine's
      // anchor reset makes its retained state start there too.
      expect(tail.foundTurnAnchor, label).toBe(true)
      expect(snap.turnActive, label).toBe(!tail.turnEnded)
      // lastResult presence + isError + endOffset must match.
      expect(snap.lastResult === null, label).toBe(tail.lastResult === null)
      if (snap.lastResult && tail.lastResult) {
        expect(snap.lastResult.isError, label).toBe(tail.lastResult.isError)
        expect(snap.lastResult.endOffset, label).toBe(tail.lastResult.endOffset)
      }
      // Gating count + team flag must match.
      expect(snap.gatingBgCount, label).toBe(tail.gatingBgCount)
      expect(snap.teamActive, label).toBe(tail.teamActive)
    }
    // Guard against a silently-degenerate generator: if the re-anchor branch
    // stops firing, this suite quietly falls back to the old single-anchor
    // scope and the C2 semantics go unchecked.
    expect(multiAnchorRuns, 'generator produced no multi-anchor sequences').toBeGreaterThan(500)
  })
})
