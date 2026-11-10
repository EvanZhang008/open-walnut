/**
 * A lazy stack on the phone sits right inside a scroll view, or says why it may sit elsewhere
 * (2026-11-10, the user: was Expand tested on iOS? the page got pushed out and the buttons were gone
 * for a while). A
 * LazyVStack nested in a card answers its height from estimates it keeps: the thread card's
 * summary and answers render Markdown through MarkdownView, whose LazyVStack left the card at the
 * old height after an Expand or Collapse, with blank bands above and below or the text and the
 * Acknowledge row spilling past the card. This lists every lazy stack in the app's source and
 * fails on a new one nobody classified, and on a MarkdownView made lazy where it is not a
 * scroll view's own content.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')

type Kind =
  /** The first view inside a `ScrollView {` (checked from the source). */
  | { kind: 'scroll-root' }
  /** Nested, and why that is safe. */
  | { kind: 'nested'; why: string }

/** `<file relative to ios-native/Walnut>:<n>` = the n-th lazy stack in that file (1-based). */
const LAZY: Record<string, Kind> = {
  'Markdown/MarkdownView.swift:1': { kind: 'nested', why: 'only when a caller passes lazy: true, which is listed in LAZY_MARKDOWN below' },
  'Views/Inbox/InboxItemTaskSelector.swift:1': { kind: 'scroll-root' },
  'Views/Sessions/FileSourceLinesView.swift:1': { kind: 'scroll-root' },
  'Views/Tasks/WorkCardSheet.swift:1': { kind: 'nested', why: 'rows of one fixed shape with no fold inside, and nothing is drawn around the stack' },
  'Views/Passwords/PasswordsHomeView.swift:1': { kind: 'nested', why: 'a grid of fixed-size tiles in a List section, which sizes its own rows' },
}

/** Every `MarkdownView(..., lazy: true)` and why it is a scroll view's own content. */
const LAZY_MARKDOWN: Record<string, string> = {
  'Views/Sessions/SessionExtrasSheets.swift': "the plan sheet: the Markdown is the ScrollView's only content",
}

const LAZY_RE = /\bLazy(?:VStack|HStack|VGrid|HGrid)\s*\(/g

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...swiftFiles(p))
    else if (e.name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** The source with `//` comments blanked, so a comment naming a lazy stack is no use of one. */
function code(src: string): string {
  return src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

function lazySites(): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of swiftFiles(APP)) {
    const src = code(fs.readFileSync(f, 'utf8'))
    let n = 0
    for (const m of src.matchAll(LAZY_RE)) {
      n += 1
      out.set(`${path.relative(APP, f)}:${n}`, m.index ?? 0)
    }
  }
  return out
}

describe('lazy stacks on the phone sit where their height cannot go stale', () => {
  it('every lazy stack is classified', () => {
    const found = [...lazySites().keys()].sort()
    const missing = found.filter((k) => !(k in LAZY))
    expect(missing, `classify these in LAZY (is it the first view in a ScrollView? if not, does anything around it change height?): ${missing.join(', ')}`).toEqual([])
    const gone = Object.keys(LAZY).filter((k) => !found.includes(k))
    expect(gone, 'listed but no longer lazy stacks: drop them').toEqual([])
  })

  it('a scroll-root lazy stack is the first view in its ScrollView', () => {
    for (const [key, at] of lazySites()) {
      if (LAZY[key]?.kind !== 'scroll-root') continue
      const file = key.slice(0, key.lastIndexOf(':'))
      const before = code(fs.readFileSync(path.join(APP, file), 'utf8')).slice(0, at).trimEnd()
      expect(before, key).toMatch(/ScrollView(?:\([^)]*\))?\s*\{$/)
    }
  })

  it('MarkdownView is eager unless a listed caller asks', () => {
    const view = fs.readFileSync(path.join(APP, 'Markdown/MarkdownView.swift'), 'utf8')
    expect(view).toMatch(/var lazy = false/)
    expect(code(view)).toMatch(/if lazy \{\s*LazyVStack\(/)
    const callers = swiftFiles(APP)
      .filter((f) => code(fs.readFileSync(f, 'utf8')).split('\n').some((l) => /\bMarkdownView\(/.test(l) && /\blazy:\s*true/.test(l)))
      .map((f) => path.relative(APP, f)).sort()
    expect(callers).toEqual(Object.keys(LAZY_MARKDOWN).sort())
  })

  it('the thread card renders its Markdown through the eager default', () => {
    const cards = code(fs.readFileSync(path.join(APP, 'Views/Org/OrgThreadsView.swift'), 'utf8'))
    expect(cards).toMatch(/LetterMarkdownBody\(markdown:/)
    const body = code(fs.readFileSync(path.join(APP, 'Views/Inbox/LetterMarkdownBody.swift'), 'utf8'))
    expect(body).toMatch(/MarkdownView\(blocks: Self\.blocks\(for: markdown\)\)/)
  })
})
