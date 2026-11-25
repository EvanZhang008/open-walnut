/**
 * The class of the 2026-11-25 report ("the answer arrived in the chat, the thread still read as
 * working"; experiment threads_each_question): every path that stores a node's status answer at a
 * turn's end. Each goes through status-question.ts applyStatusAnswer, whose save hands the turn's
 * reply to the answered check (org/thread-answered-check.ts checkTurnAnswers) after the node's own
 * thread lines. Enumerated from the source, so a new way to store a turn's status answer fails here
 * until it is listed, and the check cannot drop out of the save or sit behind the ask's own condition.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** Every file that stores a turn's status answer, and how many calls it makes. */
const STORERS: Record<string, { calls: number; why: string }> = {
  'src/core/sessions/status-question.ts': { calls: 1, why: 'the status question asked at the turn end (askStatus)' },
  'src/core/session-hooks/builtins.ts': { calls: 1, why: 'the summary self-report, for an engine the question does not ask' },
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    return e.isDirectory() ? srcFiles(rel) : e.name.endsWith('.ts') ? [rel] : []
  })
}

const calls = (src: string, fn: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !l.includes(`function ${fn}(`) && new RegExp(`\\b${fn}\\(`).test(l)).length

describe('every stored turn-end status answer reaches the answered check', () => {
  it('every call of applyStatusAnswer( is listed', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const n = calls(read(f), 'applyStatusAnswer')
      if (n) found[f] = n
    }
    expect(found, 'a new place stores a turn\'s status answer: route it through applyStatusAnswer, or call checkTurnAnswers there, and list it here').toEqual(
      Object.fromEntries(Object.entries(STORERS).map(([f, v]) => [f, v.calls])),
    )
  })

  it('the save hands every turn end to the check, after the thread lines, for Main, the leads and tasks alike', () => {
    const src = read('src/core/sessions/status-question.ts')
    const save = src.slice(src.indexOf('async function saveStatusAnswer('), src.indexOf('export function statusQuestionPending('))
    const lines = save.indexOf('await applyThreadLines(')
    const check = save.indexOf('checkTurnAnswers(taskId, sessionId, turnEndedMs)')
    expect(lines).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(lines)
    const line = save.slice(save.lastIndexOf('\n', check), check)
    // Only a mid-turn answer (no turn ended) skips it; never the org-node condition of the ask's place.
    expect(line).toMatch(/if \(!opts\.midTurn\)/)
    expect(line).not.toMatch(/taskLike/)
  })
})
