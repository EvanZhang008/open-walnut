/**
 * Walnut never judges a session's words for their language and never sends a correction
 * (2026-11-20, the user, of "Your line just now was not in the user's language: ... Write every
 * line from here on in it ...": remove this reminder, we don't need it). From 2026-11-14 a
 * mid-turn correction, the `reply-language` hint with its `on_drift` trigger, and a note in the
 * answer of every letter and message to another task did it; all of it was removed.
 *
 * The Reply language setting itself stays: a line of every session's system prompt
 * (sessions/reply-language-context.ts), re-sent by the instruction notice when it changes. Who may
 * read the setting is pinned in tests/core/hints/hint-triggers-only.test.ts.
 *
 * This fails when any part comes back: a hint kind or trigger for it, its modules, a function
 * that judges a text's language, or its words.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HINT_TRIGGERS, effectiveHints, validateHintSettings } from '../../../src/core/hints/hint-registry.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SCANNED = ['src', 'web/src']

function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else if (/\.(ts|tsx|js|mjs|md)$/.test(e.name)) out.push({ rel: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') })
    }
  }
  for (const d of SCANNED) walk(path.join(ROOT, d))
  return out
}

describe('no reply-language reminder', () => {
  it('no hint corrects the reply language, and on_drift is no trigger', () => {
    // An older Walnut's override of the correction, still in config.yaml, adds nothing.
    const config = { session: { reply_language: 'Talk to the user in Chinese.', hints: { 'reply-language': { enabled: true, triggers: ['on_drift'] } } } } as never
    expect(effectiveHints(config).map((h) => h.kind)).not.toContain('reply-language')
    expect(HINT_TRIGGERS as readonly string[]).not.toContain('on_drift')
    for (const h of effectiveHints(config)) expect(h.allowedTriggers as readonly string[], h.kind).not.toContain('on_drift')
    expect(() => validateHintSettings('reply-language', { text: 'Answer in Chinese.' })).toThrow()
  })

  it('its modules stay gone', () => {
    for (const f of ['src/core/hints/reply-language-drift.ts', 'src/core/hints/reply-language-quote.ts', 'src/core/hints/hint-drift-detect.ts']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false)
    }
  })

  it('no source judges a text for the reply language or words a correction', () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(1000)
    const PATTERNS: Array<[RegExp, string]> = [
      [/not in (?:the user's|this) language/i, 'the correction\'s words'],
      [/off the user's (?:reply )?language/i, 'the correction\'s words'],
      [/\b(?:languageDrift|detectLanguageDrift|letterLanguageNote|messageLanguageNote|liveCorrection\w*|withLanguageNote)\b/, 'a judge or note of the removed check'],
      [/\bon_drift\b/, 'the removed trigger'],
      // Counting a text's scripts is a test tool only (tests/helpers/text-script.ts).
      [/\bscriptCounts\b|helpers\/text-script/, 'judging a text by its script'],
    ]
    const hits: string[] = []
    for (const f of files) {
      for (const [re, what] of PATTERNS) if (re.test(f.text)) hits.push(`${f.rel}: ${what} (${re.source})`)
    }
    expect(hits).toEqual([])
  })
})
