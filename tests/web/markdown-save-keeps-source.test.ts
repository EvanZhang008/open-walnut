/**
 * Every surface that saves a WYSIWYG editor's Markdown keeps the document's own
 * bytes on the lines the user did not edit (markdownKeepingSource,
 * web/src/components/notes/editor-keep-source.ts).
 *
 * tiptap-markdown does not round-trip byte for byte, so a save of the raw
 * serializer output rewrites lines nobody touched. That bug was fixed in the Files
 * panel first (2026-11-07: one typed sentence changed 24 other lines of a 153-line
 * note) and then found again in the Notes editor, the home notes panel and the
 * task/memory fields, which all saved `getMarkdown()` as it is.
 *
 * This ratchet reads the raw serializer the only way it can be read
 * (`getMarkdown`, `serializer.serialize`) and fails when a module reads it that is
 * not listed below with why its use is not a save, or when a listed module reads it
 * more often than listed. A new editor surface that saves Markdown must go through
 * markdownKeepingSource instead. The byte-level behaviour is pinned per surface by
 * tests/e2e/browser/markdown-save-keeps-source.spec.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../web/src')

/** Modules that read the raw serializer output, how often, and why that is not a save. */
const RAW_READS: Record<string, { count: number; why: string }> = {
  'components/notes/editor-keep-source.ts': { count: 2, why: 'the helper itself' },
  'components/common/FileMarkdownEditor.tsx': {
    count: 3,
    why: 'getValue hands the body to markdownKeepingSource; setValue and the clean check only compare',
  },
  'components/notes/NotesEditor.tsx': { count: 1, why: 'the external content sync compares, it does not save' },
  'components/notes/MarkdownEditorPanel.tsx': {
    count: 3,
    why: 'the raw (source) view mirrors and compares the doc; its edits reach disk through the hook that saves',
  },
  'hooks/useNoteContent.ts': { count: 1, why: 'after a merge, compares the merged body with the doc before reloading it' },
  'components/notes/extensions/markdown-copy.ts': { count: 2, why: 'Markdown for the clipboard, not for disk' },
}

/** Modules that save an editor's Markdown: each must use markdownKeepingSource. */
const SAVERS = [
  'components/common/FileMarkdownEditor.tsx',
  'hooks/useNoteContent.ts',
  'hooks/useGlobalNotes.ts',
  'hooks/useFieldContent.ts',
]

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** Source with comments blanked, so a comment that names getMarkdown does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const RAW = /\bgetMarkdown\b|\bserializer\s*\??\.\s*serialize\s*\(/g

describe('every editor surface that saves Markdown keeps the source bytes', () => {
  const reads = new Map<string, number>()
  for (const file of walk(ROOT)) {
    const n = (code(fs.readFileSync(file, 'utf8')).match(RAW) ?? []).length
    if (n) reads.set(path.relative(ROOT, file).split(path.sep).join('/'), n)
  }

  it('no module reads the raw serializer output unless it is listed with why it is not a save', () => {
    const unlisted = [...reads.keys()].filter((f) => !RAW_READS[f])
    expect(unlisted, 'save through markdownKeepingSource, or list the module in RAW_READS with why it is not a save').toEqual([])
  })

  it('a listed module reads it no more often than listed (a new read may be a new save)', () => {
    const over = [...reads].filter(([f, n]) => RAW_READS[f] && n > RAW_READS[f].count).map(([f, n]) => `${f}: ${n} > ${RAW_READS[f].count}`)
    expect(over).toEqual([])
  })

  it('the list holds no module that no longer reads it', () => {
    const stale = Object.keys(RAW_READS).filter((f) => (reads.get(f) ?? 0) < RAW_READS[f].count)
    expect(stale, 'lower the count or drop the entry').toEqual([])
  })

  it('every module that saves editor Markdown goes through markdownKeepingSource', () => {
    const missing = SAVERS.filter((f) => !/\bmarkdownKeepingSource\s*\(/.test(code(fs.readFileSync(path.join(ROOT, f), 'utf8'))))
    expect(missing).toEqual([])
  })
})
