/**
 * Self-containedness tests for daemon-fold.ts — contract §6.3
 * (docs/plan/session-snapshot-source-of-truth.md).
 *
 * getDaemonSource() injects foldLine/initialFoldState/assembleSnapshot into
 * the daemon source template TEXTUALLY via fn.toString(). If a function ever
 * captures module scope (an import, a top-level const, or a bundler helper
 * like __name), the injected copy throws ReferenceError inside the daemon —
 * on a REMOTE host, at runtime. These tests catch that at commit time by
 * reconstructing each function with `new Function('return ' + fn.toString())()`
 * and replaying the entire golden set + a unit-case sample through the copies.
 *
 * foldLines is deliberately NOT injectable (it calls the sibling exports) —
 * see the module header; it is excluded from the toString round-trip.
 */

import { describe, it, expect } from 'vitest'
import {
  initialFoldState,
  foldLine,
  assembleSnapshot,
  type FoldState,
} from '../../src/providers/daemon-fold.js'

// ── Reconstructed copies (the daemon-template view of the functions) ──

type InitialFoldStateFn = typeof initialFoldState
type FoldLineFn = typeof foldLine
type AssembleSnapshotFn = typeof assembleSnapshot

function reconstruct<T>(fn: { toString(): string }): T {
  // '"use strict"' matches the daemon template, which is emitted as a strict
  // module — a sloppy-mode-only construct (implicit global, octal literal,
  // duplicate param) would pass a non-strict reconstruction here and only blow
  // up on the remote host. Keep the directive.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('"use strict"; return ' + fn.toString())() as T
}

const initialFoldState2 = reconstruct<InitialFoldStateFn>(initialFoldState)
const foldLine2 = reconstruct<FoldLineFn>(foldLine)
const assembleSnapshot2 = reconstruct<AssembleSnapshotFn>(assembleSnapshot)

// Batch-fold through a given foldLine/initialFoldState pair (reimplemented
// here so the reconstructed copies are exercised without foldLines).
function foldWith(
  init: InitialFoldStateFn,
  fl: FoldLineFn,
  lines: string[],
  baseV = 0,
): FoldState {
  let state = init(baseV)
  let v = state.v
  for (const line of lines) {
    v += Buffer.byteLength(line, 'utf8') + 1
    state = fl(state, line, v)
  }
  return state
}

// ── Synthetic fixtures (same shapes as the golden set) ──

const SID = 'inj-sid'
function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SID, ...obj })
}
const userLine = (text = 'start the demo turn') =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const markerLine = (text = 'queued follow-up') =>
  line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: text } })
const toolResultLine = () =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
const subagentLine = () =>
  line({ type: 'user', parent_tool_use_id: 'tu_sub', message: { role: 'user', content: [{ type: 'text', text: 'sub prompt' }] } })
const resultLine = (isError = false) =>
  line({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, num_turns: 2, result: 'done' })
const notifResultLine = () =>
  line({ type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' } })
const stateLine = (state: string) => line({ type: 'system', subtype: 'session_state_changed', state })
const initLine = () => line({ type: 'system', subtype: 'init', cwd: '/tmp/demo' })
const taskStartLine = (id: string) => line({ type: 'system', subtype: 'task_started', task_id: id })
const taskProgressLine = (id: string) => line({ type: 'system', subtype: 'task_progress', task_id: id })
const taskUpdatedLine = (id: string, patch: Record<string, unknown>) =>
  line({ type: 'system', subtype: 'task_updated', task_id: id, patch })
const taskDoneLine = (id: string) => line({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' })
/** No `status` field — exercises the `?? 'completed'` default branch. */
const taskNotifyNoStatusLine = (id: string) => line({ type: 'system', subtype: 'task_notification', task_id: id })
const bgChangedLine = (ids: string[]) =>
  line({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id })) })
const teamLine = (name: 'TeamCreate' | 'TeamDelete') =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] } })
const assistantFlood = () =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } })

