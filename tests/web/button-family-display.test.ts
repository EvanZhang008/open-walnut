/**
 * The button family never decides on its own whether a key shows. `.btn` used to declare
 * `display: inline-flex` at class strength, so a class written beside it that hides the key
 * (`.md-code-fold { display: none }` in code-block.css) tied with it and lost whenever its
 * stylesheet loaded first: the code block's Fold key never hid (2026-11-22). The family now lays a
 * key out at zero specificity (`:where(.btn)`), so any class rule wins, in any load order.
 * This fails when a rule of buttons.css sets `display` at class strength again.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'styles', 'buttons.css'), 'utf8')

/** Every rule of a flat stylesheet: its selector list and its body (comments removed). */
function rules(css: string): { selectors: string[]; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selectors: string[]; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] })
  return out
}

/** Selectors allowed to set display at full strength: `hidden` hides a key; the slots are spans. */
const ALLOWED = new Set(['.btn[hidden]', '.btn-reserve', '.btn-value', '.btn-caret'])

describe('button family display', () => {
  it('lays a key out only at zero specificity, so a class beside btn can hide it', () => {
    const bad: string[] = []
    for (const r of rules(CSS)) {
      if (!/(^|;)\s*display\s*:/.test(r.body)) continue
      for (const sel of r.selectors) {
        if (sel.startsWith(':root') || sel.startsWith('html')) continue
        if (/^:where\([^)]*\)$/.test(sel) || ALLOWED.has(sel)) continue
        bad.push(sel)
      }
    }
    expect(bad).toEqual([])
  })

  it('still lays out a key and a full-width key, and hides a hidden one', () => {
    expect(CSS).toMatch(/:where\(\.btn\)\s*\{\s*display:\s*inline-flex;/)
    expect(CSS).toMatch(/:where\(\.btn-block\)\s*\{\s*display:\s*flex;/)
    expect(CSS).toMatch(/\.btn\[hidden\]\s*\{\s*display:\s*none;/)
  })

  it('the parser finds a class-strength display rule', () => {
    const found = rules('.btn { color: red; display: inline-flex; } :where(.btn) { display: flex; }')
      .filter((r) => /display\s*:/.test(r.body)).flatMap((r) => r.selectors)
    expect(found).toEqual(['.btn', ':where(.btn)'])
  })
})
