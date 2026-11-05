/**
 * Every editable document in the web app is reachable by a find bar.
 *
 * 2026-11-04, the user in the Mac app: Cmd+F over an open note found nothing,
 * "it doesn't even find it", though the words were on screen. The page find
 * skips every contenteditable (a composer, a title being renamed), and the
 * note's editor is one, so its words never counted. The fix marks a document
 * with `data-find-doc` (utils/find-doc.ts), and a CodeMirror source view gets
 * the search field the bar drives through it.
 *
 * This guard lists, from the source, every file that mounts an editor
 * (TipTap's EditorContent, a CodeMirror EditorView, a contentEditable element)
 * and fails on one it does not know, so a new editing surface has to say how
 * its text is found. Behaviour: tests/e2e/browser/notes-find.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../..')
const WEB = join(ROOT, 'web/src')

type How =
  | { kind: 'doc'; why: string }
  | { kind: 'cm-search'; why: string }
  | { kind: 'not-a-document'; why: string }

/** Every editor-mounting file, and how a find reaches its text. */
const KNOWN: Record<string, How> = {
  'web/src/components/notes/NotesEditor.tsx': { kind: 'doc', why: 'every TipTap note editor, wherever it is hosted' },
  'web/src/components/notes/RawMarkdownView.tsx': { kind: 'cm-search', why: 'raw markdown: CodeMirror draws only the lines in view' },
  'web/src/components/common/FileSourceEditor.tsx': { kind: 'cm-search', why: "the file viewer's source editor, searched by FileContentView's own bar" },
  'web/src/components/common/CollapsibleUrlEditor.tsx': { kind: 'not-a-document', why: 'a one-line field for a URL' },
  'web/src/components/notes/WikiEmbedView.tsx': { kind: 'not-a-document', why: 'contentEditable={false} on an embed inside a note, searched with the note' },
  'web/src/components/tasks/useInlineTitleEdit.ts': { kind: 'not-a-document', why: 'a task title being renamed' },
}

const MOUNTS = [
  /<EditorContent\b/,
  /\bnew EditorView\(/,
  /\bcontentEditable(?:=|:\s)/,
  /\.contentEditable\s*=[^=]/,
  /setAttribute\('contenteditable'/,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p)
  }
  return out
}

/** Source without comments, so a mention in prose is not a mount. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('find reaches every editable document', () => {
  const files = walk(WEB)
    .map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }))
    .filter((f) => MOUNTS.some((re) => re.test(code(f.src))))

  it('finds the editors it knows (the scan still works)', () => {
    const found = files.map((f) => f.rel)
    for (const k of Object.keys(KNOWN)) expect(found, `${k} no longer mounts an editor: drop it from KNOWN`).toContain(k)
  })

  it('every editor-mounting file is listed with how its text is found', () => {
    const unknown = files.map((f) => f.rel).filter((r) => !KNOWN[r])
    expect(unknown, 'a new editing surface: mark its document with data-find-doc (utils/find-doc.ts), '
      + 'give a CodeMirror view cmSearchExtension(), or list it as not a document, with why').toEqual([])
  })

  for (const f of files) {
    const how = KNOWN[f.rel]
    if (!how) continue
    it(`${f.rel}: ${how.kind} (${how.why})`, () => {
      const c = code(f.src)
      if (how.kind === 'doc') expect(c).toMatch(/data-find-doc/)
      if (how.kind === 'cm-search') expect(c).toMatch(/cmSearchExtension\(\)/)
    })
  }

  it('the note panel marks rendered and raw as one document, the Notes page\'s own', () => {
    // The panel mounts no editor itself; it hosts the rendered one and the raw one.
    const panel = code(readFileSync(join(WEB, 'components/notes/MarkdownEditorPanel.tsx'), 'utf8'))
    expect(panel).toMatch(/data-find-doc=\{findPrimary \? 'primary' : ''\}/)
    const notes = code(readFileSync(join(WEB, 'components/notes/NotesEditorPanel.tsx'), 'utf8'))
    expect(notes).toMatch(/\bfindPrimary\b/)
  })
})