// Golden set (mirrors daemon-fold-golden.test.ts shapes) + unit-case sample.
const CASES: { name: string; lines: string[]; baseV: number }[] = [
  { name: 'queued-send race', lines: [userLine(), resultLine(), stateLine('idle'), markerLine(), stateLine('running')], baseV: 0 },
  { name: 'requires_action pause (fold sees running only)', lines: [userLine(), stateLine('running')], baseV: 7 },
  { name: 'restart-in-result-window', lines: [initLine(), userLine(), resultLine(), stateLine('idle')], baseV: 100 },
  {
    name: 'whale turn',
    lines: [initLine(), userLine(), ...Array.from({ length: 100 }, assistantFlood), resultLine(), stateLine('idle')],
    baseV: 0,
  },
  {
    name: 'bg-gating hold then terminal',
    lines: [userLine(), taskStartLine('bg-w'), resultLine(), stateLine('idle'), taskUpdatedLine('bg-w', { status: 'completed' })],
    baseV: 0,
  },
  { name: 'error result', lines: [userLine(), resultLine(true)], baseV: 55 },
  { name: 'anchor kinds: string content', lines: [line({ type: 'user', message: { content: 'plain' } })], baseV: 0 },
  { name: 'tool_result echo rejected', lines: [userLine(), resultLine(), stateLine('idle'), toolResultLine()], baseV: 0 },
  { name: 'subagent line rejected', lines: [userLine(), resultLine(), stateLine('idle'), subagentLine()], baseV: 0 },
  { name: 'running invalidates result', lines: [userLine(), resultLine(), stateLine('idle'), stateLine('running')], baseV: 0 },
  { name: 'init invalidates result', lines: [userLine(), resultLine(true), initLine()], baseV: 0 },
  { name: 'idle before result not trailing', lines: [userLine(), stateLine('idle'), resultLine()], baseV: 0 },
  { name: 'notification-origin result skipped', lines: [userLine(), notifResultLine(), stateLine('idle')], baseV: 0 },
  { name: 'terminal-is-terminal', lines: [userLine(), taskStartLine('a'), taskDoneLine('a'), taskStartLine('a'), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'task_progress keeps terminal', lines: [userLine(), taskStartLine('a'), taskProgressLine('a'), taskDoneLine('a'), taskProgressLine('a'), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'task_notification without status defaults to completed', lines: [userLine(), taskStartLine('a'), taskNotifyNoStatusLine('a'), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'revival: non-terminal status re-gates (task_updated + task_notification)', lines: [userLine(), taskStartLine('a'), taskDoneLine('a'), taskUpdatedLine('a', { status: 'running' }), taskStartLine('b'), taskDoneLine('b'), line({ type: 'system', subtype: 'task_notification', task_id: 'b', status: 'running' }), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'status-less patch keeps prev terminal', lines: [userLine(), taskStartLine('a'), taskDoneLine('a'), taskUpdatedLine('a', {}), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'sticky isBackgrounded', lines: [userLine(), taskStartLine('a'), taskUpdatedLine('a', { is_backgrounded: true }), taskUpdatedLine('a', {}), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'level reconcile absent-mark', lines: [userLine(), taskStartLine('a'), bgChangedLine(['a']), bgChangedLine([]), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'level reconcile universe guard', lines: [userLine(), taskStartLine('a'), bgChangedLine(['b']), resultLine(), stateLine('idle')], baseV: 0 },
  { name: 'team hold + release', lines: [userLine(), teamLine('TeamCreate'), resultLine(), stateLine('idle'), teamLine('TeamDelete')], baseV: 0 },
  { name: 'torn line', lines: [userLine(), '{"type":"user","mess'], baseV: 3 },
  { name: 'unknown lines', lines: [userLine(), line({ type: 'stream_event', event: {} }), line({ type: 'control_response' })], baseV: 0 },
]

describe('injection — reconstructed functions replay the golden set identically', () => {
  for (const c of CASES) {
    it(`case: ${c.name}`, () => {
      const original = foldWith(initialFoldState, foldLine, c.lines, c.baseV)
      const copy = foldWith(initialFoldState2, foldLine2, c.lines, c.baseV)
      expect(copy).toEqual(original)

      // assembleSnapshot round-trip on the same fold, across ctrl/dead variants.
      const variants: Parameters<AssembleSnapshotFn>[0][] = [
        { foldState: original, pendingCtrl: null, dead: false, pid: 11, exitCode: null },
        { foldState: original, pendingCtrl: { requestId: 'r1', toolName: 'Bash', sinceTs: 5 }, dead: false, pid: 11, exitCode: null },
        // Bare requestId: exercises BOTH conditional-spread branches (toolName
        // and sinceTs absent) inside the reconstructed copy.
        { foldState: original, pendingCtrl: { requestId: 'r-bare' }, dead: false, pid: 11, exitCode: null },
        { foldState: original, pendingCtrl: { requestId: 'r-tool-only', toolName: 'Read' }, dead: false, pid: 11, exitCode: null },
        { foldState: original, pendingCtrl: null, dead: true, pid: null, exitCode: 1 },
      ]
      for (const v of variants) {
        expect(assembleSnapshot2(v)).toEqual(assembleSnapshot(v))
      }
    })
  }

  it('interleaved: alternating original/copy foldLine on the same evolving state agree', () => {
    // The reducer contract means the two implementations must be freely
    // interchangeable mid-stream — exactly what a daemon-template injection is.
    const lines = CASES.flatMap((c) => c.lines)
    let a = initialFoldState(0)
    let b = initialFoldState2(0)
    let v = 0
    lines.forEach((l, i) => {
      v += Buffer.byteLength(l, 'utf8') + 1
      a = (i % 2 === 0 ? foldLine : foldLine2)(a, l, v)
      b = (i % 2 === 1 ? foldLine : foldLine2)(b, l, v)
    })
    expect(b).toEqual(a)
  })
})

describe('injection — toString carries no module-scope identifiers', () => {
  // Bundler helpers (esbuild/tsup inject these at module scope when a class
  // field or named function expression is used) and common module-scope
  // escapes. Any hit = the injected copy would ReferenceError in the daemon.
  const FORBIDDEN = [
    /\b__name\b/,
    /\b__publicField\b/,
    /\b__defProp\b/,
    /\b__commonJS\b/,
    /\b__toESM\b/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /\bexports\./,
    /\bmodule\.exports\b/,
  ]

  for (const [name, fn] of Object.entries({ initialFoldState, foldLine, assembleSnapshot })) {
    it(`${name}.toString() is clean and reconstructable`, () => {
      const src = fn.toString()
      for (const re of FORBIDDEN) {
        expect(src, `${name} contains forbidden pattern ${re}`).not.toMatch(re)
      }
      // The reconstruction itself must not throw (deploy-time validation shape).
      expect(() => reconstruct<unknown>(fn)).not.toThrow()
    })
  }

  it('reconstructed foldLine works in a scope with no ambient bindings (smoke fold)', () => {
    // Same smoke check getDaemonSource() will run at deploy time.
    const fl = reconstruct<FoldLineFn>(foldLine)
    const init = reconstruct<InitialFoldStateFn>(initialFoldState)
    const l = JSON.stringify({ type: 'user', message: { content: 'smoke' } })
    const out = fl(init(0), l, l.length + 1)
    expect(out.turnActive).toBe(true)
    expect(out.v).toBe(l.length + 1)
  })
})
