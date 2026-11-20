/**
 * The one way a note path becomes a vault file (src/core/notes/note-paths.ts): traversal,
 * root handling per option, dot segments, symlinks, each caller's own rules, and that every
 * way in follows a moved note (movedNotePath is replaced here by a map). The ratchet at the
 * end walks src/ and fails on a NEW raw join of the vault root outside note-paths.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('note-paths'))

const { moves } = vi.hoisted(() => ({ moves: new Map<string, string>() }))
vi.mock('../../../src/core/notes/note-path-moves.js', () => ({
  movedNotePath: (rel: string) => moves.get(rel) ?? rel,
}))

import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import {
  ensureRealNoteDir, noteAbs, noteKey, normalizeNotePath, noteRelOf, notesRoot, realNoteFile, resolveNotePath,
} from '../../../src/core/notes/note-paths.js'
import { noteKeyOf } from '../../../src/core/companion-notes.js'
import { noteRel } from '../../../src/core/offline-merge/notes.js'
import { createPluginNotes } from '../../../src/core/plugins/notes-service.js'
import { ensureVaultDir, resolveVaultFile } from '../../../src/core/drawings/vault-files.js'
import { invalidateAttachmentIndex, resolveAttachmentPath } from '../../../src/web/routes/notes-attachment.js'

const root = () => NOTES_DIR
const at = (...parts: string[]) => path.join(NOTES_DIR, ...parts)

beforeAll(async () => {
  await fsp.mkdir(at('new'), { recursive: true })
  await fsp.writeFile(at('new', 'a.md'), '# moved\n')
  await fsp.writeFile(at('new', 'pic.png'), 'png')
  // Outside the vault, beside it: what an escape would reach.
  await fsp.writeFile(path.join(WALNUT_HOME, 'secret.png'), 'outside')
  await fsp.mkdir(path.join(WALNUT_HOME, 'outside-dir'), { recursive: true })
  await fsp.writeFile(path.join(WALNUT_HOME, 'outside-dir', 'x.excalidraw'), '{}')
  await fsp.symlink(path.join(WALNUT_HOME, 'outside-dir'), at('linked-dir'))
  await fsp.symlink(path.join(WALNUT_HOME, 'outside-dir', 'x.excalidraw'), at('linked.excalidraw'))
})

afterEach(() => {
  moves.clear()
  invalidateAttachmentIndex()
})

describe('notesRoot', () => {
  it('is the notes folder today', () => {
    expect(notesRoot()).toBe(NOTES_DIR)
  })
})

describe('normalizeNotePath', () => {
  it('unifies slashes and drops leading slashes', () => {
    expect(normalizeNotePath('\\a\\b.md')).toBe('a/b.md')
    expect(normalizeNotePath('///a/b')).toBe('a/b')
  })
  it('is null for nothing left', () => {
    expect(normalizeNotePath('')).toBeNull()
    expect(normalizeNotePath('///')).toBeNull()
  })
  it('keeps "./", trailing slashes and spaces unless the rules drop them', () => {
    expect(normalizeNotePath('./a/')).toBe('./a/')
    expect(normalizeNotePath('./a/', { dropDotSlash: true, dropTrailingSlash: true })).toBe('a')
    expect(normalizeNotePath(' a ')).toBe(' a ')
    expect(normalizeNotePath(' a ', { trim: true })).toBe('a')
  })
  it('appends .md in any case only when asked', () => {
    expect(normalizeNotePath('a', { addMd: true })).toBe('a.md')
    expect(normalizeNotePath('a.MD', { addMd: true })).toBe('a.MD')
  })
  it('refuses dot, dot-dot, empty and hidden segments by rule', () => {
    expect(normalizeNotePath('a/./b')).toBe('a/./b')
    expect(normalizeNotePath('a/./b', { refuseDot: true })).toBeNull()
    expect(normalizeNotePath('a/../b', { refuseDotDot: true })).toBeNull()
    expect(normalizeNotePath('a//b')).toBe('a//b')
    expect(normalizeNotePath('a//b', { refuseEmptySegment: true })).toBeNull()
    expect(normalizeNotePath('.git/x', { refuseHidden: true })).toBeNull()
  })
  it('refuses control characters and overlong paths by rule', () => {
    expect(normalizeNotePath('a\u0001b', { refuseControl: true })).toBeNull()
    expect(normalizeNotePath('x'.repeat(10), { maxLength: 9 })).toBeNull()
  })
  it('never percent-decodes', () => {
    expect(normalizeNotePath('%2e%2e/x', { refuseDotDot: true })).toBe('%2e%2e/x')
  })
})

describe('resolveNotePath (traversal and root)', () => {
  it('refuses an escape however it is spelled', () => {
    for (const p of ['../x', 'a/../../x', '..\\x', '..', 'a/b/../../../x']) {
      expect(resolveNotePath(p), p).toBeNull()
      expect(resolveNotePath(p, { allowRoot: true }), p).toBeNull()
    }
  })
  it('reads an absolute-looking path as vault-relative', () => {
    expect(resolveNotePath('/etc/passwd')).toBe(at('etc', 'passwd'))
  })
  it('keeps a ".." that stays inside unless the rules refuse it', () => {
    expect(resolveNotePath('a/../b')).toBe(at('b'))
    expect(resolveNotePath('a/../b', { refuseDotDot: true })).toBeNull()
  })
  it('treats an encoded "%2e%2e" as a literal name (no caller but attachments decodes)', () => {
    expect(resolveNotePath('%2e%2e/x')).toBe(at('%2e%2e', 'x'))
  })
  it('refuses the root itself unless allowRoot', () => {
    for (const p of ['.', 'a/..', './']) {
      expect(resolveNotePath(p), p).toBeNull()
      expect(resolveNotePath(p, { allowRoot: true }), p).toBe(root())
    }
    expect(resolveNotePath('', { allowRoot: true })).toBeNull()
  })
})

describe('noteAbs / noteRelOf', () => {
  it('round-trip a vault path with forward slashes', () => {
    expect(noteAbs('a/b.md')).toBe(at('a', 'b.md'))
    expect(noteRelOf(at('a', 'b.md'))).toBe('a/b.md')
    expect(noteRelOf(root())).toBe('')
  })
})

describe('realNoteFile / ensureRealNoteDir (symlinks)', () => {
  it('resolves a plain file', async () => {
    expect(await realNoteFile('new/a.md')).toEqual({ ok: true, abs: at('new', 'a.md') })
  })
  it('refuses a symlinked file', async () => {
    expect(await realNoteFile('linked.excalidraw')).toEqual({ ok: false, refused: 'linked' })
  })
  it('refuses a file under a folder that links out of the vault', async () => {
    expect(await realNoteFile('linked-dir/x.excalidraw')).toEqual({ ok: false, refused: 'outside' })
    expect(await realNoteFile('linked-dir/missing/y.excalidraw')).toEqual({ ok: false, refused: 'outside' })
  })
  it('refuses a path that is not strictly inside', async () => {
    expect(await realNoteFile('')).toEqual({ ok: false, refused: 'invalid' })
  })
  it('makes a folder, and refuses one that leads out', async () => {
    expect(await ensureRealNoteDir('made/here')).toEqual({ ok: true, abs: at('made', 'here') })
    expect(fs.statSync(at('made', 'here')).isDirectory()).toBe(true)
    expect(await ensureRealNoteDir('linked-dir/sub')).toEqual({ ok: false, refused: 'outside' })
    expect(fs.existsSync(path.join(WALNUT_HOME, 'outside-dir', 'sub'))).toBe(false)
  })
  it('the drawing store keeps its error messages', async () => {
    await expect(resolveVaultFile('linked.excalidraw')).rejects.toThrow('a linked file is not a drawing Walnut writes')
    await expect(resolveVaultFile('linked-dir/x.excalidraw')).rejects.toThrow('path leads outside Notes')
    await expect(ensureVaultDir('linked-dir/sub')).rejects.toThrow('path leads outside Notes')
  })
})

describe('each caller keeps its own rules', () => {
  it('companion note keys: trimmed, ./ dropped, .md added, no hidden/empty/control, at most 1024', () => {
    expect(noteKeyOf(' ./a/b ')).toBe('a/b.md')
    expect(noteKeyOf(42)).toBeNull()
    for (const p of ['a//b', '.hidden/x', 'a/./b', '../x', 'a\u0001', 'x'.repeat(1022)]) expect(noteKeyOf(p), p).toBeNull()
    expect(noteKeyOf('x'.repeat(1021))).toBe(`${'x'.repeat(1021)}.md`)
  })
  it('journal record paths: ./ dropped, .md added, no ".." or empty segment, "." kept', () => {
    expect(noteRel('./a/b')).toBe('a/b.md')
    expect(noteRel('a/./b')).toBe('a/./b.md')
    expect(noteRel('a//b')).toBeNull()
    expect(noteRel('a/../b')).toBeNull()
  })
  it('the plugin API refuses "." and ".." segments and takes a trailing slash', async () => {
    const notes = createPluginNotes()
    await expect(notes.read('a/./b')).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(notes.read('a/../b')).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(notes.read('')).rejects.toMatchObject({ code: 'invalid_path' })
    expect(await notes.list('new/')).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'new/a.md' })]))
  })
  it('the attachment resolver decodes, and a decoded escape is still refused', async () => {
    expect(await resolveAttachmentPath('%2e%2e/secret.png')).toBeNull()
    expect(await resolveAttachmentPath('../secret.png')).toBeNull()
    expect(await resolveAttachmentPath('new/pic.png')).toBe(at('new', 'pic.png'))
  })
})

describe('every way in follows a moved note (movedNotePath)', () => {
  it('the module resolvers', async () => {
    moves.set('old/a.md', 'new/a.md')
    moves.set('olddir', 'new')
    expect(resolveNotePath('/old/a.md')).toBe(at('new', 'a.md'))
    expect(noteKey('old/a', { addMd: true })).toBe('new/a.md')
    expect(noteAbs('old/a.md')).toBe(at('new', 'a.md'))
    expect(await realNoteFile('old/a.md')).toEqual({ ok: true, abs: at('new', 'a.md') })
    expect(await ensureRealNoteDir('olddir')).toEqual({ ok: true, abs: at('new') })
  })
  it('the callers', async () => {
    moves.set('old/a.md', 'new/a.md')
    moves.set('old/pic.png', 'new/pic.png')
    moves.set('old/x.excalidraw', 'new/x.excalidraw')
    expect(noteKeyOf('old/a')).toBe('new/a.md')
    expect(noteRel('./old/a')).toBe('new/a.md')
    // The plugin API resolves before it adds ".md", so a move keyed on `old/a.md` is met when
    // the plugin names the file with its ".md".
    expect((await createPluginNotes().read('old/a.md'))?.path).toBe('new/a.md')
    expect(await resolveVaultFile('old/x.excalidraw')).toBe(at('new', 'x.excalidraw'))
    expect(await resolveAttachmentPath('old/pic.png')).toBe(at('new', 'pic.png'))
  })
  it('a move that would leave the vault is still refused', async () => {
    moves.set('old/a.md', '../../escape.md')
    expect(resolveNotePath('old/a.md')).toBeNull()
    expect(noteKey('old/a.md', { refuseDotDot: true })).toBeNull()
    expect(await realNoteFile('old/a.md')).toEqual({ ok: false, refused: 'invalid' })
  })
})

// ── ratchet: no raw join of the vault root outside note-paths.ts ──

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src')

/** Files that may join the root themselves: the resolver module, and constants.ts (it defines the root and its reserved files). */
const ALLOWED = new Set(['core/notes/note-paths.ts', 'constants.ts'])

