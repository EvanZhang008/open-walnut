/**
 * A plain key (`.btn`) shows its box on every surface it can sit on, in both themes.
 *
 * The key's fill used to be the text colour mixed into the PAGE colour (`--bg`). In dark that was
 * #2c2c2c, and the cards and settings groups it sits on are `--bg-tertiary` #2c2c2e: 29 keys on the
 * Apps, Usage, Rhythm and notes-import pages read as bare text (2026-11-27 UI audit, task 1d0a8c4d).
 * The fill is now a tint of the text colour over whatever is under the key.
 *
 * This fails when:
 * - the key's fill (rest, hover, pressed) lands within a few steps of any opaque surface token of
 *   either theme (a new surface token is checked the day it is added);
 * - a plain key that its view places over content (position absolute/fixed/sticky on the class
 *   written beside `btn`) does not set `--btn-under`, so it would be see-through over a document;
 * - a new background mixes the text colour into `--bg` (the same mistake outside the family).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const BUTTONS = read('web/src/styles/buttons.css')
const GLOBALS = read('web/src/styles/globals.css')
const SETTINGS = read('web/src/styles/settings-shell.css')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

type Theme = 'light' | 'dark'
type Rgba = { r: number; g: number; b: number; a: number }

/** The declarations of every block whose selector matches, later ones winning (as in the cascade). */
function block(css: string, selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  const text = strip(css)
  while ((m = re.exec(text))) {
    // A statement before the rule (an @import) ends with a semicolon: the selector is what follows it.
    if (!selector.test(m[1].split(';').pop()!.trim())) continue
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
  }
  if (!Object.keys(out).length) throw new Error(`no block ${selector}`)
  return out
}

/** The custom properties a theme defines: light is :root; dark adds :root[data-theme="dark"]. */
function themeVars(theme: Theme): Record<string, string> {
  const light = {
    ...block(GLOBALS, /^:root$/),
    ...block(SETTINGS, /^:root$/),
    ...block(BUTTONS, /^:root$/),
    ...block(BUTTONS, /^\.btn$/),
  }
  if (theme === 'light') return light
  return {
    ...light,
    ...block(GLOBALS, /^:root\[data-theme=["']dark["']\]$/),
    ...block(SETTINGS, /^:root\[data-theme=["']dark["']\]/),
    ...block(BUTTONS, /^:root\[data-theme=["']dark["']\]$/),
  }
}

function hex(v: string): Rgba | null {
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
}

/** Replace var() with its value (or its fallback), innermost first. */
function resolve(v: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 12) throw new Error(`var loop in ${v}`)
  const re = /var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/
  const m = v.match(re)
  if (!m) return v.trim()
  const val = vars[m[1]] ?? m[2]
  if (val === undefined) throw new Error(`undefined ${m[1]}`)
  return resolve(v.replace(m[0], val.trim()), vars, depth + 1)
}

/** Evaluate a resolved colour: a hex, transparent, or color-mix(in srgb, A p%, B) (premultiplied). */
function colour(v: string): Rgba {
  v = v.trim()
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const h = hex(v)
  if (h) return h
  const m = v.match(/^color-mix\(in srgb,\s*(.+)\)$/)
  if (!m) throw new Error(`cannot read colour ${v}`)
  const [a, b] = splitTop(m[1])
  const pa = a.match(/^(.*?)\s+(calc\((.+)\)|[\d.]+%)$/)
  if (!pa) throw new Error(`no percentage in ${a}`)
  const p = (pa[3] ? pa[3].split('+').reduce((s, x) => s + parseFloat(x), 0) : parseFloat(pa[2])) / 100
  const A = colour(pa[1])
  const B = colour(b)
  const alpha = A.a * p + B.a * (1 - p)
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const ch = (k: 'r' | 'g' | 'b') => (A[k] * A.a * p + B[k] * B.a * (1 - p)) / alpha
  return { r: ch('r'), g: ch('g'), b: ch('b'), a: alpha }
}

function splitTop(s: string): string[] {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }
  throw new Error(`no second colour in ${s}`)
}

const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
})
const steps = (x: Rgba, y: Rgba) => Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b))

/** Every opaque surface token of a theme: --bg, --bg-*, *-bg (hover tints and scrims are not surfaces). */
function surfaces(vars: Record<string, string>): [string, Rgba][] {
  const out: [string, Rgba][] = []
  for (const name of Object.keys(vars)) {
    if (!/^--(bg(-[\w-]+)?|[\w-]+-bg)$/.test(name)) continue
    let c: Rgba
    try { c = colour(resolve(vars[name], vars)) } catch { continue }
    if (c.a === 1) out.push([name, c])
  }
  return out
}

/** The least a key's fill may differ from its surface, on the 0-255 scale of one channel. */
const MIN_STEPS = 10

describe('a plain key shows its box on every surface', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    it(`${theme}: rest, hover and pressed fills stay a step away from every surface token`, () => {
      const vars = themeVars(theme)
      const list = surfaces(vars)
      // The surfaces the audit found keys on must be among them.
      for (const n of ['--bg', '--bg-secondary', '--bg-tertiary', '--bg-elevated', '--card-bg', '--settings-group-bg']) {
        expect(list.map(([k]) => k)).toContain(n)
      }
      const bad: string[] = []
      for (const key of ['--btn-fill', '--btn-fill-hover', '--btn-fill-press']) {
        const fill = colour(resolve(vars[key], vars))
        for (const [name, s] of list) {
          const d = steps(over(fill, s), s)
          if (d < MIN_STEPS) bad.push(`${key} on ${name}: ${d.toFixed(1)} steps`)
        }
      }
      expect(bad).toEqual([])
    })
  }

  it('reads on the page exactly as the old mix into --bg did (the look the user picked)', () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const vars = themeVars(theme)
      const page = colour(resolve(vars['--bg'], vars))
      const now = over(colour(resolve(vars['--btn-fill'], vars)), page)
      const old = colour(resolve(`color-mix(in srgb, var(--fg) var(--btn-strength), var(--bg))`, vars))
      expect(steps(now, old)).toBeLessThan(0.5)
    }
  })
})

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(join(ROOT, p)).isDirectory()) files(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}
const STYLE_FILES = [...files('web/src', /\.css$/), ...files('plugin-store', /styles?\.ts$/)]
const MARKUP_FILES = [...files('web/src', /\.tsx?$/), ...files('plugin-store', /\.tsx?$/)]

