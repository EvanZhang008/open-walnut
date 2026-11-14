/**
 * Every turn-end status derivation asks only what the turn that just ended asked
 * (src/core/sessions/turn-end-ask.ts; 2026-11-13: an agent-ack turn's report brought back a
 * three-day-old, answered ask).
 *
 * The class has three kinds of member, each enumerated from the source so a new one fails here
 * until it says what it is:
 *  - a writer of task.status_report: the turn-end writer (status-question.ts applyStatusAnswer)
 *    runs admitTurnEndAsk before it writes; any other writer is listed with why it is no turn-end
 *    derivation;
 *  - a reader of a turn-end report (readStatusReport, the FOR_USER_* parser): it stores what it
 *    reads only through applyStatusAnswer;
 *  - a part of a status question that names an ask from outside the turn: the task's own decision
 *    is named only while it stands (askDecisionQuestion returns '' for every other state).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { askDecisionQuestion } from '../../../src/core/ask-decision.js'
import type { StatusReport } from '../../../src/core/user-status.js'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : []
  })
}
const FILES = walk(SRC).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
/** The code of a file, its comments left out. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The turn-end writer, gated. */
const TURN_END_WRITER = 'src/core/sessions/status-question.ts'
/** Writers of task.status_report that derive nothing from a turn end, and why. */
const NOT_TURN_END: Record<string, string> = {
  'src/core/sessions/report-set.ts': 'task_report_set: an explicit call of the task, its lead or Main, with the words it gives now',
}
/** Readers of a turn-end report, each storing it only through applyStatusAnswer. */
const REPORT_READERS = ['src/core/sessions/status-question.ts', 'src/core/session-hooks/builtins.ts']

describe('every turn-end status derivation reads its ask from the turn that just ended', () => {
  it('every writer of task.status_report is the gated turn-end writer or says why it is none', () => {
    const writers = FILES.filter((f) => /(?<![.\w])status_report\s*:|[{,]\s*status_report\s*[,}]/.test(code(f.text))).map((f) => f.rel).sort()
    expect(writers).toEqual([TURN_END_WRITER, ...Object.keys(NOT_TURN_END)].sort())
  })

  it('the turn-end writer gates the ask before it writes', () => {
    const text = code(FILES.find((f) => f.rel === TURN_END_WRITER)!.text)
    const gate = text.indexOf('admitTurnEndAsk(')
    const write = text.search(/updateTaskRaw\(\s*taskId,\s*\{\s*status_report/)
    expect(gate).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(gate)
  })

  it('every reader of a turn-end report stores it only through applyStatusAnswer', () => {
    const readers = FILES.filter((f) => /\breadStatusReport\(/.test(code(f.text).replace(/export function readStatusReport\(/g, ''))).map((f) => f.rel).sort()
    expect(readers).toEqual([...REPORT_READERS].sort())
    for (const rel of REPORT_READERS) {
      const text = code(FILES.find((f) => f.rel === rel)!.text)
      expect(text, rel).toMatch(/applyStatusAnswer\(/)
      if (rel !== TURN_END_WRITER) expect(text, rel).not.toMatch(/(?<![.\w])status_report\s*:/)
    }
  })

  it('the status question names the task\'s own decision only while it stands', () => {
    const closed = { id: 'ask-abcdef', ask: 'Approve deleting the old log groups?', at: new Date().toISOString() }
    for (const state of ['working', 'waiting', 'done', 'read'] as const) {
      expect(askDecisionQuestion({ state, at: new Date().toISOString(), last_ask: closed } as StatusReport), state).toBe('')
    }
    expect(askDecisionQuestion({ state: 'needs', ask: closed.ask, ask_id: closed.id, at: closed.at } as StatusReport)).toContain(closed.id)
  })
})
