/**
 * Every expand/collapse mark is one of two shared drawings, never a typed triangle, never a chevron a
 * file draws for itself (2026-11-23, the user: "所有东西都应该统一啊", everything should be one). The web
 * UI drew its marks many ways: text triangles, typed angle quotes, a bordered box turned 45deg, SVG
 * chevrons copied into a dozen files at a dozen sizes and strokes, and one icon swapped for another
 * on open. So the same fold looked different on every surface.
 *
 * Two marks, two shared components (web/src/components/controls/Disclosure.tsx):
 *  - a fold (shows or hides what is under it): `DisclosureChevron`, right when closed, down when open;
 *  - a key that opens a menu or picker: `MenuCaret`, a down chevron that flips while the menu is open.
 * A direction (back, next and previous, a submenu's arrow, a row that goes somewhere, a sort order)
 * is not a fold: it takes ICON_CHEVRON_LEFT / ICON_CHEVRON_RIGHT from Icons.tsx. A spot only CSS can
 * draw masks --wn-chevron (choice-controls.css). A plugin, which cannot import host components,
 * draws DisclosureChevron's markup with the host's class (PLUGIN_MIRROR, checked to stay the same).
 *
 * What this scans (web/src, plugin-store, examples/plugins; comments removed, escapes decoded), each
 * baseline 0:
 *  1. a typed triangle (U+25B2 to U+25C4) or its CSS escape; a typed angle chevron as a mark (a
 *     class named chevron, caret or arrow holding one, two of them swapped, a CSS `content`);
 *  2. a bordered box turned into a chevron in CSS, or a caret drawn as a border triangle;
 *  3. a component or constant named like a chevron or caret, outside Disclosure.tsx and Icons.tsx;
 *  4. ICON_CHEVRON_DOWN / ICON_CHEVRON_UP (the fold and caret directions) outside the shared
 *     components, but for FOLD_ICON_ALLOWED; and a ternary that swaps a chevron icon for another;
 *  5. an inline SVG that draws a chevron by hand (one open two-arm line of equal arms).
 * One known holdout, counted so it only falls: the session timeline's StepIcon chevron.
 * That a picker key wears MenuCaret and carries aria-haspopup is menu-key-mark-guard.test.ts.
 * That every native <summary> wears the same chevron (one rule, choice-controls.css) is
 * summary-mark-guard.test.ts.
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

/**
 * A caret drawn in CSS as a border triangle (two transparent sides and one solid: the quick bar's
 * recipient key drew its caret so until 2026-11-23). Only a mark's slot is read (a class named caret,
 * chevron, fold, toggle or disclosure), so a tooltip's or a speech bubble's tail stays free.
 */
export function findBorderCarets(css: string): string[] {
  const text = stripComments(css)
  const out: string[] = []
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]!
    const clear = body.match(/border-(?:top|right|bottom|left)\s*:[^;]*transparent/g) ?? []
    const solid = /border-(?:top|right|bottom|left)\s*:(?![^;]*transparent)[^;]*solid/.test(body)
    if (clear.length >= 2 && solid && /caret|chevron|fold|toggle|disclos/i.test(m[1]!)) out.push(m[1]!.trim())
  }
  return out
}

/** The files that draw the two marks and the direction icons; every other file uses them. */
const HOMES = new Set(['web/src/components/controls/Disclosure.tsx', 'web/src/components/common/Icons.tsx'])
/** The walnut-time plugin's copy of DisclosureChevron (a plugin cannot import host components). */
const PLUGIN_MIRROR = 'examples/plugins/walnut-time/src/web/fold-chevron.tsx'

