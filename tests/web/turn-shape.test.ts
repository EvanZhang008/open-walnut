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
