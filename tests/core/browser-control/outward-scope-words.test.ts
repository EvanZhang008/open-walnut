/**
 * The ask before an agent buys, sends or deletes judges only the agent's own click, key or typed
 * text: `evaluate`, the page's own scripts and a link that acts on a plain visit are not judged.
 * Every text that tells the person or an agent about the ask must say that, and none may promise
 * more ("whatever the site setting" read as "always"). Fails when a text drops the limit or
 * brings the promise back.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const TEXTS = ['docs/reference/browser-control.md', 'src/data/skills/walnut-browser/SKILL.md', 'src/ops/browser.ts', 'packages/browser-extension/src/page-agent-outward.ts']

describe('what the outward ask covers is said plainly', () => {
  it.each(TEXTS)('%s promises nothing more', (p) => {
    expect(read(p)).not.toMatch(/whatever the site setting/i)
  })

  it.each(TEXTS)('%s says evaluate and page scripts are not judged', (p) => {
    // One line however the text wraps (a string built of '+' pieces in the op).
    const flat = read(p).replace(/\\'/g, "'").replace(/'\s*\+\s*'|\s+/g, ' ')
    expect(flat).toMatch(/evaluate/)
    expect(flat).toMatch(/page's own scripts/)
    expect(flat).toMatch(/(plain visit|plain GET)/)
  })

  it('the person reads which switch evaluate needs', () => {
    expect(read('docs/reference/browser-control.md')).toMatch(/`evaluate` works only while "Let agents use real mouse and keys" is on/)
  })
})
