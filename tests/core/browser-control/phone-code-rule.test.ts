/**
 * A step that sends a code to the person's phone or mail is announced first (which task, which
 * site, why) and never taken between 22:00 and 08:00 their time (2026-11-12: a sign-in at 22:39
 * texted a code with no word in Walnut). Every text an agent reads about the browser says so.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const flat = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\\'/g, "'").replace(/'\s*\+\s*'|\s+/g, ' ')
const TEXTS = ['src/data/skills/walnut-browser/SKILL.md', 'src/ops/browser.ts']

describe('a code sent to the person is announced and never at night', () => {
  it.each(TEXTS)('%s says it', (p) => {
    const t = flat(p)
    expect(t).toMatch(/code to the (user's|person's) phone or mail/)
    expect(t).toMatch(/which task, which site and why/)
    expect(t).toMatch(/[Nn]ever between 22:00 and 08:00 their local time/)
  })
})