describe('a key placed over content stays solid', () => {
  it('every plain key a view positions sets --btn-under', () => {
    const family = /^btn(-[\w]+)?$/
    const quiet = new Set(['btn-ghost', 'btn-link', 'btn-icon', 'btn-primary'])
    const mates = new Set<string>()
    for (const f of MARKUP_FILES) {
      for (const m of read(f).matchAll(/["'`]([^"'`]*\bbtn\b[^"'`]*)["'`]/g)) {
        const cl = m[1].split(/\s+/)
        if (!cl.includes('btn') || cl.some((c) => quiet.has(c))) continue
        for (const c of cl) if (!family.test(c) && /^[a-z][\w-]+$/.test(c)) mates.add(c)
      }
    }
    const placed = new Map<string, string>()
    const under = new Set<string>()
    for (const f of STYLE_FILES) {
      for (const m of strip(read(f)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (m[1].includes('::')) continue
        const last = m[1].split(',').map((s) => s.trim().split(/\s+/).pop() ?? '')
        const classes = last.flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((x) => x[1])).filter((c) => mates.has(c))
        if (/--btn-under\s*:/.test(m[2])) classes.forEach((c) => under.add(c))
        if (/position:\s*(absolute|fixed|sticky)/.test(m[2])) classes.forEach((c) => placed.set(c, f))
      }
    }
    expect(placed.size).toBeGreaterThan(0)
    const bad = [...placed].filter(([c]) => !under.has(c)).map(([c, f]) => `.${c} (${f})`)
    expect(bad).toEqual([])
  })
})

/** Fills mixed into --bg on purpose, each with why it is right there. */
const MIXED_INTO_PAGE: Record<string, number> = {
  // The path's chevrons overlap their neighbours (margin -6 px): a tint would show twice there.
  'web/src/styles/tree-split.css': 2,
  // An option row's own fill is --bg; its hover is that row a step darker.
  'web/src/components/actions/ask-card.css': 1,
}

describe('no new fill mixes the text colour into the page colour', () => {
  it('matches the reviewed list', () => {
    const found: Record<string, number> = {}
    for (const f of STYLE_FILES) {
      const n = [...strip(read(f)).matchAll(/color-mix\(in srgb,\s*var\(--fg\)[^,]*,\s*var\(--bg\)\s*\)/g)].length
      if (n) found[relative(ROOT, join(ROOT, f))] = n
    }
    expect(found).toEqual(MIXED_INTO_PAGE)
  })
})