/** Typed angle chevrons: single angle quotes, the up and down arrowheads, the heavy ornaments. */
const ANGLE = '[\u2039\u203A\u2303\u2304\u276E\u276F]'
const TYPED_MARK = [
  // `{open ? '<' : '>'}`: two typed chevrons swapped by state.
  new RegExp(`\\?\\s*['"\`]\\s*${ANGLE}\\s*['"\`]\\s*:\\s*['"\`]\\s*${ANGLE}\\s*['"\`]`),
  // `<span className="x-chevron">>`: a mark slot holding a typed one.
  new RegExp(`className=\\{?[\`'"][^\`'"]*(?:chevron|caret|arrow)[^\`'"]*[\`'"][^>]*>\\s*(?:\\{\\s*['"\`]\\s*)?${ANGLE}`, 'i'),
  // CSS `content: '>'` (or its escape).
  new RegExp(`content\\s*:\\s*['"]\\s*(?:${ANGLE}|\\\\0*(?:203[9Aa]|230[34]|276[EeFf]))`),
]

export function findTypedChevronMarks(src: string): number[] {
  const lines = decodeEscapes(stripComments(src)).split('\n')
  return lines.flatMap((l, i) => (TYPED_MARK.some((re) => re.test(l)) ? [i + 1] : []))
}

/**
 * A component or a drawing named like a chevron or caret: `function FoldChevron(`, `const Chevron = (`,
 * `const ICON_CARET = <svg`. A string constant (a selector list, a text caret) draws nothing.
 */
export function findChevronComponents(src: string): string[] {
  const out: string[] = []
  const text = stripComments(src)
  for (const m of text.matchAll(/\b(?:function|class)\s+([A-Z][A-Za-z0-9_]*)\b|\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?=[<(]|function\b|(?:React\.)?(?:memo|forwardRef)\b)/g)) {
    const name = m[1] ?? m[2]!
    if (/chevron|caret/i.test(name)) out.push(name)
  }
  return out
}

/** The fold and caret directions used directly, and a chevron icon swapped for another by state. */
export function findFoldIconUses(src: string): number[] {
  const lines = stripComments(src).split('\n')
  return lines.flatMap((l, i) => (/\bICON_CHEVRON_(?:DOWN|UP)\b/.test(l) ? [i + 1] : []))
}

export function findChevronIconSwaps(src: string): number[] {
  const lines = stripComments(src).split('\n')
  const swap = /\?\s*(?:\w+\.)?(ICON_CHEVRON_\w+)\s*:\s*(?:\w+\.)?(ICON_CHEVRON_\w+)/
  return lines.flatMap((l, i) => {
    const m = swap.exec(l)
    // Left for right is a direction turning round (a side bar's collapse); down or up in a swap is a fold.
    return m && /_(?:DOWN|UP)\b/.test(`${m[1]} ${m[2]}`) ? [i + 1] : []
  })
}

/**
 * The open lines of a polyline, or of a path made of moves and straight lines (relative ones
 * resolved): one run per move, so the up-and-down pair of a select's chevrons is two runs.
 */
function lineRuns(tag: string): number[][][] | null {
  const pts = /\bpoints=["'{`]+([^"'}`]+)/.exec(tag)?.[1]
  if (pts) {
    const n = pts.match(/-?\d*\.?\d+/g)!.map(Number)
    return n.length % 2 ? null : [n.flatMap((_, i) => (i % 2 ? [] : [[n[i]!, n[i + 1]!]]))]
  }
  const d = /\bd=["'{`]+([^"'}`]+)/.exec(tag)?.[1]
  if (!d || /[^MmLl\d\s.,-]/.test(d)) return null
  const runs: number[][][] = []
  let relative = false
  let last: number[] | undefined
  for (const tok of d.matchAll(/([MmLl])|(-?\d*\.?\d+)[\s,]*(-?\d*\.?\d+)/g)) {
    if (tok[1]) {
      relative = tok[1] === 'l' || tok[1] === 'm'
      if (/[Mm]/.test(tok[1])) runs.push([])
      continue
    }
    const x = Number(tok[2]), y = Number(tok[3])
    last = relative && last ? [last[0]! + x, last[1]! + y] : [x, y]
    runs.at(-1)?.push(last)
  }
  return runs.length ? runs : null
}

/**
 * An inline `<svg>` whose one shape is an open line of two equal arms (or a pair of them, a select's
 * up-and-down chevrons): a chevron drawn by hand.
 */
export function findDrawnChevrons(src: string): number[] {
  const text = stripComments(src)
  const out: number[] = []
  for (const m of text.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/g)) {
    const shapes = m[1]!.match(/<(?:path|polyline|polygon|line|circle|rect|ellipse|g|use)\b[^>]*>/g) ?? []
    if (shapes.length !== 1 || !/^<(?:path|polyline)\b/.test(shapes[0]!)) continue
    const runs = lineRuns(shapes[0]!)
    if (!runs || runs.length > 2) continue
    const arm = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)
    // A check mark has one short arm; a chevron's two are the same length.
    const chevron = (p: number[][]) => p.length === 3 && arm(p[0]!, p[1]!) / arm(p[1]!, p[2]!) > 0.85 && arm(p[0]!, p[1]!) / arm(p[1]!, p[2]!) < 1.18
    // A pair counts when it is stacked (a select's up and down); side by side it is the code icon's < >.
    const stacked = runs.length === 1 || Math.abs(runs[0]![1]![0]! - runs[1]![1]![0]!) < 0.5
    if (runs.every(chevron) && stacked) out.push(text.slice(0, m.index).split('\n').length)
  }
  return out
}

