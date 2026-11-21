/**
 * An info letter enters the inbox only when it is a report the user asked for
 * (src/core/human-inbox/info-letter-rule.ts): without user_asked the server answers with a
 * notice instead of a letter. The native and shell test drivers that seed letters are not
 * TypeScript, so a change to that rule never ran them: 2026-11-21, Nightly extra tests
 * 44916484473, the Mac app's pop-out test seeded an info letter, got a notice and failed.
 * Enumerated from the source: every file outside src/ and web/ that posts a letter to
 * /api/v1/human-inbox with type info says user_asked.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { passesInfoRule } from '../../src/core/human-inbox/info-letter-rule.js'

const ROOT = path.resolve(__dirname, '../..')
const files = execFileSync('git', ['ls-files', '*.swift', '*.sh', '*.mjs', '*.py'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.startsWith('src/') && !f.startsWith('web/'))
const INFO = /["']type["']\s*:\s*["']info["']/
const ASKED = /["']user_asked["']\s*:\s*(true|True)\b/
const seeders = files.filter((f) => {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
  return text.includes('human-inbox') && /\bPOST\b/.test(text) && INFO.test(text)
})

describe('every test driver that seeds an info letter says the user asked for it', () => {
  it('the rule still lets a letter the user asked for in, and only that', () => {
    expect(passesInfoRule({ type: 'info', user_asked: true })).toBe(true)
    expect(passesInfoRule({ type: 'info' })).toBe(false)
  })

  it('finds the drivers it judges', () => {
    expect(seeders).toEqual(expect.arrayContaining(['tests/desktop/popout-window-tests.swift', 'ios-native/tests/inbox/inbox-e2e.sh']))
  })

  it.each(seeders)('%s', (f) => {
    expect(ASKED.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} posts an info letter without user_asked: the server turns it into a notice`).toBe(true)
  })
})
