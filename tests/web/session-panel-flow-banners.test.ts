/**
 * The session panel's header is absolute glass over the chat. A banner rendered between it and the
 * split (the error banner, the folder-gone banner, the usage-limit banner, the messages summary) is
 * pushed below it only by rules that key on `.session-error-banner` / `.session-action-panel`
 * (globals.css, task-board.css, board-kanban.css). A banner without one of them is drawn under the
 * glass header (2026-11-04: the usage-limit banner was, its text behind the header's tabs).
 *
 * This reads SessionPanel.tsx between the header and the split, finds every element and every
 * `*Banner` component drawn there, and fails on one whose root carries neither class.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const PANEL = path.join(ROOT, 'web/src/components/sessions/SessionPanel.tsx')
const FLOW_CLASSES = ['session-error-banner', 'session-action-panel']

function flowRegion(src: string): string {
  const start = src.indexOf('{messagesOpen && (')
  const end = src.indexOf('className={`session-panel-split', start)
  expect(start, 'the messages summary marks where the flow banners begin').toBeGreaterThan(0)
  expect(end, 'the split marks where they end').toBeGreaterThan(start)
  return src.slice(start, end)
}

/** The className text of a named component's first returned root element. */
function rootClassOf(file: string, name: string): string {
  const src = fs.readFileSync(file, 'utf8')
  const fn = src.search(new RegExp(`export function ${name}\\b`))
  const body = src.slice(fn)
  const ret = body.search(/return \(\s*(\/\/[^\n]*\n\s*)*</)
  // Its root: a plain element or a PanelNotice, whichever it returns.
  const root = body.slice(ret).match(/<(?:div|PanelNotice)\b[^>]*?className=(\{`[^`]*`\}|"[^"]*")/)
  return root?.[1] ?? ''
}

describe('banners between the session header and the chat clear the glass header', () => {
  const region = flowRegion(fs.readFileSync(PANEL, 'utf8'))

  it('every Banner or Note component drawn there carries a flow class at its root', () => {
    const names = [...new Set([...region.matchAll(/<([A-Z]\w*(?:Banner|Note))\b/g)].map((m) => m[1]))]
    expect(names).toEqual(expect.arrayContaining(['FolderGoneBanner', 'UsageLimitBanner', 'UsageLimitContinuedNote']))
    const panel = fs.readFileSync(PANEL, 'utf8')
    const missing = names.filter((name) => {
      // The file the panel imports it from.
      const from = panel.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./([^']+)'`))?.[1]
      const file = path.join(ROOT, 'web/src/components/sessions', `${from ?? name}.tsx`)
      if (!fs.existsSync(file)) return true
      const cls = rootClassOf(file, name)
      return !FLOW_CLASSES.some((c) => cls.includes(c))
    })
    expect(missing, `give the root of each a flow class (${FLOW_CLASSES.join(' or ')})`).toEqual([])
  })

  it('every top-level element drawn there carries one too', () => {
    // A direct child: an element opened right after `(` or `&&` of a conditional. A plain element or
    // a PanelNotice takes its class here; a *Banner or *Note component is checked at its root above.
    const opener = /(?:&&\s*\(|\?\s*\(|return \()\s*<(\w+)/g
    const tags = [...region.matchAll(opener)].map((m) => m[1])
    const unknown = tags.filter((t) => t !== 'div' && t !== 'PanelNotice' && !/^[A-Z]\w*(?:Banner|Note)$/.test(t))
    expect(unknown, 'a new kind of element drawn there: give it a flow class and teach this test about it').toEqual([])
    const tops = [...region.matchAll(/(?:&&\s*\(|\?\s*\(|return \()\s*<(?:div|PanelNotice)\b[^>]*?className=(\{`[^`]*`\}|"[^"]*")/g)].map((m) => m[1])
    expect(tops.length, 'the plain elements and PanelNotices drawn there').toBe(tags.filter((t) => t === 'div' || t === 'PanelNotice').length)
    expect(tops.length).toBeGreaterThan(2)
    expect(tops.filter((cls) => !FLOW_CLASSES.some((c) => cls.includes(c)))).toEqual([])
  })
})
