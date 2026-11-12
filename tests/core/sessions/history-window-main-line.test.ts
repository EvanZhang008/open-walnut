/**
 * Every window of a session's history that counts turns counts the MAIN
 * conversation's turns (lib/history-turn-window.ts mainLineRows).
 *
 * 2026-11-11 review: after about 12 follow-ups sent from an Ask here card, a
 * reopened session showed only the initial prompt, "Load earlier turns" and the
 * folded question: the first screen ("the last 10 turns") counted each
 * follow-up as a turn, on the server and in the web. The class: every place
 * that sizes a window by turns. Each is found by scanning src/ and web/src/ for
 * the window function and the turn test, and must either pass the main-line
 * filter on that line or be listed below with why it needs none.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { historyTurnWindowLimit, isQuestionTurnRow, mainLineRows, questionTurnIds } from '../../../src/lib/history-turn-window.js'
import { READY_VIEW_TURNS, readyViewTurns } from '../../../src/core/history-ready-view.js'

const ROOT = path.resolve(__dirname, '../../..')
const OWN = 'src/lib/history-turn-window.ts'

/** Lines that size a window by turns, with no question in them, and why. */
const NO_QUESTIONS: Record<string, string> = {
  'web/src/components/sessions/ChatEarlierBlock.tsx':
    'the earlier chat a new session carries (its rows only, no question anchors of this session)',
  'src/providers/history-ready-core.ts':
    'the ready view parsed on the session\'s host, which has no question anchors: the server asks it '
    + 'for ten turns plus one per question turn (history-ready-view.ts readyViewTurns, checked below) '
    + 'and re-slices its rows by the main line',
}

/** A line that counts turns names one of these: the main-line filter, or a test built on it. */
const MAIN_LINE = /mainLineRows\(|mainLineWindow|isMainTurn|\bonMain\b/

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('a turns window counts the main conversation', () => {
  it('every line that sizes a history window by turns passes the main-line filter, or is listed with why', () => {
    const found: Array<{ file: string; line: number; text: string }> = []
    for (const dir of ['src', 'web/src']) {
      for (const file of sources(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file)
        if (rel === OWN) continue
        readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
          // A call of the window, or the turn test handed to a paged read or a count.
          if (/historyTurnWindowLimit\(|\bearlierRows\(/.test(text) || /isText:\s*isHistoryUserTurn|filter\(isHistoryUserTurn\)/.test(text)) {
            found.push({ file: rel, line: i + 1, text })
          }
        })
      }
    }
    // The scan finds the three windows this class is about (the leader's
    // route, the host's own answer, the timeline), so it is not looking at nothing.
    const files = new Set(found.map((f) => f.file))
    for (const f of ['src/web/routes/sessions.ts', 'src/replica/host-history.ts', 'web/src/components/sessions/SessionChatHistory.tsx']) {
      expect(files, `the scan reaches ${f}`).toContain(f)
    }
    const bad = found.filter((f) => !NO_QUESTIONS[f.file] && !MAIN_LINE.test(f.text) && !MAIN_LINE.test(nextLine(f)))
    expect(bad.map((f) => `${f.file}:${f.line}: ${f.text.trim()}`)).toEqual([])
    for (const f of Object.keys(NO_QUESTIONS)) expect(files, `${f} is still a window (or drop it from the list)`).toContain(f)
  })

  it('a ready view asks its host for the main turns plus one per question turn, everywhere it asks', () => {
    expect(readyViewTurns({})).toBe(READY_VIEW_TURNS)
    const anchors = Array.from({ length: 12 }, (_, i) => ({ msgId: `q${i}`, parent: 'a1' }))
    expect(readyViewTurns({ threadAnchors: anchors as never })).toBe(READY_VIEW_TURNS + 12)
    const many = Array.from({ length: 300 }, (_, i) => ({ msgId: `q${i}`, parent: 'a1' }))
    expect(readyViewTurns({ threadAnchors: many as never })).toBe(100)
    // Every request of a ready view (or of its key) names its turns through readyViewTurns,
    // so a view built for the first paint and a key compared on reconnect are one view.
    const asks: string[] = []
    for (const file of sources(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
        if (/\bturns:\s*[^,}]*READY_VIEW_TURNS/.test(text)) asks.push(`${rel}:${i + 1}: ${text.trim()}`)
      })
    }
    expect(asks).toEqual([])
  })

  it('the filter: a question\'s turns (by the id it was sent under too) are not turns; without anchors every turn is', () => {
    const rows = [
      { role: 'user', text: 'main 1', msgId: 'u1' }, { role: 'assistant', text: 'a1', msgId: 'a1' },
      { role: 'user', text: 'card 1', msgId: 'q1' }, { role: 'assistant', text: 'c1', msgId: 'c1' },
      { role: 'user', text: 'card 2', msgId: 'queue-2', sourceUuid: 'q2' }, { role: 'assistant', text: 'c2', msgId: 'c2' },
    ]
    const anchors = [{ msgId: 'q1', parent: 'a1' }, { msgId: 'q2', parent: 'a1' }, { msgId: 'u1', parent: '' }]
    const ids = questionTurnIds(anchors)
    expect([...ids].sort()).toEqual(['q1', 'q2'])
    expect(rows.map((r) => isQuestionTurnRow(r, ids))).toEqual([false, false, true, false, true, false])
    expect(historyTurnWindowLimit(rows, 1, mainLineRows(rows, anchors))).toBe(6)
    expect(historyTurnWindowLimit(rows, 1, mainLineRows(rows, []))).toBe(2)
    expect(mainLineRows(rows, undefined)).toBeUndefined()
  })
})

/** The call's next line: a call split over two lines passes its filter there. */
function nextLine(f: { file: string; line: number }): string {
  return readFileSync(path.join(ROOT, f.file), 'utf8').split('\n')[f.line] ?? ''
}
