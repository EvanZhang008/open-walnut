/**
 * The phone's open-time landing decides on the transcript as opened (spec 4.5,
 * C69). Its window stays open two seconds while the loaded rows lay out, and a
 * reply streaming in those seconds used to count: the turn outgrew the screen
 * and the view jumped up, away from the live words, to the turn's start
 * (2026-11-03, phone-touch-scroll-while-streaming.spec.ts on CI: the view sat
 * 53 to 240px above the bottom before any touch).
 *
 * The second half guards the class: every place that moves a timeline with no
 * input of its own announces it as the reader's scroll (READER_SCROLL_EVENT),
 * which switches follow-bottom off. Each one is listed here with why it may;
 * a new one fails until it is listed, and a landing Walnut decides by itself
 * must go through phoneTurnStartStep.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  liveOutputSize, phoneTurnStartStep, PHONE_TURN_START_WINDOW_MS, type TurnStartLook,
} from '../../web/src/components/sessions/phone-turn-start'
import type { StreamingBlock } from '../../web/src/stream/stream-reducer'

const OPENED = { rows: 240, live: 0 }

function look(over: Partial<TurnStartLook> = {}): TurnStartLook {
  return {
    atBottom: true, elapsedMs: 100, opened: OPENED, now: OPENED, pendingPrompt: false,
    turnTop: 4000, scrollHeight: 5000, clientHeight: 330, ...over,
  }
}

describe('phoneTurnStartStep', () => {
  it('lands at the start of a turn taller than the screen, as opened', () => {
    expect(phoneTurnStartStep(look())).toEqual({ act: 'apply' })
  })

  it('waits while the turn still fits (its rows are laying out)', () => {
    expect(phoneTurnStartStep(look({ turnTop: 4800 }))).toEqual({ act: 'wait' })
    expect(phoneTurnStartStep(look({ turnTop: null }))).toEqual({ act: 'wait' })
  })

  it('stops for the reader, a pending prompt and the end of the window', () => {
    expect(phoneTurnStartStep(look({ atBottom: false }))).toEqual({ act: 'done', why: 'reader' })
    expect(phoneTurnStartStep(look({ pendingPrompt: true }))).toEqual({ act: 'done', why: 'prompt' })
    expect(phoneTurnStartStep(look({ elapsedMs: PHONE_TURN_START_WINDOW_MS + 1 }))).toEqual({ act: 'done', why: 'late' })
  })

  it('a session opened mid-reply follows the live words once they grow, and lands while they are still', () => {
    // Already streaming when the transcript first showed: what it held then is the open.
    const opened = { rows: 240, live: 300 }
    expect(phoneTurnStartStep(look({ opened, now: opened }))).toEqual({ act: 'apply' })
    expect(phoneTurnStartStep(look({ opened, now: { rows: 240, live: 340 } }))).toEqual({ act: 'done', why: 'arrived' })
  })

  it('never lands once anything arrived after the open, whatever else holds', () => {
    const arrivals = [
      { rows: 241, live: 0 }, // a persisted row
      { rows: 240, live: 1 }, // the first (even empty) streamed block
      { rows: 240, live: 400 }, // a reply streaming
      { rows: 239, live: 0 }, // rows replaced by fewer
    ]
    for (const now of arrivals) {
      for (const elapsedMs of [0, 60, 400, 1400, PHONE_TURN_START_WINDOW_MS]) {
        for (const turnTop of [0, 4000, 4800, null]) {
          const step = phoneTurnStartStep(look({ now, elapsedMs, turnTop }))
          expect(step, JSON.stringify({ now, elapsedMs, turnTop })).toEqual({ act: 'done', why: 'arrived' })
        }
      }
    }
  })
})

describe('liveOutputSize', () => {
  it('grows with every block and every streamed character', () => {
    const text = (content: string): StreamingBlock => ({ type: 'text', content } as StreamingBlock)
    expect(liveOutputSize([])).toBe(0)
    expect(liveOutputSize([text('')])).toBe(1)
    const a = liveOutputSize([text('Streamed sentence 1. ')])
    const b = liveOutputSize([text('Streamed sentence 1. Streamed sentence 2. ')])
    expect(b).toBeGreaterThan(a)
    const tool = { type: 'tool_call', toolUseId: 't', name: 'Bash', input: { command: 'ls' } } as unknown as StreamingBlock
    const done = { ...tool, result: 'a.ts' } as StreamingBlock
    expect(liveOutputSize([text('x'), done])).toBeGreaterThan(liveOutputSize([text('x'), tool]))
  })
})

/** Every move a timeline announces as the reader's, and why it may make one. */
const READER_SCROLLS: Record<string, string> = {
  'web/src/components/common/PageFind.tsx': 'the reader pressed find: the match is where they asked to go',
  'web/src/components/sessions/phone-session-layer.tsx': 'the reader tapped the bar title (C53)',
  'web/src/hooks/usePhoneRestore.ts': "a reload puts back the reader's own saved place",
  'web/src/components/sessions/SessionChatHistory.tsx': 'the open-time landing, decided by phoneTurnStartStep',
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('a timeline moves away from the bottom with no input only where listed', () => {
  const root = join(__dirname, '..', '..')
  const found = sources(join(root, 'web', 'src'))
    .filter((p) => /dispatchEvent\(new Event\(READER_SCROLL_EVENT\)\)/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(root, p).split('\\').join('/'))
    .sort()

  it('lists every place that announces a reader scroll', () => {
    expect(found).toEqual(Object.keys(READER_SCROLLS).sort())
  })

  it('the landing Walnut decides by itself goes through phoneTurnStartStep', () => {
    const src = readFileSync(join(root, 'web/src/components/sessions/SessionChatHistory.tsx'), 'utf8')
    const at = src.indexOf('dispatchEvent(new Event(READER_SCROLL_EVENT))')
    expect(src.split('dispatchEvent(new Event(READER_SCROLL_EVENT))').length - 1).toBe(1)
    // The decision sits in the same function, just above the move.
    const before = src.slice(Math.max(0, at - 2500), at)
    expect(before).toContain('phoneTurnStartStep(')
    expect(before).toContain('timelineContentNow.current')
  })
})
