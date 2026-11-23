/**
 * Every native fold (`<details><summary>`) wears the shared chevron, never the browser's own filled
 * triangle (2026-11-23, the user: "所有东西都应该统一啊", everything should be one; the first-run setup
 * card's "Other ways to connect" still showed the browser's triangle after every other fold took
 * DisclosureChevron). The summaries drew their mark four ways: the native triangle (most of them), a
 * per-site --wn-chevron mask, a DisclosureChevron inside, or nothing (the marker hidden, no chevron).
 *
 * One rule now draws it, in styles/choice-controls.css, for every <summary> in the document (ours, a
 * plugin's, HTML a model wrote into a reply): the native marker off, DisclosureChevron's chevron as
 * the summary's ::before, right when closed, turned down while its <details> is open. A summary that
 * puts DisclosureChevron in its markup as its first child shows that one alone. A site only places
 * the chevron (a grid column, a nudge); it never draws, hides or swaps it.
 *
 * What this scans (web/src, plugin-store, examples/plugins; comments removed), each baseline 0:
 *  1. the shared rule is in choice-controls.css, whole;
 *  2. no stylesheet turns the native marker back on for a summary (list-style, display: list-item,
 *     ::-webkit-details-marker shown, a ::marker of its own), and no summary does in an inline style;
 *  3. no stylesheet outside the home draws, hides or replaces a summary's chevron (a ::before rule that
 *     sets more than its place, a ::after mark), but for NO_MARK_ALLOWED with its reason;
 *  4. a summary with DisclosureChevron inside has it as its first child (else it shows two), and no
 *     summary holds another mark (MenuCaret, a chevron icon, an inline SVG).
 * The other marks (typed triangles, hand-drawn chevrons) are disclosure-mark-guard.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './css-scan'
import { stripComments } from './source-text-scan'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['web/src', 'plugin-store', 'examples/plugins'].map((d) => join(ROOT, d))
const HOME = 'web/src/styles/choice-controls.css'

/** A summary may go without the chevron only with a reason here (`<file>: <selector>`). None does today. */
const NO_MARK_ALLOWED: Record<string, string> = {}

const SUMMARY = /(^|[\s,>+~(])summary(?![-\w])/

function rules(css: string): { sel: string; body: string }[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.replace(/\s+/g, ' ').trim(), body: m[2]! }))
}

const decls = (body: string) =>
  body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':')
    return { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() }
  })

/** The selectors of a rule that are about a summary (a list may name other things too). */
const summaryParts = (sel: string) => sel.split(',').map((s) => s.trim()).filter((s) => SUMMARY.test(` ${s}`))

/** Rules that bring the browser's own marker back on a summary. */
export function findMarkerRevivals(css: string): string[] {
  const out: string[] = []
  for (const r of rules(css)) {
    for (const part of summaryParts(r.sel)) {
      const ds = decls(r.body)
      if (/::?marker\b/.test(part) && !/details-marker/.test(part)) { out.push(part); continue }
      if (/::-webkit-details-marker/.test(part)) {
        if (ds.some((d) => d.prop === 'display' && !/^none\b/.test(d.value))) out.push(part)
        continue
      }
      if (/::?(?:before|after)\b/.test(part)) continue
      if (ds.some((d) => (/^list-style(?:-type|-image|-position)?$/.test(d.prop) && !/^none\b/.test(d.value)) || (d.prop === 'display' && /\blist-item\b/.test(d.value)))) out.push(part)
    }
  }
  return out
}

