/**
 * No browser spec parses a colour by hand: every one reads it through
 * tests/e2e/browser/css-color.ts (cssColorToRgba in Node, withCssColor inside page.evaluate).
 *
 * The class: a spec pulls the numbers out of a computed colour with a regex (`c.match(/[\d.]+/g)`,
 * `/\d+/g`, `/rgba?\(([^)]+)\)/`) or a `split(',')` and reads them as 0..255 sRGB. That holds only
 * for `rgb()`. On 2026-10-30 the floating overlays had moved to one color-mix() frosted glass
 * (web/src/styles/overlay-glass.css), which Chromium and WebKit serialise as
 * `color(srgb 1 1 1 / 0.82)`: the regex read the white menu as rgb(1, 1, 1), nearly black, and the
 * contrast checks of the filter bar, the Display menu and the mail context menu failed with dark
 * text measuring 1.25:1 to 2.08:1 on white. `oklab()`, `lab()` and `color(display-p3 ...)` break
 * the same parsers in other ways. Thirty-eight hand parses in twenty-nine files were replaced.
 *
 * What counts as a hand parse, on one line of a spec:
 *   A. a regex written against colour syntax (it names rgb, hsl, color, oklab... and an opening
 *      paren) used to exec, test, match or split a value;
 *   B. a regex that only picks numbers out (`[\d.]+`, `\d+`, `-?\d*\.?\d+`, `[^\d]`) applied to
 *      something that names a colour: the value itself, the line, the helper the line declares or
 *      sits in (up to 4 lines up), or the values that helper is called with;
 *   C. a comma split of a value on a line that names a colour.
 * Numbers read out of other strings stay allowed: a transform matrix, a count, a px size, a token
 * readout, a duration list. Assertions such as `expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)`
 * are not parses, and neither is a regex scan of stylesheet text with `.replace`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cssColorToRgba, withCssColor } from '../e2e/browser/css-color'

const SPECS = path.join(__dirname, '../e2e/browser')
const HELPER = path.join(SPECS, 'css-color.ts')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface RegexLiteral { body: string; start: number; end: number }

// A `/` starts a regex literal (not a division) after one of these, or after these keywords.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/
const REGEX_AFTER_WORD = /\b(return|typeof|case|in|of|void|delete|throw|yield|await)$/

/** The regex literals on one line of code; strings, comments and divisions are skipped. */
function regexLiterals(line: string): RegexLiteral[] {
  const out: RegexLiteral[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2)
      if (close < 0) break
      i = close + 2
      continue
    }
    if (ch === '/') {
      const before = line.slice(0, i).trimEnd()
      if (before === '' || REGEX_AFTER.test(before) || REGEX_AFTER_WORD.test(before)) {
        let j = i + 1
        let inClass = false
        while (j < line.length) {
          const c = line[j]
          if (c === '\\') { j += 2; continue }
          if (inClass) { if (c === ']') inClass = false }
          else if (c === '[') inClass = true
          else if (c === '/') break
          j++
        }
        if (j < line.length && j > i + 1) {
          let end = j + 1
          while (end < line.length && /[a-z]/.test(line[end])) end++
          out.push({ body: line.slice(i + 1, j), start: i, end })
          i = end
          continue
        }
      }
    }
    i++
  }
  return out
}

/** The expression a method is called on: the chain of names, calls and indexes before the dot. */
function receiver(text: string): string {
  let i = text.length
  let depth = 0
  while (i > 0) {
    const c = text[i - 1]
    if (c === ')' || c === ']') depth++
    else if (c === '(' || c === '[') {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && !/[\w$.?!]/.test(c)) break
    i--
  }
  return text.slice(i)
}

/** The first argument of a call whose open paren was just consumed. */
function argument(text: string): string {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') {
      if (depth === 0) return text.slice(0, i)
      depth--
    } else if (c === ',' && depth === 0) return text.slice(0, i)
  }
  return text
}

