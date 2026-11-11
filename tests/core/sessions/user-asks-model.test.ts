/**
 * The record of the user's unanswered messages in a task's chat (src/core/sessions/user-asks-model.ts).
 * 2026-11-03: a worker answered his question with "I'll check first, then get back to you", two
 * compactions dropped it, and nothing in Walnut knew it was still owed.
 */
import { describe, it, expect } from 'vitest'
import {
  addAsk, applyOwed, asksToJudge, emptyUserAsks, JUDGE_MAX, OPEN_MAX, openAsks, OWED_STALE_MS, owedQuestionBlock,
  owedReadback, prune, readOwedLine, recentWordsReadback, RECENT_WORDS_MAX, RECENT_WORDS_MS, staleOwed, type UserAsksFile,
} from '../../../src/core/sessions/user-asks-model.js'

const T0 = Date.parse('2026-11-03T01:20:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function withAsks(n: number, startMs = T0, stepMs = 60_000): UserAsksFile {
  let f = emptyUserAsks('t1')
  for (let i = 0; i < n; i++) f = addAsk(f, { id: `ua-${String(i).padStart(4, '0')}`, at: iso(startMs + i * stepMs), text: `question ${i}`, via: 'chat' }).file
  return f
}

describe('the user asks a task owes', () => {
  it('a retry of one send, or the same words a moment later, is one ask; the same words later are two', () => {
    let f = emptyUserAsks('t1')
    f = addAsk(f, { id: 'ua-aaaa', at: iso(T0), text: 'Does the link carry the code?', via: 'chat', key: 'qm-1' }).file
    expect(addAsk(f, { id: 'ua-bbbb', at: iso(T0 + 90_000), text: 'other words', via: 'chat', key: 'qm-1' }).added).toBe(false)
    expect(addAsk(f, { id: 'ua-cccc', at: iso(T0 + 30_000), text: 'Does the link  carry the code?', via: 'chat' }).added).toBe(false)
    const later = addAsk(f, { id: 'ua-dddd', at: iso(T0 + 10 * 60_000), text: 'Does the link carry the code?', via: 'chat' })
    expect(later.added).toBe(true)
    expect(openAsks(later.file).map((a) => a.id)).toEqual(['ua-aaaa', 'ua-dddd'])
  })

  it('the status answer closes what it answered, keeps what it still owes, and leaves an ask it was not shown', () => {
    const f = withAsks(3)
    const shown = asksToJudge(f).slice(0, 2).map((a) => a.id)
    const answer = 'FOR_USER_STATE: working\nFOR_USER_NOW: checking\nFOR_USER_OWED: ua-0001'
    const owed = readOwedLine(answer)
    expect(owed).toEqual(new Set(['ua-0001']))
    const r = applyOwed(f, shown, owed, iso(T0 + 3_600_000))
    expect(r.closed).toEqual(['ua-0000'])
    const byId = Object.fromEntries(r.file.asks.map((a) => [a.id, a]))
    expect(byId['ua-0000']).toMatchObject({ state: 'closed', closedBy: 'report' })
    expect(byId['ua-0001']).toMatchObject({ state: 'open', owedAt: iso(T0 + 3_600_000) })
    expect(byId['ua-0002'].state).toBe('open')
    expect(byId['ua-0002'].owedAt).toBeUndefined()
  })

  it('"none" answers every ask shown; no FOR_USER_OWED line judges nothing', () => {
    const f = withAsks(2)
    const ids = f.asks.map((a) => a.id)
    expect(applyOwed(f, ids, readOwedLine('FOR_USER_OWED: none'), iso(T0)).closed).toEqual(ids)
    expect(readOwedLine('FOR_USER_STATE: done\nFOR_USER_NOW: shipped')).toBeNull()
    expect(applyOwed(f, ids, readOwedLine('FOR_USER_STATE: done'), iso(T0)).closed).toEqual([])
    expect(readOwedLine('**FOR_USER_OWED:** UA-0000, ua-0001.')).toEqual(new Set(['ua-0000', 'ua-0001']))
    // Ids on the lines below the label count, up to the next label.
    expect(readOwedLine('FOR_USER_OWED:\n- ua-0001\n- ua-0002\nFOR_USER_NEXT: ua-0009 later')).toEqual(new Set(['ua-0001', 'ua-0002']))
    // Neither ids nor none (the review's case): nothing is judged, nothing he waits on is closed.
    expect(readOwedLine('FOR_USER_OWED: the first one')).toBeNull()
    expect(readOwedLine('FOR_USER_OWED:\nFOR_USER_NEXT: x')).toBeNull()
    expect(applyOwed(f, ids, readOwedLine('FOR_USER_OWED: the first one'), iso(T0)).closed).toEqual([])
  })

  it('the question names his words with ids; at most JUDGE_MAX, the newest', () => {
    const f = withAsks(JUDGE_MAX + 3)
    const asks = asksToJudge(f)
    expect(asks).toHaveLength(JUDGE_MAX)
    expect(asks[asks.length - 1].text).toBe(`question ${JUDGE_MAX + 2}`)
    const block = owedQuestionBlock(asks, T0 + 3_600_000)
    expect(block).toContain(`[${asks[0].id}]`)
    expect(block).toMatch(/FOR_USER_OWED: /)
    expect(block).toMatch(/"I will check" and "on it" are still owed/)
    expect(owedQuestionBlock([], T0)).toBe('')
  })

  it('the readback quotes his words whole, oldest first, and stays within its room', () => {
    let f = emptyUserAsks('t1')
    f = addAsk(f, { id: 'ua-0001', at: iso(T0), text: 'Why does the QR code say "Can\'t scan it"? Only one link, please.', via: 'chat' }).file
    f = addAsk(f, { id: 'ua-0002', at: iso(T0 + 60_000), text: 'x'.repeat(1500), via: 'letter', about: 'Tunnel setup' }).file
    const text = owedReadback(openAsks(f), T0 + 7 * 3_600_000)
    expect(text.indexOf('QR code')).toBeLessThan(text.indexOf('answering your letter "Tunnel setup"'))
    expect(text).toContain('7 h ago (2026-11-03 01:20 UTC)')
    const many = withAsks(OPEN_MAX)
    for (const a of many.asks) a.text = 'y'.repeat(1200)
    const cut = owedReadback(openAsks(many), T0, 4_000)
    expect(cut.length).toBeLessThanOrEqual(4_100)
    expect(cut).toMatch(/and \d+ more: open_items lists them/)
  })

  it('stale means owed and older than OWED_STALE_MS; an ask never judged is not stale', () => {
    let f = withAsks(2)
    f = applyOwed(f, [f.asks[0].id], new Set([f.asks[0].id]), iso(T0 + 1000)).file
    expect(staleOwed(f, null, T0 + OWED_STALE_MS - 1)).toHaveLength(0)
    expect(staleOwed(f, null, T0 + OWED_STALE_MS + 1).map((a) => a.id)).toEqual([f.asks[0].id])
  })

  it('a week-old ask expires, the open cap expires the oldest, and closed asks are kept a few days only', () => {
    const f = withAsks(OPEN_MAX + 2)
    expect(openAsks(f)).toHaveLength(OPEN_MAX)
    expect(f.asks.filter((a) => a.closedBy === 'expired')).toHaveLength(2)
    const week = prune(f, T0 + 8 * 24 * 3_600_000)
    expect(openAsks(week)).toHaveLength(0)
    expect(prune(week, T0 + 12 * 24 * 3_600_000).asks).toHaveLength(0)
  })

  // 2026-11-03: twelve hours of the user's messages in one task, every one answered, were gone from
  // its context after three compactions; the owed readback had nothing to say about answered ones.
  it('after a compaction his recent words are read back, answered ones too: a night of them survives the prune', () => {
    let f = withAsks(48, T0, 15 * 60_000)
    f = { ...f, asks: f.asks.map((a) => ({ ...a, text: `${a.text} ${'about the list risk per version '.repeat(4)}` })) }
    f = applyOwed(f, f.asks.map((a) => a.id), new Set(['ua-0047']), iso(T0 + 48 * 15 * 60_000)).file
    f = prune(f, T0 + 13 * 3_600_000)
    expect(f.asks).toHaveLength(48)
    const now = T0 + 13 * 3_600_000
    const text = recentWordsReadback(f, now)
    expect(text).toContain('answered ones too')
    expect(text).toContain('"before"')
    // The open one is the owed readback's, not this one's.
    expect(text).not.toContain('"question 47 ')
    expect(text).toContain('"question 46 ')
    // Oldest first, in the room it has; what did not fit is counted.
    expect(text.indexOf('"question 45 ')).toBeLessThan(text.indexOf('"question 46 '))
    expect(text).not.toContain('"question 0 ')
    expect(text.length).toBeLessThanOrEqual(RECENT_WORDS_MAX + 80)
    expect(text).toMatch(/and \d+ earlier: task_history with before reads them/)
    expect(text).toContain('2026-11-03 12:5')
  })

  it('the recent-words readback quotes nothing older than its window, and nothing when there is nothing', () => {
    let f = withAsks(2)
    f = applyOwed(f, f.asks.map((a) => a.id), new Set(), iso(T0 + 60_000)).file
    expect(recentWordsReadback(f, T0 + RECENT_WORDS_MS + 2 * 60_000)).toBe('')
    expect(recentWordsReadback(emptyUserAsks('t1'), T0)).toBe('')
    expect(recentWordsReadback(withAsks(2), T0 + 60_000)).toBe('')
    const long = { ...f, asks: f.asks.map((a) => ({ ...a, text: 'z'.repeat(1900) })) }
    const cut = recentWordsReadback(long, T0 + 3_600_000)
    expect(cut).toContain('z'.repeat(160) + '...')
    expect(cut).not.toContain('z'.repeat(161))
  })
})
