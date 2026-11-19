/**
 * Turns split where the CLI began one on a hidden line (`opensTurn`), and a finished turn's
 * shape never depends on which path computed it.
 *
 * 2026-11-19, the user, of a lead's chat whose background agent woke it ten times for one
 * progress line each: "it sometime become this ... after few second turn back". With no turn
 * boundary between the wake-ups, the hour read as ONE turn: settled, nine lines folded as
 * "9 updates" before the last; while the reader watched a reply stream, the same lines showed
 * flat. Each wake-up is its own turn (the CLI's transcript says so), so each line is that
 * turn's answer, the same whether the session is quiet, streaming, or has more turns after it.
 *
 * The class guard: for every prefix of a session, the turns it has finished are shaped the
 * same as in the whole session, and the same while the next turn streams; and every turn
 * splitter reads the one start rule (turnStartsOf), so a new one cannot miss these starts.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { NO_ACTION_TAG, noActionRows, turnStartsOf } from '@/utils/turn-end-marker'
import { shapeTurns } from '@/utils/turn-shape'

type Row = Parameters<typeof shapeTurns>[0][number]
const person = (text = 'Go.'): Row => ({ role: 'user', text })
const said = (text: string, tools?: { name: string; isError?: boolean }[]): Row => ({ role: 'assistant', text, ...(tools ? { tools } : {}) })
/** The first row of a turn a hidden notification began. */
const woke = (row: Row): Row => ({ ...row, opensTurn: true })

function shapes(rows: Row[], streaming = false) {
  const clean = noActionRows(rows, streaming)
  return shapeTurns(rows, {
    isSent: (m) => !m.injected,
    isPerson: () => true,
    isCleanNoAction: (i) => clean.has(i),
    streaming,
  })
}
const brief = (rows: Row[], streaming = false) => shapes(rows, streaming).map((t) => [t.kind, t.start, t.answer])

// The reported session's shape (neutral text): an ask, its answer, tools a wake-up ran, then
// one progress line per wake-up, one of them only the no-action line.
const SESSION: Row[] = [
  person('Is the design right?'),
  said('Yes, the rules stay the same.'),
  woke(said('', [{ name: 'Bash' }])),
  said('', [{ name: 'Bash' }]),
  said('', [{ name: 'Agent' }]),
  said('Step one is done, starting step two.'),
  woke(said('PROGRESS 1')),
  woke(said('PROGRESS 2')),
  woke(said('PROGRESS 3')),
  woke(said(NO_ACTION_TAG)),
  woke(said('PROGRESS 4')),
  woke(said('PROGRESS 5')),
  woke(said('', [{ name: 'Read' }])),
  said('PROGRESS 6'),
]

describe('a turn a hidden notification began', () => {
  it('is its own turn: each progress line is its answer, the no-action one hidden', () => {
    expect(brief(SESSION)).toEqual([
      ['answered', 0, 1],
      ['answered', 2, 5],
      ['answered', 6, 6],
      ['answered', 7, 7],
      ['answered', 8, 8],
      ['hidden', 9, -1],
      ['answered', 10, 10],
      ['answered', 11, 11],
      ['answered', 12, 13],
    ])
  })

  it('without the mark the hour read as one turn (the reported bug)', () => {
    const unmarked = SESSION.map(({ opensTurn: _o, ...r }) => r)
    expect(brief(unmarked)).toEqual([['answered', 0, 13]])
  })

  it('right after a sent row, it is the turn that row opened', () => {
    expect(turnStartsOf([person(), woke(said('Answer.'))], (m) => !m.injected)).toEqual([{ at: 0, sent: true, from: 0 }])
    expect(brief([person(), woke(said('Answer.'))])).toEqual([['answered', 0, 1]])
  })

  it('starts a turn even after one that ended on a call or an error: the CLI began it, the one before was over', () => {
    const error: Row = { role: 'system', text: 'API Error', systemVariant: 'error' }
    expect(brief([person(), said('', [{ name: 'Bash' }]), woke(said('', [{ name: 'Read' }])), said('Done.')]))
      .toEqual([['open', 0, -1], ['answered', 2, 3]])
    // The error line stays the last word of its own turn (the chat shows it under that turn).
    expect(brief([person(), said('', [{ name: 'Bash' }]), error, woke(said('PROGRESS 1'))]))
      .toEqual([['open', 0, -1], ['answered', 3, 3]])
  })

  it('opens a window: its row is the turn start, keyed by itself, not the window head', () => {
    expect(brief([woke(said('PROGRESS 1')), woke(said('PROGRESS 2'))])).toEqual([['answered', 0, 0], ['answered', 1, 1]])
  })

  it('in a session with questions, starts a turn on its page even when its page\'s sent row is the row before it there', () => {
    // Read over the whole transcript, another page's row sits between them: a turn of its own.
    const rows: Row[] = [person('Main ask.'), said('Main answer.'), person('Question A?'), said('Main words.'), woke(said('PROGRESS qa'))]
    const pages = ['', '', 'qa', '', 'qa']
    const clean = noActionRows(rows, false)
    const paged = shapeTurns(rows, { isSent: (m) => !m.injected, isPerson: () => true, isCleanNoAction: (i) => clean.has(i), streaming: false, pageOf: (i) => pages[i] })
      .map((t) => [t.kind, t.start, t.answer])
    expect(paged).toContainEqual(['answered', 4, 4])
    expect(paged).toContainEqual(['answered', 0, 1])
  })

  it('a clean no-action line is found in it', () => {
    expect([...noActionRows(SESSION, false)]).toEqual([9])
  })
})

