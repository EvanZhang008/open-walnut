/**
 * The lines Walnut hides from a reply travel beside it, so a developer's chat can show them folded
 * (Settings > Advanced, `ui.show_hidden_lines`; 2026-11-25, the user asked for a developer switch
 * that shows what Walnut hides, on by default for him, off for everyone else, folded when shown).
 * src/lib/internal-lines.ts hiddenLinesOf / splitInternalLines.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hiddenLinesOf, splitInternalLines } from '../../src/lib/internal-lines.js'
import { stripTurnMarker, NO_ACTION_TAG } from '../../src/lib/turn-end-marker.js'
import { parseSessionMessages } from '../../src/core/history-parse.js'
import { shownAcpMessages } from '../../src/providers/acp-journal-projector.js'

const REPORT = ['Done, the fix is live.', '', 'FOR_USER_STATE: working', 'FOR_USER_NOW: tests run'].join('\n')

describe('hiddenLinesOf', () => {
  it('is empty when nothing is hidden', () => {
    expect(hiddenLinesOf('a\nb', 'a\nb')).toBe('')
    expect(hiddenLinesOf('', '')).toBe('')
  })
  it('names the lines taken off the end, without the blank line between', () => {
    expect(hiddenLinesOf(REPORT, 'Done, the fix is live.')).toBe('FOR_USER_STATE: working\nFOR_USER_NOW: tests run')
  })
  it('names lines taken from the start and the middle, in order', () => {
    expect(hiddenLinesOf('[Q2]\nOne\nX1\nTwo\nX2\nThree', 'One\nTwo\nThree')).toBe('[Q2]\nX1\nX2')
  })
  it('a line whose trailing space or \\r the hiding trimmed is not hidden', () => {
    expect(hiddenLinesOf('Done.  \r\nFOR_USER_STATE: working\r\n', 'Done.')).toBe('FOR_USER_STATE: working')
  })
  it('a line whose start alone was cut gives only that start, never its words again (review, 2026-11-25)', () => {
    expect(hiddenLinesOf('[v16908844] one\ntwo', 'one\ntwo')).toBe('[v16908844]')
    expect(hiddenLinesOf('[Q4]: Yes, the fix is live.\nMore.\nFOR_USER_STATE: working', 'Yes, the fix is live.\nMore.')).toBe('[Q4]:\nFOR_USER_STATE: working')
  })
  it('everything, when nothing is shown', () => {
    expect(hiddenLinesOf('A\nB', '')).toBe('A\nB')
  })
  it('a long rewrite in the middle still answers (compared by set past the table size)', () => {
    const shown = Array.from({ length: 600 }, (_, i) => `kept ${i}`)
    const raw = shown.flatMap((l, i) => (i % 2 ? [l] : [l, `hid ${i}`]))
    const out = hiddenLinesOf(raw.join('\n'), shown.join('\n')).split('\n')
    expect(out).toHaveLength(300)
    expect(out[0]).toBe('hid 0')
  })
  it('reads the turn-end marker the web view takes out', () => {
    const raw = `Nothing to do.\n${NO_ACTION_TAG}`
    expect(hiddenLinesOf(raw, stripTurnMarker(raw))).toBe(NO_ACTION_TAG)
  })
})

describe('every parse that hides Walnut\'s lines from a chat row keeps them beside it', () => {
  const base = { sessionId: 's-1', cwd: '/w', version: '2.1.0' }
  const viaHistory = (t: string) => {
    const jsonl = [
      { type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-11-25T01:00:00.000Z', ...base, message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: '2026-11-25T01:00:01.000Z', ...base, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: t }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    return parseSessionMessages(jsonl).filter((m) => m.role === 'assistant')[0]
  }
  const viaAcp = (t: string) => shownAcpMessages([{ role: 'assistant', text: t, timestamp: '2026-11-25T01:00:01.000Z' }])[0]
  for (const [name, parse] of [['the session history (history-parse.ts)', viaHistory], ['an ACP engine\'s history', viaAcp]] as const) {
    it(`${name}: the reply's words, and its status lines as hidden`, () => {
      const row = parse(REPORT)
      expect(row.text).toBe('Done, the fix is live.')
      expect(row.hidden).toBe('FOR_USER_STATE: working\nFOR_USER_NOW: tests run')
    })
    it(`${name}: no hidden field on a reply Walnut left whole`, () => {
      expect(parse('Just words.\nMore words.')).not.toHaveProperty('hidden')
    })
  }

  it('splitInternalLines leaves a whole reply as it is', () => {
    expect(splitInternalLines('plain')).toEqual({ text: 'plain' })
  })

  // The class: a new place that strips Walnut's lines off a stored chat row must use
  // splitInternalLines, or the developer's fold misses them there. Callers that never make a chat
  // row (a notification, a thread card's answer, a follow line, the web's own view) are listed.
  it('no chat-row parse calls stripInternalLines directly', () => {
    const NOT_A_CHAT_ROW = new Set([
      'src/lib/internal-lines.ts',
      'src/lib/turn-end-marker.ts', // the web's view: SessionMessage folds what it takes out itself
      'src/web/routes/quick-main-follow.ts', // a follow line's text
      'src/web/server.ts', // a subagent result's text
      'src/core/sessions/thread-takeaway.ts', // a thread card's answer
      'src/core/push-notification.ts', // a push preview
    ])
    const root = path.resolve(__dirname, '../..')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (rel.endsWith('.ts') && /\bstripInternalLines\(/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) callers.push(rel)
      }
    }
    walk('src')
    expect(callers.filter((f) => !NOT_A_CHAT_ROW.has(f))).toEqual([])
  })
})
