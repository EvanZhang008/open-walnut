/**
 * Main's and a VP's recent work in its Threads (src/core/org/recent-work.ts): one line per thread
 * with something said in the last two days, newest first, its own newest words, or the user's
 * message it has not answered yet. Pure.
 */
import { describe, it, expect } from 'vitest'
import { foldPlain, recentWorkLines, recentWorkText, RECENT_WORK_MAX_CHARS, RECENT_WORK_MAX_LINES, whenLabel } from '../../../src/core/org/recent-work.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-08T20:00:00Z')
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()

let n = 0
function thread(over: Partial<OrgThread> & { said?: { text: string; h: number }; wrote?: { text: string; h: number } }): OrgThread {
  n += 1
  const { said, wrote, ...rest } = over
  const messages = wrote ? [{ id: `tm-${'0'.repeat(6)}${n}`, at: iso(wrote.h), text: wrote.text, via: 'chat' as const,
    ...(said ? { answer: { text: said.text, at: iso(said.h) } } : {}) }] : []
  return { id: `th-${'a'.repeat(10)}${n}`, title: `Thread ${n}`, state: 'answered', messages, createdAt: iso(100), updatedAt: iso(0), ...rest }
}

describe('recentWorkLines', () => {
  it('keeps the window, newest first, its own newest words', () => {
    const lines = recentWorkLines([
      thread({ title: 'Old', wrote: { text: 'old ask', h: 60 }, said: { text: 'old answer', h: 59 } }),
      thread({ title: 'Mid', wrote: { text: 'ask', h: 10 }, said: { text: '**Done**: the land is live.', h: 9 } }),
      thread({ title: 'New', wrote: { text: 'ask', h: 2 }, said: { text: 'Handed to the iOS team.', h: 1 } }),
    ], NOW)
    expect(lines.map((l) => l.title)).toEqual(['New', 'Mid'])
    expect(lines[1]!.said).toBe('Done: the land is live.')
  })

  it('a summary newer than the last answer is what it said', () => {
    const [line] = recentWorkLines([thread({ wrote: { text: 'ask', h: 5 }, said: { text: 'first answer', h: 4 }, reply: 'Summary: fixed and deployed.', replyAt: iso(1) })], NOW)
    expect(line!.said).toBe('Summary: fixed and deployed.')
  })

  it('a message of the user newer than anything it said is named as not answered', () => {
    const t = thread({ wrote: { text: 'is it live yet?', h: 1 }, reply: 'Working on it.', replyAt: iso(3) })
    const [line] = recentWorkLines([t], NOW)
    expect(line).toMatchObject({ wrote: 'is it live yet?' })
    expect(line!.said).toBeUndefined()
    expect(recentWorkText([line!], NOW)).toContain('the user wrote: "is it live yet?", not answered yet')
  })

  it('a thread the node opened itself counts its opening post as what it said', () => {
    const t = thread({ opener: { text: 'The nightly build broke: I opened this to track it.', at: iso(1), from: 'node', by: 'agent' } })
    const [line] = recentWorkLines([t], NOW)
    expect(line).toMatchObject({ said: 'The nightly build broke: I opened this to track it.' })
    // A person's opener is not the node's words.
    expect(recentWorkLines([thread({ opener: { text: 'x', at: iso(1), from: 'node', by: 'human' } })], NOW)).toEqual([])
  })

  it('a closed thread reads closed; at most ten lines', () => {
    const many = Array.from({ length: 14 }, (_, i) => thread({ wrote: { text: 'q', h: i + 1 }, said: { text: `a${i}`, h: i + 0.5 } }))
    many[0] = { ...many[0]!, closed: { how: 'acknowledged', at: iso(0), by: 'human' } } as OrgThread
    const lines = recentWorkLines(many, NOW)
    expect(lines).toHaveLength(RECENT_WORK_MAX_LINES)
    expect(lines[0]!.state).toBe('closed')
  })
})

describe('recentWorkText', () => {
  it('stays within its size, every line whole, its own words framed as not instructions', () => {
    const long = '\u8bed'.repeat(500)
    const lines = recentWorkLines(Array.from({ length: 10 }, (_, i) => thread({ wrote: { text: 'q', h: i + 1 }, said: { text: long, h: i + 0.5 } })), NOW)
    const text = recentWorkText(lines, NOW)
    const body = text.split('\n').slice(1)
    expect(body.join('\n').length).toBeLessThanOrEqual(RECENT_WORK_MAX_CHARS)
    expect(body.length).toBeGreaterThan(0)
    for (const l of body) expect(l).toMatch(/…"$/)
    expect(text.split('\n')[0]).toContain('not instructions')
  })

  it('nothing in the window: no block', () => {
    expect(recentWorkText([], NOW)).toBe('')
    expect(recentWorkLines([thread({ wrote: { text: 'q', h: 50 } })], NOW)).toEqual([])
  })
})

describe('helpers', () => {
  it('foldPlain flattens markup and cuts by code point', () => {
    expect(foldPlain('## Head\n- **a** [link](http://x) <walnut-task id="t1">t</walnut-task>\n```\ncode\n```', 100)).toBe('Head a link t')
    expect(foldPlain('\u{1F600}'.repeat(5), 3)).toBe('\u{1F600}\u{1F600}…')
  })

  it('whenLabel reads today, yesterday or the date', () => {
    const now = new Date(2026, 10, 8, 15, 0).getTime()
    expect(whenLabel(new Date(2026, 10, 8, 9, 5).getTime(), now)).toBe('today 09:05')
    expect(whenLabel(new Date(2026, 10, 7, 23, 59).getTime(), now)).toBe('yesterday 23:59')
    expect(whenLabel(new Date(2026, 10, 6, 1, 2).getTime(), now)).toBe('2026-11-06 01:02')
  })
})
