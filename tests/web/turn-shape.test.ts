/**
 * Each finished turn's shape: hidden (something else started it and it ended
 * with the no-action line), answered (everything before the answer folds), open.
 */
import { describe, expect, it } from 'vitest'
import { NO_ACTION_TAG, noActionRows } from '@/utils/turn-end-marker'
import { shapeTurns } from '@/utils/turn-shape'

type Row = Parameters<typeof shapeTurns>[0][number]
const person = (text = 'Go.'): Row => ({ role: 'user', text })
const notice = (text = 'NOTICE'): Row => ({ role: 'user', text })
const said = (text: string, tools?: { name: string; isError?: boolean }[]): Row => ({ role: 'assistant', text, ...(tools ? { tools } : {}) })
const line = said(NO_ACTION_TAG)

function shapes(rows: Row[], streaming = false) {
  const clean = noActionRows(rows, false)
  return shapeTurns(rows, {
    isSent: (m) => !m.injected,
    isPerson: (m) => !m.text.startsWith('NOTICE'),
    isCleanNoAction: (i) => clean.has(i),
    streaming,
  }).map((t) => [t.kind, t.start, t.answer])
}

describe('shapeTurns', () => {
  it('a notice answered with the line alone is hidden; the person\'s turn shows its answer', () => {
    expect(shapes([person(), said('', [{ name: 'Read' }]), said('Here it is.'), notice(), said('', [{ name: 'Bash' }]), line]))
      .toEqual([['answered', 0, 2], ['hidden', 3, -1]])
  })

  it('a notice that drew a real answer is answered: its card folds, the answer shows', () => {
    expect(shapes([notice(), said('', [{ name: 'Bash' }]), said('You need to decide X.')])).toEqual([['answered', 0, 2]])
  })

  it('a person\'s turn that ended with the line shows its answer, the line ignored', () => {
    expect(shapes([person(), said(`Done.\n\n${NO_ACTION_TAG}`)])).toEqual([['answered', 0, 1]])
  })

  it('a failure, a turn ending in a tool call, or the live turn stays open', () => {
    expect(shapes([notice(), said('', [{ name: 'Bash', isError: true }]), line])).toEqual([['open', 0, -1]])
    expect(shapes([notice(), said('', [{ name: 'Bash' }])])).toEqual([['open', 0, -1]])
    expect(shapes([person(), said('Partial.')], true)).toEqual([['open', 0, -1]])
  })

  it('a delivery that came in mid-work belongs to the turn it interrupted', () => {
    expect(shapes([person(), said('', [{ name: 'Bash' }]), notice(), said('All done.')])).toEqual([['answered', 0, 3]])
  })

  it('a person\'s message always starts its own turn', () => {
    expect(shapes([notice(), said('', [{ name: 'Bash' }]), person(), said('Answer.')])).toEqual([['open', 0, -1], ['answered', 2, 3]])
  })

  it('a window that starts inside a turn shapes it from the first row', () => {
    expect(shapes([said('', [{ name: 'Read' }]), said('Result.'), notice(), line])).toEqual([['answered', -1, 1], ['hidden', 2, -1]])
  })
})

describe('shapeTurns per question (pageOf)', () => {
  // Rows of a session with questions: each row's page is the question it is filed under.
  const paged = (rows: Array<[Row, string]>, streaming = false) => {
    const list = rows.map(([r]) => r)
    const clean = noActionRows(list, false)
    return shapeTurns(list, {
      isSent: (m) => !m.injected,
      isPerson: (m) => !m.text.startsWith('NOTICE'),
      isCleanNoAction: (i) => clean.has(i),
      pageOf: (i) => rows[i][1],
      streaming,
    })
  }
  const answerOf = (shapes: ReturnType<typeof paged>, row: number) => shapes.find((t) => (t.rows ? t.rows.includes(row) : row >= Math.max(t.start, 0) && row < t.end))

  it('a reply cut into a part per question answers each question with its own part (the 2026-11-04 "An update")', () => {
    // Q1 asked; its turn loads a skill and runs tools; Q2 is sent mid-turn; one
    // reply answers both, cut into a Q1 part and a Q2 part (tagged-reply-split.ts).
    const shapes = paged([
      [person('Q1 limits?'), 'q1'],
      [said('', [{ name: 'Skill' }]), 'q1'],
      [{ role: 'user', text: 'Base directory for this skill: x', injected: true }, ''],
      [said('', [{ name: 'Bash' }]), ''],
      [person('Q2 what is it?'), 'q2'],
      [said('Answer to Q1.'), 'q1'],
      [said('Answer to Q2.'), 'q2'],
    ])
    const q1 = answerOf(shapes, 5)!
    expect(q1.kind).toBe('answered')
    expect(q1.answer).toBe(5)
    expect(q1.start).toBe(0)
    const q2 = answerOf(shapes, 6)!
    expect([q2.kind, q2.answer, q2.start]).toEqual(['answered', 6, 4])
  })

  it('shaped over the whole transcript, the same rows folded Q1\'s answer as narration (the bug this guards)', () => {
    const rows: Row[] = [person('Q1'), said('', [{ name: 'Skill' }]), person('Q2'), said('Answer to Q1.'), said('Answer to Q2.')]
    const whole = shapeTurns(rows, { isSent: () => true, isPerson: () => true, isCleanNoAction: () => false, streaming: false })
    // Q1's part (3) sits before the turn's answer (4): the fold rule hid it.
    expect(whole[whole.length - 1].answer).toBe(4)
  })

  it('a reply to a message the person typed is never before its own answer, in any question', () => {
    // Every row that is the last words under a person's question is that question's answer.
    const pages = ['', 'q1', 'q2', 'q1.1']
    for (let seed = 0; seed < 50; seed++) {
      const rows: Array<[Row, string]> = []
      let r = seed * 7 + 3
      const next = () => { r = (r * 1103515245 + 12345) % 2147483648; return r }
      for (let n = 0; n < 12; n++) {
        const page = pages[next() % pages.length]
        rows.push([person(`ask ${n}`), page])
        if (next() % 2) rows.push([said('', [{ name: 'Bash' }]), page])
        rows.push([said(`answer ${n}`), page])
      }
      const shapes = paged(rows)
      rows.forEach(([row, page], i) => {
        if (row.role !== 'assistant' || !row.text) return
        const laterSame = rows.slice(i + 1).find(([m, p]) => p === page)
        if (laterSame && laterSame[0].role === 'assistant') return
        const t = answerOf(shapes, i)!
        expect(t.kind, `seed ${seed} row ${i}`).toBe('answered')
        expect(t.answer, `seed ${seed} row ${i}`).toBe(i)
      })
    }
  })

  it('one page only: the same shapes as without pageOf', () => {
    const rows: Array<[Row, string]> = [[person(), ''], [said('', [{ name: 'Read' }]), ''], [said('Here.'), ''], [notice(), ''], [line, '']]
    expect(paged(rows).map((t) => [t.kind, t.start, t.answer])).toEqual([['answered', 0, 2], ['hidden', 3, -1]])
  })

  it('only the question holding the newest row stays open while live', () => {
    const shapes = paged([[person('Q1'), 'q1'], [said('A1.'), 'q1'], [person('Main'), ''], [said('Partial.'), '']], true)
    expect(answerOf(shapes, 1)!.kind).toBe('answered')
    expect(answerOf(shapes, 3)!.kind).toBe('open')
  })
})