describe('a finished turn has one shape, whichever path computed it', () => {
  const key = (t: { start: number; end: number }) => `${t.start}:${t.end}`
  /** Shapes of the turns finished in `rows[0, n)`: every turn but the last. */
  const finished = (rows: Row[], n: number, streaming: boolean) => {
    const all = shapes(rows.slice(0, n), streaming)
    return new Map(all.slice(0, -1).map((t) => [key(t), [t.kind, t.answer]]))
  }
  for (const [name, rows] of [['the reported session', SESSION]] as const) {
    it(`${name}: quiet, streaming, or with later turns, its finished turns read the same`, () => {
      const whole = new Map(shapes(rows).map((t) => [key(t), [t.kind, t.answer]]))
      for (let n = 1; n <= rows.length; n++) {
        for (const streaming of [false, true]) {
          for (const [k, shape] of finished(rows, n, streaming)) {
            // A finished turn of a prefix ends where the next turn starts: the whole session has it too.
            expect(whole.get(k), `prefix ${n}, streaming ${streaming}, turn ${k}`).toEqual(shape)
          }
        }
      }
    })
  }
})

describe('every turn splitter reads the one start rule', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const files = (dir: string, ext: RegExp): string[] => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p, ext)
    return ext.test(f) ? [p] : []
  })
  it('every turn splitter finds its starts through the one rule', () => {
    // A turn splitter is code that chains a turn's segments by whether the one before ended
    // in an answer (`endsInAnswer`, the rule every splitter shares). Each one found in the
    // sources must take its starts from turnStartsOf (web, src) or turnStarts (phone), or it
    // misses the rows a hidden notification began and reads the hour as one turn again.
    const splitters = [
      ...files(path.join(ROOT, 'web/src'), /\.tsx?$/),
      ...files(path.join(ROOT, 'src'), /\.ts$/),
      ...files(path.join(ROOT, 'ios-native/Walnut'), /\.swift$/),
    ].filter((p) => /\bendsInAnswer\b/.test(readFileSync(p, 'utf8')))
    expect(splitters.map((p) => path.relative(ROOT, p)).sort()).toEqual([
      'ios-native/Walnut/Timeline/TimelineTurnShape.swift',
      'src/lib/turn-end-marker.ts',
      'web/src/utils/turn-shape.ts',
    ])
    for (const p of splitters) {
      expect(readFileSync(p, 'utf8'), path.relative(ROOT, p)).toMatch(/turnStartsOf\(|= turnStarts\(messages\)/)
    }
  })
  it('the phone shapes its turns through turnStarts, which reads opensTurn', () => {
    const swift = readFileSync(path.join(ROOT, 'ios-native/Walnut/Timeline/TimelineTurnShape.swift'), 'utf8')
    expect(swift).toMatch(/let bounds = turnStarts\(messages\)/)
    expect(swift).toMatch(/m\.opensTurn == true/)
  })
})