/** What a site may set on a summary's ::before: its place, never its look. */
const PLACE = /^(?:grid-(?:column|row|area)(?:-start|-end)?|align-self|justify-self|order|position|top|right|bottom|left|inset(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|vertical-align)$/

/** Rules outside the home that draw, hide or replace a summary's chevron. */
export function findMarkOverrides(css: string): string[] {
  const out: string[] = []
  for (const r of rules(css)) {
    for (const part of summaryParts(r.sel)) {
      const ds = decls(r.body)
      if (/::?before\b/.test(part) && ds.some((d) => !PLACE.test(d.prop))) out.push(part)
      else if (/::?after\b/.test(part) && ds.some((d) => d.prop === 'content' && !/^(?:none|normal)\b/.test(d.value))) out.push(part)
    }
  }
  return out
}

/** `<summary>` markup that shows the native marker, two marks, or another mark. */
export function findSummaryMarkupIssues(src: string): { line: number; why: string }[] {
  const text = stripComments(src)
  const out: { line: number; why: string }[] = []
  for (const m of text.matchAll(/<summary\b([^>]*)>([\s\S]*?)<\/summary>/g)) {
    const line = text.slice(0, m.index).split('\n').length
    const attrs = m[1]!, inner = m[2]!
    if (/listStyle|list-style|['"]list-item['"]/.test(attrs)) out.push({ line, why: 'an inline style turns the native marker on' })
    // Comments are blanked, so a JSX comment before the chevron reads `{   }`.
    if (/DisclosureChevron|FoldChevron|wn-disclosure-chevron/.test(inner) && !/^\s*(?:\{\s*\}\s*)*<(?:DisclosureChevron|FoldChevron|span className=["']wn-disclosure-chevron)\b/.test(inner)) {
      out.push({ line, why: 'DisclosureChevron is not the first child, so the shared ::before shows too' })
    }
    if (/\bMenuCaret\b|\bICON_CHEVRON_\w+|<svg\b/.test(inner)) out.push({ line, why: 'a mark of its own beside the shared chevron' })
  }
  return out
}

const rel = (f: string) => relative(ROOT, f)
const CSS_FILES = DIRS.flatMap((d) => walk(d, ['.css']))
// A plugin's stylesheet can live in a TypeScript string (plugin-store/notes-import/src/web/styles.ts).
const STYLE_STRINGS = DIRS.flatMap((d) => walk(d, ['.ts'])).filter((f) => !/\.test\.|\.spec\./.test(f) && /\bsummary\s*[{,:>.[]/.test(readFileSync(f, 'utf8')))
const MARKUP = DIRS.flatMap((d) => walk(d, ['.tsx', '.ts'])).filter((f) => !/\.test\.|\.spec\./.test(f))

describe('every <summary> wears the shared chevron, never the native triangle', () => {
  it('the scans catch what they guard and pass what they do not', () => {
    // The marker back on: list-style, display list-item, the WebKit marker shown, a ::marker of its own.
    expect(findMarkerRevivals('.x > summary { list-style: disclosure-closed; }')).toEqual(['.x > summary'])
    expect(findMarkerRevivals('.x summary { list-style-position: inside; }')).toEqual(['.x summary'])
    expect(findMarkerRevivals('.a, .x > summary { display: list-item; }')).toEqual(['.x > summary'])
    expect(findMarkerRevivals('.x > summary::-webkit-details-marker { display: inline; }')).toEqual(['.x > summary::-webkit-details-marker'])
    expect(findMarkerRevivals('.x summary::marker { color: red; }')).toEqual(['.x summary::marker'])
    // Not a revival: hiding it, a flex row, a class named like a summary, a list elsewhere, a comment.
    expect(findMarkerRevivals(':where(summary) { list-style: none; }\n:where(summary)::-webkit-details-marker { display: none; }')).toEqual([])
    expect(findMarkerRevivals('.x > summary { display: flex; gap: 4px; }\n.op-card-summary { display: list-item; }\nul.x { list-style: disc; }')).toEqual([])
    expect(findMarkerRevivals('/* .x > summary { list-style: disc; } */')).toEqual([])
    // A site hiding, redrawing or swapping the chevron; placing it is fine.
    expect(findMarkOverrides('.x > summary::before { content: none; }')).toEqual(['.x > summary::before'])
    expect(findMarkOverrides('.x > summary::before { background: red; mask: none; }')).toEqual(['.x > summary::before'])
    expect(findMarkOverrides('.x[open] > summary::before { transform: rotate(180deg); }')).toEqual(['.x[open] > summary::before'])
    expect(findMarkOverrides(".x > summary::after { content: '+'; }")).toEqual(['.x > summary::after'])
    expect(findMarkOverrides('.x summary::before { grid-column: 1; grid-row: 1; position: relative; top: 0.2em; margin-inline-end: 6px; }')).toEqual([])
    expect(findMarkOverrides('.x-summary::before { content: none; }')).toEqual([])
    // Markup: an inline style that brings the marker back, a chevron that is not the first child, another mark.
    expect(findSummaryMarkupIssues("<summary style={{ listStyle: 'disclosure-closed' }}>Details</summary>").map((h) => h.line)).toEqual([1])
    expect(findSummaryMarkupIssues("<summary style={{ display: 'list-item' }}>Details</summary>").map((h) => h.line)).toEqual([1])
    expect(findSummaryMarkupIssues('<details>\n<summary><span>Files</span><DisclosureChevron open={o} /></summary></details>').map((h) => h.line)).toEqual([2])
    expect(findSummaryMarkupIssues('<summary>Plan <MenuCaret /></summary>')).toHaveLength(1)
    expect(findSummaryMarkupIssues('<summary>{ICON_CHEVRON_RIGHT} Prompt</summary>')).toHaveLength(1)
    // Fine: plain text (the shared ::before draws), DisclosureChevron first (with a comment before it).
    expect(findSummaryMarkupIssues("<summary>Other ways to connect</summary>\n<summary style={{ userSelect: 'none' }}>thinking</summary>")).toEqual([])
    expect(findSummaryMarkupIssues('<summary>\n  {/* turns down while open */}\n  <DisclosureChevron open={shown} className="x" />\n  <span>Files</span>\n</summary>')).toEqual([])
  })

  it('choice-controls.css holds the one rule: marker off, the chevron drawn, turned while open', () => {
    const home = new Map(rules(readFileSync(join(ROOT, HOME), 'utf8')).map((r) => [r.sel, decls(r.body)]))
    const value = (sel: string, prop: string) => home.get(sel)?.find((d) => d.prop === prop)?.value
    expect(value(':where(summary)', 'list-style')).toBe('none')
    expect(value(':where(summary)::-webkit-details-marker', 'display')).toBe('none')
    expect(value(':where(summary)::before', 'mask')).toMatch(/^var\(--wn-chevron\)/)
    expect(value(':where(summary)::before', '-webkit-mask')).toMatch(/^var\(--wn-chevron\)/)
    expect(value(':where(summary)::before', 'content')).toBe("''")
    expect(value(':where(details[open] > summary)::before', 'transform')).toBe('rotate(90deg)')
    expect(value(':where(summary:has(> .wn-disclosure-chevron))::before', 'content')).toBe('none')
  })

  it('no stylesheet turns the native marker back on for a summary', () => {
    expect(CSS_FILES.length, 'the scan sees the stylesheets it guards').toBeGreaterThan(100)
    expect(STYLE_STRINGS.map(rel), 'the scan sees the plugin stylesheet in a string').toContain('plugin-store/notes-import/src/web/styles.ts')
    const hits = [...CSS_FILES, ...STYLE_STRINGS].flatMap((f) => findMarkerRevivals(readFileSync(f, 'utf8')).map((s) => `${rel(f)}: ${s}`))
    expect(hits, 'the shared rule (choice-controls.css) hides the marker and draws the chevron; never bring the triangle back').toEqual([])
  })

  it('no stylesheet but the home draws, hides or swaps a summary\'s chevron', () => {
    const hits = [...CSS_FILES, ...STYLE_STRINGS].filter((f) => rel(f) !== HOME)
      .flatMap((f) => findMarkOverrides(readFileSync(f, 'utf8')).map((s) => `${rel(f)}: ${s}`))
      .filter((h) => !(h in NO_MARK_ALLOWED))
    expect(hits, 'a site only places the chevron (grid-column, margin, position); its look is choice-controls.css\'s').toEqual([])
    for (const key of Object.keys(NO_MARK_ALLOWED)) {
      const [file, sel] = key.split(': ')
      expect(findMarkOverrides(readFileSync(join(ROOT, file!), 'utf8')), `${key} still needs its entry`).toContain(sel)
    }
  })

  it('every <summary> in markup takes the shared chevron alone', () => {
    const all = MARKUP.flatMap((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(/<summary\b/g)])
    expect(all.length, 'the scan sees the summaries it guards').toBeGreaterThan(30)
    const hits = MARKUP.flatMap((f) => findSummaryMarkupIssues(readFileSync(f, 'utf8')).map((h) => `${rel(f)}:${h.line}: ${h.why}`))
    expect(hits, 'a summary holds its words (the shared ::before draws the chevron), or DisclosureChevron as its first child').toEqual([])
  })
})
