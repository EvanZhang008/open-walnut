/**
 * A phone page of agent-written text scrolls up and down; a sideways drag over it is never Back
 * (2026-11-15: the user asked why the Org page's Threads moved left and right when it should only
 * scroll up and down). iOS 26 pops a pushed page on a rightward drag anywhere on its content, so a
 * slightly diagonal drag while reading slid the whole page right with its words cut at the edge,
 * and a longer one left it. `.noContentSwipeBack()` (ios-native/Walnut/Views/Shared/ReadingPageSwipe.swift)
 * keeps that drag on the page; Back stays the button and the swipe from the left edge.
 *
 * This finds every view in the app that shows agent text in a vertical scroll view (a file with a
 * vertical `ScrollView` that renders Markdown, a thread card or a folded answer) and fails on one
 * nobody classified: pushed onto a navigation stack (the file named, the view itself or the page it
 * sits in, applies the modifier) or shown only in a sheet, which has no content pop.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')

type Kind = { pushed: string } | { sheet: string }

/** `<file relative to ios-native/Walnut>` -> how it is shown. */
const PAGES: Record<string, Kind> = {
  'Views/Org/OrgThreadsView.swift': { pushed: 'Views/Org/OrgNodePage.swift' },
  'Views/Org/OrgBriefView.swift': { pushed: 'Views/Org/OrgNodePage.swift' },
  'Views/Inbox/LetterReaderView.swift': { pushed: 'Views/Inbox/LetterReaderView.swift' },
  'Views/Sessions/SessionExtrasSheets.swift': { sheet: 'the plan sheet: a sheet has no content pop' },
  'Timeline/TimelineHarnessView.swift': { sheet: 'the DEBUG harness shows its table letter in a sheet' },
}

/** Views that draw agent-written text, which can hold anything (paths, URLs, code, tables). */
const AGENT_TEXT_RE = /\b(?:MarkdownView|LetterMarkdownBody|OrgThreadCard|OrgFoldedMarkdown|OrgThreadAnswer)\s*\(/
/** A vertical scroll view: `ScrollView {`, `ScrollView(.vertical...`, `ScrollView(showsIndicators:`. */
const VERTICAL_SCROLL_RE = /\bScrollView\s*(?:\{|\(\s*(?:\.vertical|showsIndicators\s*:))/

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return swiftFiles(p)
    return e.name.endsWith('.swift') ? [p] : []
  })
}

/** Source with its line and block comments blanked, so a comment naming a view counts for nothing. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const read = (rel: string) => code(fs.readFileSync(path.join(APP, rel), 'utf8'))

describe('iOS pages of agent text: a sideways drag is never Back', () => {
  const found = swiftFiles(APP)
    .map((f) => path.relative(APP, f))
    .filter((rel) => { const src = read(rel); return AGENT_TEXT_RE.test(src) && VERTICAL_SCROLL_RE.test(src) })
    .sort()

  it('every page of agent text in a vertical scroll is classified', () => {
    const unknown = found.filter((f) => !PAGES[f])
    expect(unknown, 'classify each in PAGES: pushed (and add .noContentSwipeBack() to its page) or sheet').toEqual([])
    expect(Object.keys(PAGES).filter((f) => !found.includes(f)), 'PAGES names a file that no longer shows agent text').toEqual([])
  })

  it('each pushed one sits in a page that turns the content pop off', () => {
    const missing = Object.entries(PAGES)
      .flatMap(([file, kind]) => ('pushed' in kind && !/\.noContentSwipeBack\(\)/.test(read(kind.pushed)) ? [`${file} (in ${kind.pushed})`] : []))
    expect(missing).toEqual([])
  })

  it('the modifier makes the content pop wait for the page\'s own sideways pan', () => {
    const src = read('Views/Shared/ReadingPageSwipe.swift')
    expect(src).toMatch(/func noContentSwipeBack\(\) -> some View/)
    expect(src).toMatch(/interactiveContentPopGestureRecognizer\?\.require\(toFail: pan\)/)
  })
})