/** How a regex literal is applied: the method and the value it reads, or null for anything else. */
function usage(line: string, lit: RegexLiteral): { method: string; subject: string } | null {
  const before = line.slice(0, lit.start)
  const call = /\.(match|matchAll|split|replace|replaceAll|search)\(\s*$/.exec(before)
  if (call) return { method: call[1], subject: receiver(before.slice(0, call.index)) }
  const after = /^\.(exec|test)\(/.exec(line.slice(lit.end))
  if (after) return { method: after[1], subject: argument(line.slice(lit.end + after[0].length)) }
  return null
}

/** Rule A: the regex names a colour function and an opening paren. */
function namesColourSyntax(body: string): boolean {
  return /(^|[^a-z])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)([^a-z-]|$)/i.test(body) && body.includes('\\(')
}

/** Rule B: the regex only picks numbers out (digit classes, signs, dots, exponents, separators). */
function onlyNumbers(body: string): boolean {
  if (!/\\d|0-9/.test(body)) return false
  return body.replace(/\\[dDsS.()/+\-,%]/g, '').replace(/[[\]()?:+*{},.|^$%\-\s0-9e!=<>/]/g, '') === ''
}

/** Rule C: the regex splits at commas and nothing else. */
function commaOnly(body: string): boolean {
  return body.includes(',') && /^(\\s|[\s,[\]+*?])+$/.test(body)
}

const COLOUR_WORD = new RegExp([
  'colou?r(?!-?scheme)',
  '\\b(rgba?|hsla?|hwb|oklab|oklch)\\b',
  'luminance|\\blum\\b|contrast',
  '\\b[bf]g\\b',
  'background(?!-?(size|position|image|repeat|clip|origin|attachment|blend))',
  'border(?!-?(top|bottom)?-?(left|right)?-?(width|radius|style|spacing|collapse|image))',
  '\\[\\s*r\\s*,\\s*g\\s*,\\s*b\\b',
].join('|'), 'i')

// A value that is not a colour, whatever the code around it says.
const NOT_A_COLOUR = /transform|matrix|translate|scale|rotate|(^|[^a-z])(width|height|size|font|radius|duration|delay|gap|margin|padding|inset|opacity|count|length|offset|scroll)|(Width|Height|Size|Radius|Duration|Delay|Gap|Margin|Padding|Inset|Opacity|Index|Count|Length|Offset)\b/

const DECLARES = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
const COMMA_SPLIT = /\.split\(\s*(['"])\s*,\s*\1\s*\)/g

/** A line without its trailing `// comment`. */
const code = (line: string) => line.replace(/\s\/\/.*$/, '')

/** Line i, the declarations up to 4 lines above it, and every call of a helper they declare. */
function contextOf(lines: string[], i: number): string[] {
  const out = [lines[i]]
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    if (new RegExp(DECLARES.source).test(lines[k])) out.push(lines[k])
  }
  const names = new Set<string>()
  for (const l of [...out]) for (const m of l.matchAll(DECLARES)) names.add(m[1] ?? m[2])
  for (const name of names) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(`)
    lines.forEach((l, k) => { if (k !== i && call.test(l)) out.push(l) })
  }
  return out.map(code)
}

/** Every hand parse of a colour in one source file, as `line: code`. */
function findHandParses(source: string): string[] {
  const lines = source.split('\n')
  const found: string[] = []
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    const hit = () => found.push(`${i + 1}: ${trimmed}`)
    for (const lit of regexLiterals(line)) {
      const use = usage(line, lit)
      if (!use) continue
      if (namesColourSyntax(lit.body) && !use.method.startsWith('replace')) { hit(); continue }
      if (NOT_A_COLOUR.test(use.subject)) continue
      if (onlyNumbers(lit.body)) {
        if (COLOUR_WORD.test(use.subject) || contextOf(lines, i).some((l) => COLOUR_WORD.test(l))) hit()
      } else if (use.method === 'split' && commaOnly(lit.body)) {
        if (COLOUR_WORD.test(use.subject) || COLOUR_WORD.test(code(line))) hit()
      }
    }
    for (const m of code(line).matchAll(COMMA_SPLIT)) {
      const subject = receiver(code(line).slice(0, m.index))
      if (!NOT_A_COLOUR.test(subject) && (COLOUR_WORD.test(subject) || COLOUR_WORD.test(code(line)))) hit()
    }
  })
  return found
}

const near = (actual: number[], expected: number[], tolerance = 0.01) =>
  expect(actual.map((v, i) => Math.abs(v - expected[i]) <= tolerance), `${actual.join(', ')} vs ${expected.join(', ')}`)
    .toEqual(expected.map(() => true))

describe('cssColorToRgba reads every colour form a spec meets', () => {
  it('reads rgb() exactly as written, in both syntaxes', () => {
    expect(cssColorToRgba('rgb(66, 66, 69)')).toEqual([66, 66, 69, 1])
    expect(cssColorToRgba('rgba(0, 0, 0, 0.5)')).toEqual([0, 0, 0, 0.5])
    expect(cssColorToRgba('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0])
    expect(cssColorToRgba('rgb(0 128 255 / 50%)')).toEqual([0, 128, 255, 0.5])
    expect(cssColorToRgba('rgb(100% 50% 0%)')).toEqual([255, 127.5, 0, 1])
    expect(cssColorToRgba('RGB(1, 2, 3)')).toEqual([1, 2, 3, 1])
  })

  it('reads the color(srgb ...) a color-mix() computes to as 0..255, the 2026-10-30 glass', () => {
    expect(cssColorToRgba('color(srgb 1 1 1 / 0.82)')).toEqual([255, 255, 255, 0.82])
    expect(cssColorToRgba('color(srgb 0.5 0.25 1)')).toEqual([127.5, 63.75, 255, 1])
    near(cssColorToRgba('color(srgb 1.2e-05 0 0)'), [0.00306, 0, 0, 1], 0.0001)
    // Out of gamut is clipped.
    expect(cssColorToRgba('color(srgb 1.2 -0.1 0.5)')).toEqual([255, 0, 127.5, 1])
  })

  it('converts the other spaces to sRGB', () => {
    near(cssColorToRgba('color(srgb-linear 1 0 0.2140411)'), [255, 0, 127.5, 1], 0.5)
    near(cssColorToRgba('color(display-p3 1 1 1)'), [255, 255, 255, 1], 0.5)
    near(cssColorToRgba('color(display-p3 0 0 0 / 0.4)'), [0, 0, 0, 0.4])
    near(cssColorToRgba('color(xyz 0.9504559 1 1.0890578)'), [255, 255, 255, 1], 1)
    near(cssColorToRgba('color(xyz-d50 0.9642956 1 0.8251046)'), [255, 255, 255, 1], 1)
    near(cssColorToRgba('oklab(1 0 0)'), [255, 255, 255, 1], 0.5)
    near(cssColorToRgba('oklab(0 0 0 / 0.3)'), [0, 0, 0, 0.3])
    near(cssColorToRgba('oklch(0.627955 0.257683 29.2339)'), [255, 0, 0, 1], 2)
    near(cssColorToRgba('lab(100 0 0)'), [255, 255, 255, 1], 1)
    near(cssColorToRgba('lab(0 0 0)'), [0, 0, 0, 1])
    near(cssColorToRgba('lab(54.29 80.82 69.88)'), [255, 0, 0, 1], 3)
    near(cssColorToRgba('lch(54.29 106.84 40.85)'), [255, 0, 0, 1], 3)
  })

  it('reads hsl(), hwb() and hex, the forms a style rule keeps', () => {
    near(cssColorToRgba('hsl(0 100% 50%)'), [255, 0, 0, 1])
    near(cssColorToRgba('hsla(240, 100%, 50%, 0.25)'), [0, 0, 255, 0.25])
    near(cssColorToRgba('hsl(120 100% 25% / 0.5)'), [0, 127.5, 0, 0.5])
    near(cssColorToRgba('hsl(0.5turn 100% 50%)'), [0, 255, 255, 1])
    near(cssColorToRgba('hsl(3.14159265rad 100% 50%)'), [0, 255, 255, 1], 0.5)
    near(cssColorToRgba('hwb(0 0% 0%)'), [255, 0, 0, 1])
    near(cssColorToRgba('hwb(0 50% 50%)'), [127.5, 127.5, 127.5, 1])
    expect(cssColorToRgba('#ff8000')).toEqual([255, 128, 0, 1])
    expect(cssColorToRgba('#0f08')).toEqual([0, 255, 0, 136 / 255])
  })

  it('treats transparent and anything unreadable as fully transparent', () => {
    for (const value of ['transparent', '', 'garbage', 'rgb(1, 2)', 'color(nowhere 1 1 1)']) {
      expect(cssColorToRgba(value), value).toEqual([0, 0, 0, 0])
    }
  })

  it('withCssColor hands Playwright a callback whose source carries the parser', () => {
    const callback = withCssColor((toRgba) => (value: string) => toRgba(value))
    // In Node the callback is the real function.
    expect(callback('color(srgb 1 1 1 / 0.82)')).toEqual([255, 255, 255, 0.82])
    // Playwright sends String(callback) to the page and evaluates it there: rebuild it the same
    // way, with no module scope in reach.
    const source = String(callback)
    expect(source).toContain('function cssColorToRgba(')
    const rebuilt = new Function(`return (${source})`)() as (value: string) => number[]
    expect(rebuilt('color(srgb 1 1 1 / 0.82)')).toEqual([255, 255, 255, 0.82])
    expect(rebuilt('rgb(66, 66, 69)')).toEqual([66, 66, 69, 1])
  })
})

describe('no browser spec parses a colour by hand', () => {
  const flagged = (source: string) => findHandParses(source).length > 0

  it('flags the shapes that read the glass menu as black', () => {
    expect(flagged(String.raw`const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)`)).toBe(true)
    expect(flagged(String.raw`const peak = await row.evaluate((el) => Number((getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? [])[3] ?? 0))`)).toBe(true)
    // A generic helper name, convicted by what it is called with.
    expect(flagged([
      String.raw`const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)`,
      'const bg = parse(getComputedStyle(body).backgroundColor)',
    ].join('\n'))).toBe(true)
    // The helper's name a line up says what it reads.
    expect(flagged([
      'function luminance(css: string): number {',
      String.raw`  const nums = (css.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)`,
    ].join('\n'))).toBe(true)
    expect(flagged([
      'const chroma = (c: string) => {',
      String.raw`  const v = c.match(/\d+(\.\d+)?/g)!.map(Number)`,
      '  return Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2])',
      '}',
      'const hue = Math.max(chroma(cs.backgroundColor), chroma(cs.color))',
    ].join('\n'))).toBe(true)
    expect(flagged(String.raw`const [r, g, b] = (rest.split('|')[0].match(/\d+/g) ?? []).map(Number)`)).toBe(true)
    expect(flagged(String.raw`const alpha = Number((backgrounds.item.match(/[\d.]+\)$/) ?? ['1)'])[0]!.replace(')', ''))`)).toBe(true)
    expect(flagged(String.raw`const alpha = Number((m.boxBorder.match(/[\d.]+/g) ?? [])[3] ?? 1)`)).toBe(true)
    // Regexes written against colour syntax, and comma splits of a colour.
    expect(flagged(String.raw`const m = /rgba?\(([^)]+)\)/.exec(c)`)).toBe(true)
    expect(flagged(String.raw`if (b && !/rgba\(.*, 0\)$/.test(b)) bg = b`)).toBe(true)
    expect(flagged(String.raw`const hsl = /hsl\(\s*[\d.]+\s+([\d.]+)%/.exec(c)`)).toBe(true)
    expect(flagged(String.raw`const [r, g, b, a = '1'] = m[1].split(',').map((v) => v.trim())`)).toBe(true)
  })

  it('leaves numbers read out of other strings, assertions and the helper alone', () => {
    expect(flagged(String.raw`const [a, b, c, d, tx, ty] = (getComputedStyle(el).transform.match(/-?[\d.]+/g) ?? []).map(Number) // the colour swatch`)).toBe(false)
    expect(flagged(String.raw`const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/)`)).toBe(false)
    expect(flagged(String.raw`const [shown, total] = (count.match(/\d+/g) ?? []).map(Number)`)).toBe(false)
    expect(flagged(String.raw`const size = Number(getComputedStyle(label).fontSize.match(/[\d.]+/)?.[0])`)).toBe(false)
    expect(flagged(String.raw`const m = meta.match(/([\d.]+)(k?) tokens/)`)).toBe(false)
    expect(flagged(String.raw`const [x, y, w, h] = key.match(/-?\d+/g)!.map(Number)`)).toBe(false)
    expect(flagged(String.raw`const page = Number(new URL(url).searchParams.get('page')!.match(/\d+/)![0])`)).toBe(false)
    expect(flagged(String.raw`expect(Number(/blur\(([\d.]+)px\)/.exec(look.background)?.[1] ?? 0)).toBeGreaterThanOrEqual(36)`)).toBe(false)
    expect(flagged(String.raw`expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)`)).toBe(false)
    expect(flagged(String.raw`const hex = text.replace(/rgba?\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []`)).toBe(false)
    expect(flagged("expect(cs.transitionDuration.split(',').every((d) => parseFloat(d) === 0)).toBe(true)")).toBe(false)
    expect(flagged('const lum = (v: number) => v / 255 / 12.92 + ratio / 2')).toBe(false)
    expect(flagged('const [r, g, b] = cssColorToRgba(look.bg)')).toBe(false)
    expect(flagged(String.raw`// c.match(/[\d.]+/g) once read rgb(...) here`)).toBe(false)
    expect(flagged("await page.route('**/api/tasks/**', (route) => route.fulfill({ json: { color: 'rgb(1, 2, 3)' } }))")).toBe(false)
    // A count parsed next to colour code is still a count.
    expect(flagged([
      'const bg = getComputedStyle(el).backgroundColor',
      String.raw`const total = Number(label.match(/\d+/)?.[0])`,
    ].join('\n'))).toBe(false)
  })

  it('reads the browser specs', () => {
    const files = tsFiles(SPECS)
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(HELPER)
  })

  it('the browser specs have none', () => {
    const found: string[] = []
    for (const file of tsFiles(SPECS)) {
      if (file === HELPER) continue
      for (const hit of findHandParses(fs.readFileSync(file, 'utf8'))) found.push(`${path.relative(SPECS, file)}:${hit}`)
    }
    expect(found, 'read the colour with cssColorToRgba or withCssColor from tests/e2e/browser/css-color.ts (see this file\'s header)').toEqual([])
  })
})
