/**
 * Home's panels and the New task draft are at their final size and fully opaque in the frame they
 * open in: no stylesheet animates them (2026-11-04, the user: "it should instantly show, no delay").
 *
 * The chat slot (flex), the task panel and the sessions strip (width) and their opacity used to
 * transition for 0.2 to 0.25 s, so the draft, which takes the chat's spot, drew squeezed and faded for
 * a quarter second while every open column was laid out again on each frame. This reads every
 * stylesheet of the web app and fails on a rule that gives one of these elements a transition or an
 * animation of anything but colours, and the same for the menus, pickers and drawer that open on a click.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = [
  'main-page-chat', 'main-page-todo', 'main-page-sessions-area', 'main-page-session-column',
  'draft-session-panel', 'ask-walnut-slot', 'draft-intent-stack', 'draft-intent-cards',
  // What opens on a click is whole and in place in its first frame too: the menus and pickers
  // (their slide in replaced the session finder's own centring transform, so it opened 280 px off
  // and slid back) and the Ask Walnut drawer with its scrim.
  'mention-palette', 'command-palette-wrap', 'file-mention-popup', 'session-path-selector',
  'quick-task-composer', 'model-picker', 'question-popover', 'todo-launcher-popover',
  'session-search-panel', 'ask-walnut-drawer', 'ask-walnut-scrim',
]
/** Paint-only properties a transition may still carry (a hover colour, a focus ring). */
const PAINT_ONLY = /^(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|box-shadow|outline(?:-color)?|fill|stroke)$/

const WEB_SRC = path.resolve(__dirname, '../../web/src')
function stylesheets(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return stylesheets(p)
    return e.name.endsWith('.css') ? [p] : []
  })
}

/** The last compound of each selector in a list: the element the rule styles. */
function subjects(selector: string): string[] {
  return selector.split(',').map((s) => s.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '')
}

function rules(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<{ selector: string; body: string }> = []
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim(), body: m[2] })
  return out
}

describe("Home's panels open without motion", () => {
  it('no rule animates a Home panel or the draft panel beyond colours', () => {
    const offenders: string[] = []
    let seen = 0
    for (const file of stylesheets(WEB_SRC)) {
      for (const { selector, body } of rules(fs.readFileSync(file, 'utf8'))) {
        const hits = subjects(selector).filter((s) => ROOTS.some((r) => new RegExp(`\\.${r}(?![\\w-])`).test(s)))
        if (!hits.length) continue
        seen++
        for (const decl of body.matchAll(/(?:^|;)\s*(transition|transition-property|animation|animation-name)\s*:\s*([^;]+)/g)) {
          const [, prop, value] = decl
          if (/^\s*none\s*(!important)?\s*$/.test(value)) continue
          if (prop.startsWith('animation')) { offenders.push(`${path.relative(WEB_SRC, file)}: ${selector} { ${prop}: ${value.trim()} }`); continue }
          const props = prop === 'transition-property'
            ? value.split(',').map((p) => p.trim())
            : value.split(',').map((p) => p.trim().split(/\s+/)[0])
          if (props.some((p) => !PAINT_ONLY.test(p))) offenders.push(`${path.relative(WEB_SRC, file)}: ${selector} { ${prop}: ${value.trim()} }`)
        }
      }
    }
    expect(seen, 'the panel selectors were renamed: update ROOTS').toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})
