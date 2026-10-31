/**
 * No color emoji where an icon is meant (spec 4.2, C73). iOS draws a play
 * triangle, a question ornament, a warning sign, pause and the curved arrow
 * as color emoji unless the character is followed by U+FE0E (text
 * presentation), so the phone's buttons and status marks turned into
 * stickers. Icons come from components/common/Icons.tsx or PhoneIcons.tsx.
 *
 * Scans the JSX text and string literals of web/src/**\/*.tsx (comments are
 * skipped). A ratchet: files listed in BASELINE may keep the count they have
 * today and never grow it; every other file must have none. The six files
 * the spec names (session tool block, streaming prompt, session error banner,
 * side question drawer, task start button, notification problems) are not in
 * the baseline: this test stays red until their replacements land.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WEB_SRC = join(ROOT, 'web', 'src')
const TEXT_PRESENTATION = '\uFE0E'

/** The spec's list, drawn as emoji by iOS even though their default is text. */
const IOS_EMOJI_GLYPHS = [0x25b6, 0x2753, 0x26a0, 0x23f8, 0x2934]
/** Emoji_Presentation=Yes code points that show up in UI code. */
const EMOJI_PRESENTATION_RANGES: [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26d4, 0x26d4], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x1f300, 0x1faff],
]

export function isEmojiProne(cp: number): boolean {
  if (IOS_EMOJI_GLYPHS.includes(cp)) return true
  return EMOJI_PRESENTATION_RANGES.some(([a, b]) => cp >= a && cp <= b)
}

/** Blank out comments, keep line numbers. Line comments only after space/start. */
export function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
}

/**
 * Decode `\uXXXX` and `\u{X...}` escapes into the characters they render, so
 * `'\u25B6'` in source counts like a literal one (C73: the ratchet used to
 * read only literal characters and missed every escaped play triangle).
 * Escapes hold no newline, so line numbers stay put.
 */
export function decodeEscapes(src: string): string {
  return src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}

/** Emoji-prone characters not followed by U+FE0E, with their line numbers. */
export function findEmojiGlyphs(src: string): { line: number; cp: number }[] {
  const text = decodeEscapes(stripComments(src))
  const hits: { line: number; cp: number }[] = []
  let line = 1
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === '\n') { line += 1; continue }
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x2000) continue
    if (isEmojiProne(cp) && chars[i + 1] !== TEXT_PRESENTATION) hits.push({ line, cp })
  }
  return hits
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * Today's count per file (relative to web/src). Lower a number when a glyph
 * goes; never raise one. The spec's six files keep only what is not on the
 * iOS list (the side question drawer's trash can).
 */
const BASELINE: Record<string, number> = {
  'components/chat/ChatInput.tsx': 1,
  'components/chat/ChatMessage.tsx': 1,
  'components/chat/FileMentionPopup.tsx': 4,
  'components/common/MicButton.tsx': 1,
  'components/common/NotificationSystemPane.tsx': 2,
  'components/notes/NotesBubbleMenu.tsx': 1,
  // Escaped in source ('\\u{1F4CE}'): counted since the ratchet decodes escapes.
  'components/notes/WikiEmbedView.tsx': 1,
  'components/routines/RoutineForm.tsx': 1,
  'components/sessions/ComposerModelPill.tsx': 1,
  'components/sessions/FileTreeEditRow.tsx': 2,
  'components/sessions/ModelPicker.tsx': 3,
  'components/sessions/SessionDiffView.tsx': 1,
  'components/sessions/SessionFileExplorer.tsx': 4,
  'components/sessions/SideQuestionDrawer.tsx': 1,
  'components/sessions/WorkflowGraph.tsx': 1,
  'components/sessions/path-selector/PathList.tsx': 1,
  'components/tasks/ProjectHeaderMenus.tsx': 1,
  'components/tasks/TasksPageRail.tsx': 2,
  'components/tasks/TasksPageTable.tsx': 6,
  'pages/CalendarPage.tsx': 1,
}

/** The files the spec names: none of the iOS list may remain in them. */
const SPEC_FILES = [
  'components/sessions/BashToolCall.tsx',
  'components/sessions/StreamingBlockView.tsx',
  'components/sessions/SessionPanel.tsx',
  'components/sessions/SideQuestionDrawer.tsx',
  'components/tasks/TaskStartButton.tsx',
  'components/common/NotificationProblems.tsx',
]

const fmt = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

describe('no color emoji glyphs in UI code', () => {
  it('finds glyphs in text and strings, not in comments, and honors U+FE0E', () => {
    const src = [
      '// \u25B6 a comment',
      '/* \u26A0 block */',
      "const a = '\u25B6'",
      "const b = '\u25B6\uFE0E'",
      '<span>\u2753</span>',
      "const url = 'https://x.test/a' // \u23F8 trailing",
    ].join('\n')
    expect(findEmojiGlyphs(src)).toEqual([{ line: 3, cp: 0x25b6 }, { line: 5, cp: 0x2753 }])
  })

  it('counts escaped glyphs in source as the characters they render', () => {
    const src = [
      String.raw`const open = '\u25B6'`,
      String.raw`const ok = '\u25B6\uFE0E'`,
      String.raw`const wrench = '\u{1F527}'`,
    ].join('\n')
    expect(findEmojiGlyphs(src)).toEqual([{ line: 1, cp: 0x25b6 }, { line: 3, cp: 0x1f527 }])
  })

  it('the six files the spec names carry none of the iOS list', () => {
    const left: string[] = []
    for (const rel of SPEC_FILES) {
      const src = readFileSync(join(WEB_SRC, rel), 'utf8')
      for (const h of findEmojiGlyphs(src)) {
        if (IOS_EMOJI_GLYPHS.includes(h.cp)) left.push(`${rel}:${h.line} ${fmt(h.cp)}`)
      }
    }
    expect(left).toEqual([])
  })

  it('no file has more emoji-prone glyphs than its baseline', () => {
    const over: string[] = []
    for (const f of tsxFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, f).split('\\').join('/')
      const hits = findEmojiGlyphs(readFileSync(f, 'utf8'))
      const allowed = BASELINE[rel] ?? 0
      if (hits.length > allowed) {
        over.push(`${rel}: ${hits.length} > ${allowed} (${hits.map((h) => `${h.line}:${fmt(h.cp)}`).join(', ')})`)
      }
    }
    expect(over).toEqual([])
  })
})