/**
 * The direction uses of ICON_CHEVRON_DOWN / ICON_CHEVRON_UP that stay: each file with why it is not a
 * fold or a menu key. Keep it short; a new entry needs the same kind of reason.
 */
const FOLD_ICON_ALLOWED: Record<string, string> = {
  'web/src/components/tasks/TasksPageTable.tsx': 'a column head\'s sort-order arrow (down descending, turned up ascending), not a fold or a menu',
}

const UI_FILES = DIRS.flatMap((d) => walk(d, ['.tsx', '.ts', '.css'])).filter((f) => !/\.test\.|\.spec\./.test(f))
const CODE_FILES = UI_FILES.filter((f) => !f.endsWith('.css'))
const rel = (f: string) => relative(ROOT, f)
const lineOf = (f: string, line: number) => `${rel(f)}:${line}: ${readFileSync(f, 'utf8').split('\n')[line - 1]!.trim().slice(0, 120)}`

describe('one chevron: the shared fold and menu caret, never one a file draws itself', () => {
  it('the scans catch what they guard and pass what they do not', () => {
    // Components and constants named like a chevron; a text caret's helpers and locals are not.
    expect(findChevronComponents('export function FoldChevron({ open }) {}\nconst Chevron = ({ back }) => (<svg />)\nfunction ChevronIcon() {}\nexport const ICON_CARET_DOWN = <svg />')).toEqual(['FoldChevron', 'Chevron', 'ChevronIcon', 'ICON_CARET_DOWN'])
    expect(findChevronComponents('function placeCaret(el) {}\nconst newCaret = at + 1\nconst handleChevronClick = useCallback(() => {})\n// function OldChevron() {}')).toEqual([])
    expect(findChevronComponents("export const CUT_CHEVRONS = '.a-chevron, .b-chevron'\nconst CARET = 'x'")).toEqual([])
    expect(findChevronComponents('const RowCaret = memo(function RowCaret() {})\nconst ICON_CHEVRON: ReactNode = <svg />')).toEqual(['RowCaret', 'RowCaret', 'ICON_CHEVRON'])
    // The fold and caret icons used by hand, and a swap of two chevron icons by state.
    expect(findFoldIconUses("<span className=\"x-caret\">{ICONS.ICON_CHEVRON_DOWN}</span>\n{ICON_CHEVRON_RIGHT}")).toEqual([1])
    expect(findChevronIconSwaps('{isOpen ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT}')).toEqual([1])
    expect(findChevronIconSwaps('{collapsed ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}')).toEqual([])
    // Chevrons drawn by hand: a polyline, a path, a relative path; not a check mark or a drawing of several shapes.
    expect(findDrawnChevrons('<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>')).toEqual([1])
    expect(findDrawnChevrons('<svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" /></svg>')).toEqual([1])
    expect(findDrawnChevrons("<svg viewBox=\"0 0 12 12\">\n  <path d='M3 4.5l3 3 3-3' />\n</svg>")).toEqual([1])
    expect(findDrawnChevrons('<svg {...S}><path d="m6 9 6 6 6-6" /></svg>')).toEqual([1])
    expect(findDrawnChevrons('<svg viewBox="0 0 10 14"><path d="M2 5l3-3 3 3M2 9l3 3 3-3" fill="none" /></svg>')).toEqual([1])
    expect(findDrawnChevrons('<svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10" /></svg>')).toEqual([])
    expect(findDrawnChevrons('<svg viewBox="0 0 24 24"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg>')).toEqual([])
    expect(findDrawnChevrons('<svg viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>')).toEqual([])
    expect(findDrawnChevrons('<svg><path d="M2.4 1.2 C2 6.2 2.9 9.7 6 9.8" /><path d="M8.4 8.1 L10.1 9.7 L8.4 11.2" /></svg>')).toEqual([])
    // Typed angle chevrons as marks (test data in escapes: '\u203A' right, '\u2039' left); text that
    // runs on ("Settings \u203A Voice", "Open \u203A") is a separator, not a mark.
    expect(findTypedChevronMarks("<span className={`tool-run-chevron${open ? ' is-open' : ''}`}>{'\u203A'}</span>")).toEqual([1])
    expect(findTypedChevronMarks("<span className=\"x\">{p.collapsed ? '\u2039' : '\u203A'}</span>")).toEqual([1])
    expect(findTypedChevronMarks(".x::before { content: '\u203A' / ''; }")).toEqual([1])
    expect(findTypedChevronMarks(String.raw`.x::before { content: '\203A'; }`)).toEqual([1])
    expect(findTypedChevronMarks("help=\"Set it up in Settings \u203A Voice.\"\n<span className=\"approval-row-open\">Open \u203A</span>")).toEqual([])
  })

  it('no file but Disclosure.tsx and Icons.tsx defines a chevron or caret component', () => {
    expect(CODE_FILES.length, 'the scan sees the UI it guards').toBeGreaterThan(500)
    const hits = CODE_FILES.filter((f) => !HOMES.has(rel(f)) && rel(f) !== PLUGIN_MIRROR)
      .flatMap((f) => findChevronComponents(readFileSync(f, 'utf8')).map((name) => `${rel(f)}: ${name}`))
    expect(hits, 'use DisclosureChevron (a fold) or MenuCaret (a menu key) from components/controls, or a direction icon of Icons.tsx').toEqual([])
  })

  it('the fold and caret directions of Icons.tsx are drawn only through the shared components', () => {
    const hits = CODE_FILES.filter((f) => !HOMES.has(rel(f)) && !(rel(f) in FOLD_ICON_ALLOWED))
      .flatMap((f) => findFoldIconUses(readFileSync(f, 'utf8')).map((line) => lineOf(f, line)))
    expect(hits, 'a fold takes DisclosureChevron, a menu key MenuCaret; ICON_CHEVRON_DOWN/UP by hand is a third look').toEqual([])
    for (const f of Object.keys(FOLD_ICON_ALLOWED)) expect(findFoldIconUses(readFileSync(join(ROOT, f), 'utf8')).length, `${f} still needs its entry`).toBeGreaterThan(0)
    const swaps = CODE_FILES.flatMap((f) => findChevronIconSwaps(readFileSync(f, 'utf8')).map((line) => lineOf(f, line)))
    expect(swaps, 'an open state swaps no icons: DisclosureChevron open={...} turns one chevron').toEqual([])
  })

  it('no file draws a chevron SVG by hand', () => {
    const hits = CODE_FILES.filter((f) => f.endsWith('.tsx') && !HOMES.has(rel(f)) && rel(f) !== PLUGIN_MIRROR)
      .flatMap((f) => findDrawnChevrons(readFileSync(f, 'utf8')).map((line) => lineOf(f, line)))
    expect(hits, 'a fold: DisclosureChevron; a menu key: MenuCaret; a direction: ICON_CHEVRON_LEFT/RIGHT (Icons.tsx)').toEqual([])
  })

  // The one chevron still outside the two components: the session timeline's StepIcon "chevron" (its
  // tool-run, op-card and tool-block folds, with their own --open rotation and sizes in step-rows.css).
  // Not merged yet; the count only falls, and no other icon set gets a chevron of its own.
  const STEP_ICON_CHEVRON_USES = 15
  it('the step rows\' StepIcon chevron only shrinks, and no icon set adds another', () => {
    const uses = CODE_FILES.flatMap((f) => readFileSync(f, 'utf8').match(/\bname=["{']+chevron["'}]/g) ?? [])
    expect(uses.length, 'a fold takes DisclosureChevron: lower STEP_ICON_CHEVRON_USES when you move one over').toBeLessThanOrEqual(STEP_ICON_CHEVRON_USES)
    const sets = CODE_FILES.filter((f) => !HOMES.has(rel(f)) && /^\s*['"]?(?:chevron|caret)\w*['"]?\s*:\s*\[\s*['"]M/im.test(stripComments(readFileSync(f, 'utf8'))))
    expect(sets.map(rel)).toEqual(['web/src/components/sessions/StepIcon.tsx'])
  })

  it("the plugin's mirror draws DisclosureChevron's chevron with the host's class", () => {
    const line = (src: string) => /<polyline points="([^"]+)"/.exec(src)?.[1]
    const host = readFileSync(join(ROOT, 'web/src/components/controls/Disclosure.tsx'), 'utf8')
    const mirror = readFileSync(join(ROOT, PLUGIN_MIRROR), 'utf8')
    expect(line(mirror)).toBe(line(host))
    expect(mirror).toContain('wn-disclosure-chevron')
  })

  it('no mark is a typed angle chevron (a class named chevron, caret or arrow holding one, a swap, a CSS content)', () => {
    const hits = UI_FILES.flatMap((f) => findTypedChevronMarks(readFileSync(f, 'utf8')).map((line) => lineOf(f, line)))
    expect(hits, 'draw it: DisclosureChevron, MenuCaret or a direction icon of Icons.tsx; in CSS mask --wn-chevron').toEqual([])
  })
})

describe('disclosure marks: icons only, never a typed triangle', () => {
  it('the CSS scan catches a bordered box turned into a chevron, and not the shared mask', () => {
    expect(findBoxChevrons('.x::after { width: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); }')).toEqual(['.x::after'])
    expect(findBoxChevrons('.x::after { background: currentColor; mask: var(--wn-chevron) center / contain no-repeat; transform: rotate(90deg); }')).toEqual([])
  })

  it('the CSS scan catches a caret drawn as a border triangle, and not a tooltip tail', () => {
    expect(findBorderCarets('.qb-to-caret { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--qb-muted); }')).toEqual(['.qb-to-caret'])
    expect(findBorderCarets('.tip-arrow { border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid var(--bg); }')).toEqual([])
    expect(findBorderCarets('.x-caret { color: var(--fg-muted); margin-left: 1px; }')).toEqual([])
  })

  it('no stylesheet draws a chevron or a caret from borders (MenuCaret, or mask --wn-chevron where only CSS can draw)', () => {
    const sheets = DIRS.flatMap((d) => walk(d, ['.css']))
    const hits = sheets.flatMap((f) => findBoxChevrons(readFileSync(f, 'utf8')).map((sel) => `${relative(ROOT, f)}: ${sel.slice(0, 120)}`))
    expect(hits, 'draw it with the shared chevron: background currentColor, mask var(--wn-chevron) (choice-controls.css)').toEqual([])
    const carets = sheets.flatMap((f) => findBorderCarets(readFileSync(f, 'utf8')).map((sel) => `${relative(ROOT, f)}: ${sel.slice(0, 120)}`))
    expect(carets, 'a key that opens a menu takes MenuCaret (components/controls), never a triangle of borders').toEqual([])
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
