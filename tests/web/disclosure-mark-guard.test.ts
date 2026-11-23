/**
 * Every expand/collapse mark is a drawn icon, never a typed triangle (2026-11-23, the user: "所有东西都应该统一啊",
 * everything should be one). The web UI drew its marks two ways, text triangles (a down-pointing small
 * triangle, a right-pointing one, their escapes) beside SVG chevrons, so the same fold looked different on
 * every surface and the glyphs sat on the text baseline at a size each engine picked.
 *
 * Two marks, two shared components (web/src/components/controls/Disclosure.tsx):
 *  - a fold (shows or hides what is under it): `DisclosureChevron`, right when closed, down when open;
 *  - a key that opens a menu or picker: `MenuCaret`, a down chevron that flips while the menu is open.
 * A plugin, which cannot import host components, draws the same markup with the host's
 * `wn-disclosure-chevron` class (examples/plugins/walnut-time/src/web/fold-chevron.tsx).
 *
 * Scans what the UI code renders (web/src, plugin-store, examples/plugins; comments removed, escapes decoded)
 * for any triangle of U+25B2 to U+25C4, and the CSS escapes of the same range. Baseline 0, no allow list.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './css-scan'
import { decodeEscapes, stripComments } from './source-text-scan'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['web/src', 'plugin-store', 'examples/plugins'].map((d) => join(ROOT, d))

/** The triangles (U+25B2 up to U+25C4: up, right, down, left, filled, outlined, small) and CSS's `\25BE`. */
const TRIANGLE = /[\u25B2-\u25C4]|\\25(?:B[2-9A-Fa-f]|C[0-4])/

export function findTriangles(src: string): number[] {
  const lines = decodeEscapes(stripComments(src)).split('\n')
  return lines.flatMap((l, i) => (TRIANGLE.test(l) ? [i + 1] : []))
}

/**
 * A chevron drawn in CSS as a bordered box turned 45deg (`border-right` + `border-bottom`, `rotate(45deg)`):
 * the third way a fold or a caret was drawn (the v6 draft's Permissions key showed one beside its own
 * caret, 2026-11-23). A spot only CSS can draw masks --wn-chevron (choice-controls.css) instead.
 */
export function findBoxChevrons(css: string): string[] {
  const text = stripComments(css)
  const out: string[] = []
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]!
    const borders = body.match(/border-(?:top|right|bottom|left)\s*:[^;]*solid/g) ?? []
    if (borders.length >= 2 && /rotate\(\s*-?(?:45|135|225)deg\s*\)/.test(body)) out.push(m[1]!.trim())
  }
  return out
}

describe('disclosure marks: icons only, never a typed triangle', () => {
  it('the CSS scan catches a bordered box turned into a chevron, and not the shared mask', () => {
    expect(findBoxChevrons('.x::after { width: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); }')).toEqual(['.x::after'])
    expect(findBoxChevrons('.x::after { background: currentColor; mask: var(--wn-chevron) center / contain no-repeat; transform: rotate(90deg); }')).toEqual([])
  })

  it('no stylesheet draws a chevron from borders (mask --wn-chevron instead)', () => {
    const hits = DIRS.flatMap((d) => walk(d, ['.css'])).flatMap((f) => findBoxChevrons(readFileSync(f, 'utf8')).map((sel) => `${relative(ROOT, f)}: ${sel.slice(0, 120)}`))
    expect(hits, 'draw it with the shared chevron: background currentColor, mask var(--wn-chevron) (choice-controls.css)').toEqual([])
  })

  it('the scan catches typed and escaped triangles and ignores comments', () => {
    // Test data in escapes: '\u25BE' small down, '\u25B8' small right, '\u25BC' down, '\u25B6\uFE0E' right as text.
    expect(findTriangles("<span>{'\u25BE'}</span>")).toEqual([1])
    expect(findTriangles("label = 'More \u25B8'")).toEqual([1])
    expect(findTriangles("{open ? '\u25BC' : '\u25B6\uFE0E'}")).toEqual([1])
    expect(findTriangles(String.raw`{open ? '\u25BC' : '\u25B6\uFE0E'}`)).toEqual([1])
    expect(findTriangles(".x::after { content: '\\25B8'; }")).toEqual([1])
    expect(findTriangles(['// a \u25B8 in a line comment', '/* a \u25BE in a block */', '{/* \u25BC in JSX */}', 'ok'].join('\n'))).toEqual([])
  })

  it('no UI file renders one (use DisclosureChevron for a fold, MenuCaret for a menu key)', () => {
    const files = DIRS.flatMap((d) => walk(d, ['.tsx', '.ts', '.css'])).filter((f) => !/\.test\.|\.spec\./.test(f))
    expect(files.length, 'the scan sees the UI it guards').toBeGreaterThan(500)
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const srcLines = src.split('\n')
      for (const line of findTriangles(src)) hits.push(`${relative(ROOT, f)}:${line}: ${srcLines[line - 1]!.trim().slice(0, 120)}`)
    }
    expect(hits, 'a typed triangle: a fold takes DisclosureChevron, a key that opens a menu takes MenuCaret (components/controls)').toEqual([])
  })
})
