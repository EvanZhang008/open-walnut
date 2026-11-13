/**
 * ownWordsOf: the person's words in a message Walnut handed a session, for the
 * readers that name a session after it. 2026-10-30: an Ask Walnut chat on
 * OpenCode was titled "Walnut agent profile", read off the persona block an ACP
 * ask's first message opens with.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownWordsOf } from '../../../src/core/sessions/own-words.js'
import { buildAskProfilePrefix } from '../../../src/core/sessions/ask-profile-prefix.js'
import { renderHintBlock, composeHinted } from '../../../src/core/hints/hint-format.js'
import { CATCH_UP_BANNER_CLOSE, CATCH_UP_BANNER_OPEN } from '../../../src/core/chat-history.js'
import { composeAnchoredText, composeOrientedText, fileParentOf, ROOT_THREAD_KEY, threadKeyOf } from '../../../web/src/utils/thread-tree.js'

const ASK = 'fix the docx preview renderer'

describe('ownWordsOf', () => {
  it('an ACP ask: the agent profile in front', () => {
    expect(ownWordsOf(buildAskProfilePrefix({ systemPrompt: 'You are Walnut.\n[Skills]\n- walnut' }) + ASK)).toBe(ASK)
  })

  it('the session instructions an ACP engine reads as a hint, before or after the words', () => {
    const hint = renderHintBlock('session-context', 'You are a Walnut task session.')
    expect(ownWordsOf(`${hint}\n\n${buildAskProfilePrefix({ systemPrompt: 'P' })}${ASK}`)).toBe(ASK)
    expect(ownWordsOf(composeHinted(ASK, { before: [], after: [renderHintBlock('rich-output', 'Use markdown.')] }))).toBe(ASK)
  })

  it("a lane's conversation recap, and an attachment header", () => {
    expect(ownWordsOf(`${CATCH_UP_BANNER_OPEN}\n## Turns you have not seen\nUser: hi\n${CATCH_UP_BANNER_CLOSE}\n\n${ASK}`)).toBe(ASK)
    expect(ownWordsOf(`[Images attached by the user]\n- /tmp/a.png\n\n${ASK}`)).toBe(ASK)
  })

  it('nothing but Walnut additions is no words at all', () => {
    expect(ownWordsOf(buildAskProfilePrefix({ systemPrompt: 'P' }))).toBe('')
  })

  it('a reference reads as its label, never as markup', () => {
    expect(ownWordsOf('please read <task-ref id="t-1" label="Login button stays grey"/> first'))
      .toBe('please read Login button stays grey first')
    expect(ownWordsOf('see <session-ref id="s-1" label="the &quot;B&quot; plan"/> and <project-ref id="Walnut"/>'))
      .toBe('see the "B" plan and Walnut')
  })

  it("the person's own brackets and text are kept", () => {
    expect(ownWordsOf('[draft] rename the module, then [/draft] the docs')).toBe('[draft] rename the module, then [/draft] the docs')
    expect(ownWordsOf(ASK)).toBe(ASK)
  })
})

// Ratchet: every leading context block Walnut writes (each `[/Name]` terminator
// in src) comes off. A new block kind that this reader does not peel fails here.
describe('every context block Walnut writes comes off', () => {
  const root = path.resolve(__dirname, '../../../src')
  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/\[\/([A-Z][A-Za-z -]{2,40})\]/g)) names.add(m[1])
      }
    }
  }
  walk(root)
  names.delete('Name'); names.delete('Banner') // doc placeholders

  it('finds the block kinds', () => {
    expect([...names]).toEqual(expect.arrayContaining(['Walnut agent profile', 'Conversation context', 'Task Context']))
  })

  it.each([...names].sort().map((n) => [n]))('[%s]', (name) => {
    expect(ownWordsOf(`[${name}]\nwhat Walnut added\n[/${name}]\n\n${ASK}`)).toBe(ASK)
  })
})

// Ratchet: the readers that name a session from a message go through ownWordsOf.
describe('every session titler reads the person\'s words', () => {
  it.each([
    ['src/core/session-hooks/builtins.ts', /async function askAndApplyTitle[\s\S]{0,600}ownWordsOf\(message\)/],
    ['src/core/session-hooks/builtins.ts', /export async function autoTitleFromObservedMessage[\s\S]{0,1400}ownWordsOf\(rawMessage\)/],
    ['src/core/session-title-reconciler.ts', /function pickTitleSource[\s\S]{0,500}ownWordsOf\(t\)/],
    // A new task's title from its first words (quick-start), and the brief its refine reads.
    ['src/core/sessions/quick-start.ts', /export function titleFromWords[\s\S]{0,200}ownWordsOf\(message\)/],
    ['src/core/sessions/quick-start.ts', /const words = wordsTitle \? ownWordsOf\(message\) : ''/],
  ])('%s', (file, re) => {
    expect(re.test(fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8'))).toBe(true)
  })
})

// Ratchet: every framing the web composer can put in front of the words
// (composeOrientedText for the page, composeAnchoredText for a question, every
// anchor source, a file or a reply, a quote or none) comes off, so a session is
// never named after "(Back to the main conversation)" or a file's About line
// (2026-11-09).
describe('the framing the composer adds comes off', () => {
  const titles = ['Paragraph 003: this passage', 'a (parenthesised) title', '\u65b0\u7684\u95ee\u9898']
  const orient: Array<{ latestKey: string; currentKey: string }> = [
    { latestKey: 'q1', currentKey: ROOT_THREAD_KEY },
    { latestKey: ROOT_THREAD_KEY, currentKey: 'q1' },
    { latestKey: 'q2', currentKey: 'q1' },
    { latestKey: 'q1', currentKey: 'q1' },
  ]
  for (const title of titles) {
    for (const c of orient) {
      it(`page: latest ${c.latestKey || 'root'}, writing on ${c.currentKey || 'root'}, title ${JSON.stringify(title)}`, () => {
        expect(ownWordsOf(composeOrientedText(ASK, { ...c, titleOfKey: () => title }))).toBe(ASK)
      })
    }
  }

  const parents = ['reply-1', fileParentOf('/home/alice/Documents/Project-001/preview.md')]
  const quotes = [undefined, { exact: 'Paragraph 028: this passage\n\nis selected' }]
  const sources = ['selection', 'sticky', 'manual'] as const
  for (const parent of parents) {
    for (const quote of quotes) {
      for (const source of sources) {
        for (const latest of ['other-thread', 'this-thread']) {
          it(`question: ${parent.startsWith('file:') ? 'file' : 'reply'}, ${quote ? 'quote' : 'no quote'}, ${source}, ${latest}`, () => {
            const anchor = { parent, quote, line: parent.startsWith('file:') ? 57 : undefined, source, label: 'Paragraph 028' }
            const latestKey = latest === 'this-thread' ? threadKeyOf(anchor) : 'other-thread'
            const sent = composeAnchoredText(ASK, anchor, latestKey)
            expect(ownWordsOf(sent)).toBe(ASK)
            // Both together, as a question sent from a page the newest turn is not on.
            expect(ownWordsOf(composeOrientedText(sent, { latestKey: 'q9', currentKey: ROOT_THREAD_KEY, titleOfKey: () => 'x' }))).toBe(ASK)
          })
        }
      }
    }
  }

  it("the person's own parenthesised opening line and a quote with nothing after it are kept", () => {
    expect(ownWordsOf('(Back to it later) fix the renderer')).toBe('(Back to it later) fix the renderer')
    expect(ownWordsOf('> a line I want to keep')).toBe('> a line I want to keep')
  })
})
