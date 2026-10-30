/**
 * The mock ACP agent echoes the person's words only (tests/providers/mock-user-words.mjs).
 * Every hint kind Walnut can put on a message, composed by the real composer, comes
 * off the same way the display takes it off (parseHinted). The kinds are read from
 * the source, so a new hint kind is checked without editing this file.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { composeHinted, parseHinted, renderHintBlock } from '../../src/core/hints/hint-format.js'
import { userWords } from './mock-user-words.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Built-in registry kinds plus every `*_HINT_KIND = '...'` constant in src/. */
function hintKinds(): string[] {
  const kinds = new Set<string>()
  const registry = fs.readFileSync(path.join(REPO, 'src/core/hints/hint-registry.ts'), 'utf-8')
  for (const m of registry.matchAll(/^\s+kind: '([a-z][a-z0-9-]*)'/gm)) kinds.add(m[1])
  for (const f of sourceFiles(path.join(REPO, 'src'))) {
    for (const m of fs.readFileSync(f, 'utf-8').matchAll(/_HINT_KIND\s*=\s*'([a-z][a-z0-9-]*)'/g)) kinds.add(m[1])
  }
  return [...kinds].sort()
}

describe('the mock ACP agent echoes only what the user wrote', () => {
  const kinds = hintKinds()

  it('finds the hint kinds in the source', () => {
    expect(kinds).toEqual(expect.arrayContaining(['question', 'reply-language', 'rich-output', 'session-context', 'voice-reply']))
  })

  it.each(kinds)('a %s hint before and after the message comes off', (kind) => {
    const message = 'live gemini stream test\nsecond line é中'
    const body = `Standing instructions.\n\n## Heading\n- a list\n(parentheses) and a </system-reminder-ish> word`
    const block = renderHintBlock(kind, body, kind === 'question' ? '3' : undefined)
    const composed = composeHinted(message, { before: [block, renderHintBlock(kind, 'second')], after: [renderHintBlock(kind, 'after')] })
    expect(parseHinted(composed).text).toBe(message)
    expect(userWords(composed)).toBe(message)
  })

  it('a message with no hint is echoed as typed', () => {
    expect(userWords('plain words')).toBe('plain words')
  })
})
