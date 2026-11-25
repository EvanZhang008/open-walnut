/**
 * Wrapped rows of chips sit a finger apart on a phone, wherever the chips are drawn.
 *
 * On a phone each Chip's finger target is 44px tall over its drawn 24px (choice-controls.css), so
 * rows of chips must sit 20px apart or a chip's target covers the row above. 2026-11-25: the workers
 * line under a lead's chat stacked its 13 chips with no gap; at 390px the first chip's target
 * covered the "13 workers are working…" toggle, and a tap meant to fold the list opened that worker.
 *
 * The phone rule gives the gap to a ChipGroup and to any row a chip sits in directly. This scan
 * finds, by the syntax tree, every element in web/src that holds a Chip and fails when
 *  - a chip sits in a wrapper of its own whose row neither rule reaches (a new shape), or
 *  - a stylesheet sets a row gap on one of those rows with a selector as strong as the phone rule's,
 *    which would win over it on a phone.
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

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement
const openingOf = (n: ts.Node): Opening | undefined =>
  ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined
const enclosing = (n: ts.Node): ts.Node | undefined => {
  let p = n.parent
  while (p && !ts.isSourceFile(p) && !openingOf(p)) p = p.parent
  return p && openingOf(p) ? p : undefined
}
/** Whether a .map call draws this element (it sits in a .map callback below its enclosing element). */
const mappedBetween = (n: ts.Node): boolean => {
  for (let p = n.parent; p && !ts.isSourceFile(p) && !openingOf(p); p = p.parent) {
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'map') return true
  }
  return false
}
const classTokens = (o: Opening): string[] => {
  const a = o.attributes.properties.find((x) => ts.isJsxAttribute(x) && x.name.getText() === 'className')
  const init = a && ts.isJsxAttribute(a) ? a.initializer : undefined
  return init ? [...init.getText().matchAll(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+|[a-z]{3,}/g)].map((m) => m[0]) : []
}

/** A chip in a wrapper of its own, in a row neither phone rule reaches, with why that is fine. */
const WRAPPED_OK: Record<string, string> = {
  'session-server-chip': 'the servers strip is one line that hides what does not fit (SessionServerList.tsx), it never wraps',
  'ext-chip-page': 'the browser extension popout, outside the app shell the phone rule is for',
}

interface Found { rows: Set<string>; wrappedNew: string[] }
function scan(): Found {
  const rows = new Set<string>()
  const wrappedNew: string[] = []
  for (const file of walk(WEB, '.tsx')) {
    const src = fs.readFileSync(file, 'utf-8')
    if (!src.includes('<Chip')) continue
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (n: ts.Node) => {
      const o = openingOf(n)
      if (o && o.tagName.getText() === 'Chip') {
        const parent = enclosing(n)
        const po = parent && openingOf(parent)
        if (po) {
          const tag = po.tagName.getText()
          // A wrapper of its own (a span holding the chip and its ×, drawn once per item by a .map):
          // its row must be a ChipGroup or hold a chip directly.
          const wrapper = /^[a-z]/.test(tag) && !!parent && mappedBetween(parent)
          // The row the chip sits in directly: a ChipGroup, or a plain element (`:has(> .wn-chip)`).
          if (!wrapper && (tag === 'ChipGroup' || /^[a-z]/.test(tag))) classTokens(po).forEach((t) => rows.add(t))
          if (wrapper && parent) {
            const row = enclosing(parent)
            const ro = row && openingOf(row)
            const reached = ro && (ro.tagName.getText() === 'ChipGroup'
              || (row && ts.isJsxElement(row) && row.children.some((c) => openingOf(c)?.tagName.getText() === 'Chip')))
            const own = classTokens(po)
            if (!reached && !own.some((t) => WRAPPED_OK[t])) {
              wrappedNew.push(`${path.relative(WEB, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} <${tag} class="${own.join(' ')}">`)
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { rows, wrappedNew }
}

/** Rules that set a row gap on a row of chips with two or more classes in their selector, outside a min-width query. */
function strongGapRules(rows: Set<string>): string[] {
  const out: string[] = []
  for (const file of walk(WEB, '.css')) {
    const css = fs.readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
    // Each rule with the at-rules it sits in, by brace depth.
    const rules: Array<{ selector: string; body: string; inMinWidth: boolean }> = []
    const open: string[] = []
    let start = 0
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') {
        const prelude = css.slice(start, i).trim()
        const end = css.indexOf('}', i)
        const inner = css.indexOf('{', i + 1)
        if (prelude.startsWith('@') || (inner !== -1 && inner < end)) { open.push(prelude); start = i + 1; continue }
        rules.push({ selector: prelude, body: css.slice(i + 1, end), inMinWidth: open.some((a) => /^@media[^{]*min-width/.test(a)) })
        i = end
        start = end + 1
      } else if (css[i] === '}') { open.pop(); start = i + 1 }
    }
    for (const { selector, body, inMinWidth } of rules) {
      if (!/(^|;)\s*(row-gap|gap)\s*:/.test(body)) continue
      if (inMinWidth) continue
      for (const sel of selector.split(',').map((s) => s.trim())) {
        const last = sel.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? ''
        const hit = [...rows].find((t) => new RegExp(`\\.${t}(?![\\w-])`).test(last))
        if (!hit || hit === 'wn-chips') continue
        if ((sel.match(/\.[\w-]+|:(?!:)[\w-]+/g) ?? []).length < 2) continue
        if (file.endsWith('choice-controls.css')) continue // the phone rule itself
        const gap = body.match(/(?:^|;)\s*(row-gap|gap)\s*:\s*([^;]+)/)!
        const rowGap = parseFloat(gap[2])
        if (!(rowGap >= 20)) out.push(`${path.relative(WEB, file)}: ${sel} { ${gap[1]}: ${gap[2].trim()} }`)
      }
    }
  }
  return out
}

describe('wrapped rows of chips sit a finger apart on a phone', () => {
  const found = scan()

  it('the phone rule reaches a ChipGroup and any row a chip sits in directly', () => {
    const css = fs.readFileSync(path.join(WEB, 'styles/choice-controls.css'), 'utf-8')
    expect(css).toMatch(/\.app-shell-navigation \.wn-chips,\s*\.app-shell-navigation :has\(> \.wn-chip\) \{\s*row-gap: 20px;/)
    // The scan sees the rows: the workers line is one of them.
    expect(found.rows.has('session-working-row')).toBe(true)
  })

  it('every chip in a wrapper of its own sits in a row the phone rule reaches', () => {
    expect(found.wrappedNew, 'put the row in a <ChipGroup> (web/src/components/controls/Chip.tsx), or say in WRAPPED_OK why it never wraps').toEqual([])
  })

  it('no stylesheet sets a row gap on a row of chips that would win over the phone rule', () => {
    expect(strongGapRules(found.rows), 'leave the row gap to ChipGroup and the phone rule (choice-controls.css)').toEqual([])
  })
})
