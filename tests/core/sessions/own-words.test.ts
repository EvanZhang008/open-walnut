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
  ])('%s', (file, re) => {
    expect(re.test(fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8'))).toBe(true)
  })
})
