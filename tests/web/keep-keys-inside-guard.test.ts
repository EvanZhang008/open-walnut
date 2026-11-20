/**
 * Guard: a block that holds agent words never swallows Escape (web/src/utils/keep-keys-inside.ts).
 *
 * 2026-11-20, nightly agent-status-source: a row's Action needed block stopped every key press
 * (`onKeyDown: stop`), so the file viewer a path in its ask opened never heard Escape on `window`
 * and stayed open.
 *
 * The class, found from the source: every web file that renders agent words (`<AgentText`), whose
 * links open the viewer, a letter or a task over the page. A key handler there that only stops the
 * press is the bug; such a file uses keepKeysInside, or is listed with why its stop holds no agent
 * words.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { keepKeysInside } from '../../web/src/utils/keep-keys-inside'

const root = path.resolve('web/src')

/** Files whose blanket key stop sits on an element with no agent words in it, with why. */
const STOP_HOLDS_NO_AGENT_TEXT: Record<string, string> = {
  'components/tasks/StatusSections.tsx': 'the stop is on the Needs you line\'s Close button, which holds only its label',
  'apps/mail/MailGroupLine.tsx': 'the stops are on the group\'s Mark and More icon buttons, which hold only an icon',
}

/** A key handler that does nothing but stop the press: `onKeyDown: stop`, `onKeyDown={(e) => e.stopPropagation()}`, `e => ...`, the capture form too. */
const BLANKET_STOP = /onKeyDown(?:Capture)?(?::\s*|=\{\s*)(?:stop(?:Prop\w*)?\b|\(?\w+(?::[^)=]*)?\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\);?\s*\}?)\s*[,}]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('a block with agent words lets Escape through', () => {
  it('keepKeysInside stops every key but Escape', () => {
    for (const [key, stopped] of [['Escape', false], ['Enter', true], [' ', true], ['a', true], ['ArrowDown', true]] as const) {
      let did = false
      keepKeysInside({ key, stopPropagation: () => { did = true } })
      expect(did, key).toBe(stopped)
    }
  })

  it('no file that renders agent words stops every key press', () => {
    const files = walk(root).map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
    const members = files.filter((f) => f.text.includes('<AgentText'))
    expect(members.length, 'the scan finds the files that render agent words').toBeGreaterThan(20)
    const offenders = members
      .filter((f) => !STOP_HOLDS_NO_AGENT_TEXT[f.rel])
      .flatMap((f) => [...f.text.matchAll(BLANKET_STOP)].map((m) => `${f.rel}: ${m[0]}`))
    expect(offenders, 'use keepKeysInside (web/src/utils/keep-keys-inside.ts), or list the file with why its stop holds no agent words').toEqual([])
    const stale = Object.keys(STOP_HOLDS_NO_AGENT_TEXT).filter((rel) => {
      const f = members.find((m) => m.rel === rel)
      return !f || ![...f.text.matchAll(BLANKET_STOP)].length
    })
    expect(stale, 'listed files that no longer stop every key: drop them').toEqual([])
  })

  it('the row\'s Action needed block uses it', () => {
    const text = fs.readFileSync(path.join(root, 'components/actions/ActionNeeded.tsx'), 'utf8')
    expect(text).toMatch(/onKeyDown: keepKeysInside/)
  })
})
