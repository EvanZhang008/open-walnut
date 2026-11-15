/**
 * A phone page that scrolls up and down never slides sideways (2026-11-15, the user, on the Org
 * page's Threads: "为什么 ... 我可以左右滑 ... 它不就是上下的一个滑动吗"). A vertical ScrollView takes
 * its content's frame as the scrollable area, so content a few points wider than the screen made the
 * whole page drag sideways with every card's words cut at the edge. The fix is one modifier,
 * `.pageWidth()` (ios-native/Walnut/Views/Shared/PageWidth.swift), on the content of every vertical
 * page that shows agent-written text. This finds every such page in the app's source (a file with a
 * vertical `ScrollView` that renders Markdown, a thread card or a folded answer) and fails on one
 * whose scroll views outnumber its `.pageWidth()` calls, so a new page joins the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')

/** Views that draw agent-written text, which can hold anything (paths, URLs, code, tables). */
const AGENT_TEXT_RE = /\b(?:MarkdownView|LetterMarkdownBody|OrgThreadCard|OrgFoldedMarkdown|OrgThreadAnswer)\s*\(/
/** A vertical scroll view: `ScrollView {`, `ScrollView(.vertical...`, `ScrollView(showsIndicators:`. */
const VERTICAL_SCROLL_RE = /\bScrollView\s*(?:\{|\(\s*(?:\.vertical|showsIndicators\s*:))/g
const PAGE_WIDTH_RE = /\.pageWidth\(\)/g

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return swiftFiles(p)
    return e.name.endsWith('.swift') ? [p] : []
  })
}

/** Source with its line and block comments blanked, so a comment naming a view counts for nothing. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

describe('iOS vertical pages of agent text keep the page width', () => {
  const pages = swiftFiles(APP)
    .map((f) => ({ file: path.relative(APP, f), src: code(fs.readFileSync(f, 'utf8')) }))
    .filter((p) => AGENT_TEXT_RE.test(p.src) && (p.src.match(VERTICAL_SCROLL_RE) ?? []).length > 0)

  it('finds the pages it guards (the Org Threads and Brief, the Inbox letter)', () => {
    const names = pages.map((p) => p.file)
    for (const known of ['Views/Org/OrgThreadsView.swift', 'Views/Org/OrgBriefView.swift', 'Views/Inbox/LetterReaderView.swift']) {
      expect(names).toContain(known)
    }
  })

  it('every vertical scroll view on such a page puts .pageWidth() on its content', () => {
    const short = pages
      .map((p) => ({ file: p.file, scrolls: (p.src.match(VERTICAL_SCROLL_RE) ?? []).length, fixed: (p.src.match(PAGE_WIDTH_RE) ?? []).length }))
      .filter((p) => p.fixed < p.scrolls)
      .map((p) => `${p.file}: ${p.scrolls} vertical ScrollView, ${p.fixed} .pageWidth()`)
    expect(short, 'add .pageWidth() to the content of each vertical ScrollView listed (see Views/Shared/PageWidth.swift)').toEqual([])
  })

  it('.pageWidth() makes the content exactly as wide as the page', () => {
    const src = code(fs.readFileSync(path.join(APP, 'Views/Shared/PageWidth.swift'), 'utf8'))
    expect(src).toMatch(/func pageWidth\(\) -> some View \{\s*containerRelativeFrame\(\.horizontal/)
  })
})
