import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A menu row drawn by the button family has no fill of its own, so the keyboard's row is lit only by
// the shared rule in buttons.css (2026-11-24: the button family removed the Ask choice's own fill and
// its focused row showed nothing). Every family key that is a menu row must be the quiet full-width
// key that rule covers, and the rule must stay.
const ROOT = join(__dirname, '..', '..', 'web', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

// An opening JSX tag: attributes, with arrow functions and one level of braces inside.
const TAG = /<(?:button|a|div|li)\b(?:[^<>]|=>|\{[^{}]*\})*?>/gs

describe('menu rows drawn by the button family', () => {
  it('are quiet full-width keys, so the shared focus fill reaches them', () => {
    const bad: string[] = []
    let seen = 0
    for (const file of files(ROOT)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(TAG)) {
        const tag = m[0]
        if (!/role=["'{`]*menuitem/.test(tag)) continue
        const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\}|'([^']*)')/.exec(tag)
        const names = (cls?.[1] ?? cls?.[2] ?? cls?.[3] ?? '').split(/\s+/)
        if (!names.includes('btn')) continue
        seen += 1
        if (!names.includes('btn-block') || !names.includes('btn-ghost')) {
          bad.push(`${file.slice(ROOT.length + 1)}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
    expect(seen, 'the scan still finds the Ask choice rows').toBeGreaterThan(0)
    expect(bad).toEqual([])
  })

  it('keep the shared keyboard fill in buttons.css', () => {
    const css = readFileSync(join(ROOT, 'styles', 'buttons.css'), 'utf8')
    expect(css).toMatch(/\.btn-block\.btn-ghost:is\(\[role='menuitem'\][^{]*:is\(:focus, :hover\)[^{]*\{\s*background: var\(--bg-hover\);/)
  })
})