/**
 * A rel path joined to the vault root by hand: `path.join|resolve|relative(NOTES_DIR`,
 * the same through `constants.NOTES_DIR`, `NOTES_DIR + path.sep`, a template
 * `${NOTES_DIR}/`, or `path.join|resolve(notesRoot(), ...)`.
 */
const RAW_JOIN = /path\.(?:posix\.|win32\.)?(?:join|resolve|relative)\(\s*(?:\w+\.)?NOTES_DIR\b|\bNOTES_DIR\s*\+\s*path\.sep|\$\{(?:\w+\.)?NOTES_DIR\}\/|path\.(?:posix\.)?(?:join|resolve)\(\s*(?:\w+\.)?notesRoot\(\)\s*,/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('ratchet: every vault join goes through note-paths.ts', () => {
  it('finds the pattern it guards (self-check)', () => {
    expect(RAW_JOIN.test('const abs = path.join(NOTES_DIR, rel)')).toBe(true)
    expect(RAW_JOIN.test('const root = path.resolve(constants.NOTES_DIR)')).toBe(true)
    expect(RAW_JOIN.test("path.relative(NOTES_DIR, full).replace(/\\\\/g, '/')")).toBe(true)
    expect(RAW_JOIN.test('resolved.startsWith(NOTES_DIR + path.sep)')).toBe(true)
    expect(RAW_JOIN.test('path.join(notesRoot(), rel)')).toBe(true)
    expect(RAW_JOIN.test('path.resolve(notesRoot())')).toBe(false)
  })

  it('no file outside note-paths.ts joins the vault root by hand', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      if (ALLOWED.has(rel)) continue
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (RAW_JOIN.test(line)) offenders.push(`src/${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    // Use noteAbs / noteRelOf / resolveNotePath from src/core/notes/note-paths.ts instead,
    // so a moved note (movedNotePath) is followed by every way in.
    expect(offenders).toEqual([])
  })
})
