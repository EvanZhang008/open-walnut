/**
 * Voice mode's stream reader (web/src/voice/stream-reader.ts): which parts of an
 * answer still streaming can be said now. Non-ASCII test data is written with \u
 * escapes (repo language rule).
 */
import { describe, expect, it } from 'vitest'
import { estimatedSeconds, StreamReader } from '../../../web/src/voice/stream-reader'

// "Got it, I will look." / "Tests passed!" / "Anything else?" in Chinese.
const ZH_1 = '\u597d\u7684\uff0c\u6211\u6765\u770b\u770b\u3002'
const ZH_2 = '\u6d4b\u8bd5\u901a\u8fc7\u4e86\uff01'
const ZH_3 = '\u8fd8\u6709\u522b\u7684\u5417\uff1f'

/** Feeds `text` one character at a time (the worst split), collecting what is released. */
function feedChars(r: StreamReader, msgId: string, text: string): string[] {
  const out: string[] = []
  for (const ch of text) out.push(...r.feed(msgId, ch))
  return out
}

describe('stream reader', () => {
  it('releases each English sentence once it is complete, the tail when the message closes', () => {
    const r = new StreamReader()
    expect(r.feed('m1', 'Got it. I will')).toEqual(['Got it.'])
    expect(r.feed('m1', ' check the build')).toEqual([])
    expect(r.feed('m1', '. Then')).toEqual(['I will check the build.'])
    expect(r.feed('m1', ' report')).toEqual([])
    expect(r.finish()).toEqual(['Then report'])
    expect(r.released).toBe(3)
  })

  it('a dot not followed by whitespace is not an end (versions, names)', () => {
    const r = new StreamReader()
    expect(feedChars(r, 'm', 'Version 2.5 is out. Read app.ts now.')).toEqual(['Version 2.5 is out.'])
    expect(r.finish()).toEqual(['Read app.ts now.'])
  })

  it('a sentence end split across increments waits for the next character', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'Done.')).toEqual([])
    expect(r.feed('m', ' Next')).toEqual(['Done.'])
    expect(r.feed('m', '?\n')).toEqual(['Next?'])
  })

  it('Chinese sentences end at their own marks at once, split anywhere', () => {
    const r = new StreamReader()
    const out = feedChars(r, 'm', `${ZH_1}${ZH_2}${ZH_3}`)
    expect(out).toEqual([ZH_1, ZH_2, ZH_3])
    expect(r.finish()).toEqual([])
  })

  it('a newline ends a line (list items, headings)', () => {
    const r = new StreamReader()
    expect(r.feed('m', '## Status\n- one thing\n- two')).toEqual(['## Status', '- one thing'])
    expect(r.finish()).toEqual(['- two'])
  })

  it('stops at a line holding only ---, records the cut, reads nothing after it', () => {
    const r = new StreamReader()
    const out = feedChars(r, 'm', 'All done. Two fixes.\n\n---\n\n## Detail\nMore text here. And more.')
    expect(out).toEqual(['All done.', 'Two fixes.'])
    expect(r.finish()).toEqual([])
    expect(r.cut).toBe(true)
  })

  it('a rule with nothing after it is not a cut; a rule that opens the message is not a rule', () => {
    const tail = new StreamReader()
    expect(tail.feed('m', 'Done.\n---')).toEqual(['Done.'])
    expect(tail.finish()).toEqual([])
    expect(tail.cut).toBe(false)
    const opens = new StreamReader()
    expect(opens.feed('m', '---\nHello there. ')).toEqual(['Hello there.'])
    expect(opens.cut).toBe(false)
  })

  it('a line that starts like a rule but is not one is read', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'First.\n--- not a rule. ')).toEqual(['First.', '--- not a rule.'])
  })

  it('skips fenced code, split mid-fence, and reads what follows it', () => {
    const r = new StreamReader()
    const out = feedChars(r, 'm', 'Run this:\n```ts\nconst x = 1. y = 2.\n```\nThen it works. ')
    expect(out).toEqual(['Run this:', 'Then it works.'])
    const tilde = new StreamReader()
    expect(feedChars(tilde, 'm', 'A.\n~~~\nx. y.\n~~~\nB. ')).toEqual(['A.', 'B.'])
  })

  it('an unclosed fence holds everything after its start', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'Here: ```\nnot read. ever. ')).toEqual(['Here:'])
    expect(r.feed('m', 'still code. ')).toEqual([])
    expect(r.finish()).toEqual([])
  })

  it('a single backtick at the end waits: it may open a fence', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'Look `')).toEqual([])
    expect(r.feed('m', '`')).toEqual([])
    expect(r.feed('m', '`\ncode. ')).toEqual(['Look'])
    // Inline code is not a fence: read with its words.
    const inline = new StreamReader()
    expect(inline.feed('m', 'Open `app.ts` now. ')).toEqual(['Open `app.ts` now.'])
  })

  it('two messages around a tool call: the first closes at the call, the second reads on', () => {
    const r = new StreamReader()
    expect(r.feed('a', 'Let me check the tests')).toEqual([])
    expect(r.closeOpen()).toEqual(['Let me check the tests'])
    expect(r.feed('b', 'They pass. ')).toEqual(['They pass.'])
    expect(r.finish()).toEqual([])
  })

  it('another message beginning closes the open one first', () => {
    const r = new StreamReader()
    r.feed('a', 'One moment')
    expect(r.feed('b', 'Here it is. ')).toEqual(['One moment', 'Here it is.'])
  })

  it('stops at the budget and records the cut', () => {
    const r = new StreamReader(3)
    // Each sentence is 4 words, 1.6 s.
    expect(r.feed('m', 'One two three four. Five six seven eight. Nine ten eleven twelve. ')).toEqual(['One two three four.'])
    expect(r.cut).toBe(true)
    expect(r.feed('m', 'More. ')).toEqual([])
    expect(r.closeOpen()).toEqual([])
    expect(r.feed('n', 'Another message. ')).toEqual([])
  })

  it('the first sentence goes even when it alone is longer than the budget', () => {
    const r = new StreamReader(1)
    expect(r.feed('m', 'A first sentence of many words. Next. ')).toEqual(['A first sentence of many words.'])
    expect(r.cut).toBe(true)
  })

  it('mute stops what is open and what comes next, until resume; the result says which', () => {
    const r = new StreamReader()
    expect(r.feed('a', 'First. Second')).toEqual(['First.'])
    const before = r.muteCount
    r.mute()
    expect(r.muteCount).toBe(before + 1)
    expect(r.feed('a', ' part. Third. ')).toEqual([])
    expect(r.feed('b', 'Also muted. ')).toEqual([])
    r.resume()
    expect(r.feed('c', 'Read again. ')).toEqual(['Read again.'])
    expect(r.outcome('Read again. ')).toBe('read')
    expect(r.outcome('Also muted.')).toBe('muted')
    expect(r.outcome('Never streamed.')).toBe('unseen')
  })

  it('a muted message with a rule is not a cut (nothing is said after it)', () => {
    const r = new StreamReader()
    r.feed('a', 'Hi.\n')
    r.mute()
    r.feed('a', '---\ndetail')
    expect(r.cut).toBe(false)
  })

  it('outcome matches the result by its words, whatever the spacing', () => {
    const r = new StreamReader()
    r.feed('a', 'Checking.')
    r.closeOpen()
    r.feed('b', 'All   good.\n\n---\nDetail')
    expect(r.outcome('All good.\n---\nDetail')).toBe('read')
    expect(r.allText()).toBe('Checking.\n\nAll   good.\n\n---\nDetail')
  })

  it('text that is only marks is not released', () => {
    const r = new StreamReader()
    expect(r.feed('m', '**\n> \n')).toEqual([])
    expect(r.released).toBe(0)
  })

  it('estimates seconds like the server', () => {
    expect(estimatedSeconds('one two three')).toBeCloseTo(1.2)
    expect(estimatedSeconds(ZH_2)).toBeCloseTo(1.25)
  })

  it('a list number at the start of a line is not a sentence end', () => {
    const r = new StreamReader()
    expect(feedChars(r, 'm', 'Steps:\n1. Open the file\n2. Save it.\n  10) Close it\n')).toEqual(['Steps:', '1. Open the file', '2. Save it.', '10) Close it'])
  })

  it('abbreviations are not sentence ends', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'Ask Dr. Lee, e.g. tomorrow, vs. today. Then go. ')).toEqual(['Ask Dr. Lee, e.g. tomorrow, vs. today.', 'Then go.'])
  })

  it('a closing quote or bracket goes with the sentence it closes, at once', () => {
    const r = new StreamReader()
    expect(r.feed('m', 'He said "done." Then (it worked.) Next')).toEqual(['He said "done."', 'Then (it worked.)'])
    // Its end shows only with the character after the closers.
    const wait = new StreamReader()
    expect(wait.feed('m', 'It said "ok."')).toEqual([])
    expect(wait.feed('m', ' More')).toEqual(['It said "ok."'])
  })

  it('a table row is never read, even with a sentence in it', () => {
    const r = new StreamReader()
    expect(feedChars(r, 'm', 'Results:\n| app.ts | Fails here. Then more. |\n|---|---|\nAll else passed. ')).toEqual(['Results:', 'All else passed.'])
  })

  it('a send during the turn marks which messages answer the older one', () => {
    const r = new StreamReader()
    r.feed('a', 'Old answer. ')
    r.markSend()
    r.markSend()
    expect(r.sendMark).toBe(1)
    r.feed('b', 'New answer. ')
    expect(r.match('Old answer.')).toEqual({ outcome: 'read', index: 0 })
    expect(r.match('New answer.')).toEqual({ outcome: 'read', index: 1 })
    expect(r.match('Other.')).toEqual({ outcome: 'unseen', index: -1 })
  })
})
