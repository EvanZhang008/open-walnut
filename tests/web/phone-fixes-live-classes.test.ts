/**
 * Every class a phone override in phone-fixes.css names is one the app still renders. A component
 * that drops or renames a class leaves its phone rule matching nothing, silently: on 2026-11-22 the
 * settings checkbox lost its `.settings-checkbox-control` wrapper, the phone rule that cancelled the
 * box's 2 px drop kept naming it, and the box's 44 px target reached into the next row (N20).
 * A new rule for a class no source file mentions fails here; rename the selector to what renders.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB_SRC = join(__dirname, '..', '..', 'web', 'src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** The class names in every selector of a stylesheet (comments, urls and at-rule preludes left out). */
export function selectorClasses(css: string): Set<string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '')
  const out = new Set<string>()
  for (const m of text.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim()
    if (sel.startsWith('@')) continue
    for (const c of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(c[1])
  }
  return out
}

describe('phone-fixes.css names only classes the app renders', () => {
  it('finds the class in the selector parser', () => {
    expect([...selectorClasses('/* .gone */ @media (x) { .a .b:is(.c, .d) > e { color: red } }')].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('every class is in a source file', () => {
    const tokens = new Set<string>()
    for (const f of sourceFiles(WEB_SRC)) {
      for (const t of readFileSync(f, 'utf8').matchAll(/[A-Za-z_][\w-]*/g)) tokens.add(t[0])
    }
    const css = readFileSync(join(WEB_SRC, 'styles', 'phone-fixes.css'), 'utf8')
    const dead = [...selectorClasses(css)].filter((c) => !tokens.has(c)).sort()
    expect(dead, 'phone rules naming a class nothing renders').toEqual([])
  })
})
