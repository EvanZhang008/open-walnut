/**
 * A hidden note (docs/reference/locked-notes.md, "Hidden notes") is plain text the person's own
 * window reads whole, so the web is what keeps it covered until Show and away from every model.
 *
 * The class: a web surface that reads a note's text from the notes routes (fetchNoteContent, the
 * note cache, useNoteContent). Each one is found from the source and must be classified here:
 * either it puts the text on screen and handles a hidden note (covers it, or shows the hidden
 * line), or it shows nothing of it. A NEW reader fails until it is classified, so a surface that
 * would paint a hidden note's text without Show cannot appear unseen.
 *
 * Also guarded: the Notes page never names a hidden or locked note to its chat, and the tree's
 * agent launchers are not offered on one.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const WEB_SRC = path.join(ROOT, 'web/src')
const READS = /\b(fetchNoteContent|useNoteContent|loadNoteIntoCache|peekCachedNote|getCachedNote|prefetchNoteContent|prefetchNoteOnHover)\(/

/** Readers that put the text on screen, with what in their source shows they handle a hidden note. */
const SHOWS_TEXT: Record<string, RegExp> = {
  'hooks/useNoteContent.ts': /noteProtectionOf\(frontmatterRef\.current, body\)/,
  'pages/NotesPage.tsx': /hidden=\{protection === 'hidden'\}/,
  'popout/PopoutNote.tsx': /protection === 'hidden' && !loading && !cover\.shown\) return <HiddenNoteCover /,
  'components/tasks/ProjectTrackingBlock.tsx': /isHiddenNote\(frontmatter, body\) \? HIDDEN_NOTE_LINE/,
}

/** Readers that show nothing of the text, and why. */
const NO_TEXT: Record<string, string> = {
  'api/notes-v2.ts': 'the client itself',
  'stores/note-content-cache.ts': 'the page-memory cache: it holds, never shows',
  'components/notes/useLockNote.ts': 'reads the note again after a hide or a lock, for the open editor',
  'components/notes/vault-raw-io.ts': 'the raw view of an editor that is already shown',
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

const src = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

describe('web surfaces that read a note\'s text', () => {
  const readers = walk(WEB_SRC).map((f) => path.relative(WEB_SRC, f)).filter((rel) => READS.test(src(rel))).sort()

  it('are all classified', () => {
    const unclassified = readers.filter((r) => !(r in SHOWS_TEXT) && !(r in NO_TEXT))
    expect(unclassified, 'A new reader of note text: if it shows the text, cover a hidden note (HiddenNoteCover.tsx) or show HIDDEN_NOTE_LINE, and add it to SHOWS_TEXT; else add it to NO_TEXT with why').toEqual([])
    const stale = [...Object.keys(SHOWS_TEXT), ...Object.keys(NO_TEXT)].filter((r) => !readers.includes(r))
    expect(stale, 'Listed but no longer a reader: remove it').toEqual([])
  })

  it('cover a hidden note, or show its line, wherever they show the text', () => {
    for (const [rel, handled] of Object.entries(SHOWS_TEXT)) expect(src(rel), rel).toMatch(handled)
  })

  it('the Notes editor covers a hidden note until Show and turns dictation off while shown', () => {
    const panel = src('components/notes/NotesEditorPanel.tsx')
    expect(panel).toMatch(/if \(hidden && !cover\.shown\) return <HiddenNoteCover /)
    expect(panel).toMatch(/dictation=\{!hidden\}/)
    expect(src('popout/PopoutNote.tsx')).toMatch(/dictation=\{protection !== 'hidden'\}/)
  })
})

describe('the Notes page\'s AI entry points', () => {
  it('never name a hidden or locked note to the chat', () => {
    const page = src('pages/NotesPage.tsx')
    const chats = [...page.matchAll(/<NotesChat\b[^>]*>/g)].map((m) => m[0])
    expect(chats.length).toBeGreaterThan(0)
    for (const chat of chats) expect(chat).toMatch(/activeNotePath=\{protection \? null : activeNotePath\}/)
  })

  it('offer no agent chat or session on a hidden or locked note in the tree', () => {
    const tree = src('components/notes/NotesTreePanel.tsx')
    for (const launcher of ['onStartAgentChat', 'onStartSession']) {
      expect(tree, launcher).toMatch(new RegExp(`\\{${launcher} && contextMenu\\.node\\.kind !== 'attachment' && !marks\\.has\\(contextMenu\\.node\\.path\\) &&`))
    }
  })
})
