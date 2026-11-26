/**
 * A Chip cuts its own label; a span of the caller's inside it cannot.
 *
 * Chip (web/src/components/controls/Chip.tsx) draws its children in `.wn-chip-label`, the flex item
 * that ends a long name in an ellipsis (choice-controls.css). A span the caller puts inside is an
 * inline box there, and an inline box takes no max-width and no overflow clip: its own cut is dead
 * CSS. 2026-11-26: the folder picker's host tabs moved onto Chip (18510bbab3) with their
 * `.sps-host-tab-label` span inside, whose `max-width: 10em; overflow: hidden` never applied; the
 * picker spec's C39 measured that span and found nothing cut (scrollWidth 0 = clientWidth 0).
 *
 * This scan finds, by the syntax tree, every element a Chip or a Disclosure holds directly, and fails
 * when a stylesheet gives one of its classes a clip (overflow, text-overflow or max-width) while no
 * rule for that class makes it a box of its own (a display other than inline or contents).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const WEB = path.resolve(__dirname, '../../web/src')
const walk = (dir: string, ext: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p, ext) : e.name.endsWith(ext) ? [p] : []
})

/** The controls that wrap their children in a label span of their own. */
const LABEL_WRAPPERS = new Set(['Chip', 'Disclosure'])

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement
const openingOf = (n: ts.Node): Opening | undefined =>
  ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined
const classTokens = (o: Opening): string[] => {
  const a = o.attributes.properties.find((x) => ts.isJsxAttribute(x) && x.name.getText() === 'className')
  const init = a && ts.isJsxAttribute(a) ? a.initializer : undefined
  return init ? [...init.getText().matchAll(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g)].map((m) => m[0]) : []
}

interface Child { where: string; control: string[] }
/** Each class a Chip or Disclosure holds directly on a plain element: where, and the control's own classes. */
function childClasses(): Map<string, Child[]> {
  const out = new Map<string, Child[]>()
  for (const file of walk(WEB, '.tsx')) {
    const src = fs.readFileSync(file, 'utf-8')
    if (!src.includes('<Chip') && !src.includes('<Disclosure')) continue
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) && LABEL_WRAPPERS.has(n.openingElement.tagName.getText())) {
        // Direct children, and those drawn by a `{cond && <span>}` or a ternary right inside.
        const direct: ts.Node[] = []
        const take = (c: ts.Node) => {
          if (openingOf(c)) direct.push(c)
          else if (ts.isJsxExpression(c) || ts.isParenthesizedExpression(c) || ts.isBinaryExpression(c) || ts.isConditionalExpression(c)) ts.forEachChild(c, take)
        }
        n.children.forEach(take)
        for (const c of direct) {
          const o = openingOf(c)!
          if (!/^[a-z]/.test(o.tagName.getText())) continue
          const where = `${path.relative(WEB, file)}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}`
          for (const t of classTokens(o)) out.set(t, [...(out.get(t) ?? []), { where, control: classTokens(n.openingElement) }])
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

interface Rule { selectors: string[]; body: string }
function cssRules(): Rule[] {
  const rules: Rule[] = []
  for (const file of walk(WEB, '.css')) {
    const css = fs.readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] })
    }
  }
  return rules
}

/** Whether a selector's last compound names this class (`.x`, `.a .x`, `.x:hover`). */
const targets = (selector: string, cls: string): boolean => {
  const last = selector.split(/[\s>+~]+/).at(-1) ?? ''
  return new RegExp(`\\.${cls}(?![a-z0-9-])`).test(last)
}
const CLIP = /(?:^|;)\s*(?:overflow(?:-x)?|text-overflow|max-width)\s*:/
const BOX = /(?:^|;)\s*display\s*:\s*(?!inline\s*(?:;|$)|contents)[a-z-]+/
const FLEX_OR_GRID = /(?:^|;)\s*display\s*:\s*(?:inline-)?(?:flex|grid)\b/
/** The controls' own label spans (Chip.tsx, Disclosure.tsx). */
const CONTROL_LABELS = ['wn-chip-label', 'wn-disclosure-label']

describe('a Chip cuts its own label', () => {
  it('finds the children it checks (the scan reads the real tree)', () => {
    // A caller's child the scan must see: the servers strip's port and name, inside its Chip.
    expect([...childClasses().keys()]).toEqual(expect.arrayContaining(['session-server-port', 'session-server-name']))
  })

  it('no span inside a Chip or a Disclosure carries a clip that its inline box cannot take', () => {
    const rules = cssRules()
    const dead: string[] = []
    for (const [cls, uses] of childClasses()) {
      const own = rules.filter((r) => r.selectors.some((s) => targets(s, cls)))
      if (!own.some((r) => CLIP.test(r.body)) || own.some((r) => BOX.test(r.body))) continue
      for (const { where, control } of uses) {
        // A caller that makes the control's label a flex or grid row makes each child a box of its
        // own (session-servers.css: `.session-server-chip-open .wn-chip-label { display: inline-flex }`).
        const rowed = rules.some((r) => FLEX_OR_GRID.test(r.body) && r.selectors.some((s) =>
          CONTROL_LABELS.some((l) => targets(s, l)) && control.some((c) => new RegExp(`\\.${c}(?![a-z0-9-])`).test(s))))
        if (!rowed) dead.push(`.${cls} (${where}): its overflow/ellipsis/max-width never applies inside the control's label; let that label cut it, or give the span a display`)
      }
    }
    expect(dead).toEqual([])
  })
})
