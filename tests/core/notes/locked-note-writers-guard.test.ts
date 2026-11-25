/**
 * Class guard: every place that writes a note leaves a locked note as it is, and a hidden note to the
 * person (docs/reference/locked-notes.md). A locked note's file holds only its id, the mark, a stub
 * and the ciphertext; a writer that does not check would put text in the clear beside it, or replace
 * the ciphertext and lose the note. A hidden note is plain text only the person writes; a writer that
 * checks only the lock mark would let any agent change it. So a check here is one that covers both.
 *
 * The writers are found from the source, three ways:
 *  1. every module that announces a note change (`NOTES_UPDATED`, the shared note-write contract);
 *  2. every FUNCTION that changes a file (write, append, rename, remove, copy) at a path it built in
 *     the notes vault, or at a path a client names in the Files panel's modules: it checks the lock
 *     itself or through a function of its own file, and takes the person's file lock, never
 *     withFileLock (the lock Lock takes is withUserFileLock, so any other lets Lock seal the note
 *     between a writer's read and its write);
 *  3. every module that applies a note save or read for another machine (the replica, the offline
 *     copy of a host, the companion, the offline merge, the plugin service), named here.
 * And every route that answers or saves a locked note says its answer is never kept
 * (lib/answer-not-kept.ts), so no op call that reached it, by whatever op, keeps the text (op-calls.ts).
 * Each one checks the lock (one of the helpers in src/core/notes/locked-note.ts, or the notes
 * route's guarded write), or is listed with why it can never touch a locked note. A new writer
 * fails here until it checks.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCallers, findNoteWriters, type NoteWriter } from '../../helpers/note-writer-scan.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
// Lock-only tests (looksLockedNoteText, isLockedNoteText, hasLockMark) do not count: they miss a hidden note.
const CHECKS = /\b(assertNotLocked|assertNotLockedText|assertFileNotLocked|looksProtectedNoteText|noteProtection|noteForReader|fileLooksLocked|fileProtection|readableNoteText|writeNoteContent)\(/

function grepFiles(re: string): string[] {
  try {
    return execFileSync('git', ['grep', '--untracked', '-lE', re, '--', 'src/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/** Announcers that write no note a person can lock, and why. */
const NO_LOCKED_WRITE: Record<string, string> = {
  'src/core/event-bus.ts': 'defines the event',
  'src/core/host-replica-sync.ts': 'relays the event to a host, writes no note',
  'src/web/routes/drawings.ts': 'writes the drawing; its Notes entry is companion-sync.ts\'s',
  'src/core/drawings/companion-sync.ts': 'a locked companion has no companion block (isOwnCompanion), so mergeCompanion answers foreign and nothing is written',
  'src/web/routes/notes.ts': 'writes global-notes.md only, which cannot be locked (locked-note-store.ts lockNote)',
  'src/core/notes/protected-note-file.ts': 'the announcement of the protected notes\' own writers (locked-note-store.ts, hidden-note-store.ts)',
}

/** The writers for another machine or a plugin, which announce nothing themselves. */
const OTHER_WRITERS = [
  'src/core/companion-notes.ts',
  'src/providers/offline-host-core.ts',
  'src/providers/host-replica-core.ts',
  'src/replica/notes-routes.ts',
  'src/core/offline-merge/notes.ts',
  'src/core/plugins/notes-service.ts',
  'src/web/routes/file-content.ts',
]

/** Modules whose routes change a path the client names, which may be a note in the vault (the Files panel). */
const CLIENT_PATH_MODULES = ['src/web/routes/file-content.ts', 'src/web/routes/file-ops.ts']

/** `<file>#<function>` of each vault writer with no lock check of its own, and why it needs none. */
const VAULT_WRITERS_OK: Record<string, string> = {
  'src/core/attachment-replica.ts#attachmentEntries': 'only reads the vault; what it writes is its hash cache, cache/attachment-hashes.json in the Walnut home',
  'src/core/attachment-replica.ts#syncAttachments': 'only reads the vault (attachmentEntries) and sends copies to a replica; its one write is the hash cache in the Walnut home',
  'src/core/init.ts#initDirectories': 'only makes the vault folder; the file it moves (migrateLegacyMemoryFile) is MEMORY.md in the Walnut home',
  'src/core/search/wiring.ts#sweepSearchV2Files': 'only reads the vault; what it changes is the search index (getSearchV2Index)',
  'src/core/notes-migration.ts#migrateGlobalNotes': 'a boot step from before global-notes.md existed, run only while global-notes.md is missing',
  'src/core/offline-merge/apply-note-attachment.ts#applyNoteAttachment': 'places a picture or file saved away, refusing a .md path, and never over a file',
  'src/web/routes/notes-v2.ts#deleteNoteAttachment': 'deletes an attachment (a .md path is refused) and a drawing\'s companion note only when it is Walnut\'s own, which a locked note never is (companion-sync.ts isOwnCompanion)',
  // The locked note's own writer: it writes only a sealed file, of a note it opened (its envelope) or locked.
  'src/core/notes/locked-note-store.ts#writeLockedNote': 'saves a locked note sealed again, only after its envelope opened (envelopeOf, hasLockMark)',
  'src/core/notes/locked-note-store.ts#lockNote': 'Lock itself: seals a plain or hidden note, refusing one already locked (hasLockMark)',
  'src/core/notes/locked-note-store.ts#removeNoteLock': 'Remove lock itself: writes back the text its envelope opened',
}

/**
 * Helpers that change a vault file at a path they are handed, and check nothing themselves: every
 * function anywhere in src/ that calls one checks the lock first, or is in VAULT_WRITERS_OK.
 */
const CHECKED_BY_CALLERS: Record<string, string> = {
  'src/web/routes/notes-v2.ts#deleteNoteFile': 'deleteNoteFile',
  'src/web/routes/file-ops.ts#execLocal': 'execLocal',
}

/** Callers of those helpers whose check runs before them elsewhere, and where. */
const CALLERS_OK: Record<string, string> = {
  'src/core/offline-merge/notes.ts#macNoteDeps/remove': 'called only by applyDelete, which applyNote reaches after its noteProtection(mac) check, under the note lock',
}

/** Every vault writer in src/, as `<file>#<function>`. */
function vaultWriters(): Map<string, NoteWriter> {
  const files = grepFiles(String.raw`notesRoot\(|resolveNotePath\(|noteAbs\(|noteAbsIn\(|realNoteFile\(|ensureRealNoteDir\(|realNotesRoot\(|noteFileOf\(|NOTES_DIR\b`)
  const out = new Map<string, NoteWriter>()
  for (const f of [...new Set([...files, ...CLIENT_PATH_MODULES])].sort()) {
    for (const w of findNoteWriters(f, read(f), { clientPaths: CLIENT_PATH_MODULES.includes(f) })) out.set(`${f}#${w.name}`, w)
  }
  return out
}

describe('every note writer leaves a locked note as it is', () => {
  it('every function that changes a file in the notes vault checks the lock and takes the person\'s file lock', () => {
    const writers = vaultWriters()
    // The scan sees the writers at all (a broken walker would pass everything).
    for (const known of ['src/web/routes/notes-v2.ts#writeNoteContent', 'src/web/routes/notes-v2.ts#moveNote', 'src/web/routes/file-ops.ts#execLocal', 'src/core/triage/runs.ts#appendToRunsNote', 'src/core/notes/hidden-note-store.ts#hideNote']) {
      expect(writers.has(known), known).toBe(true)
    }
    const problems: string[] = []
    for (const [key, w] of writers) {
      if (w.storeLock) problems.push(`${key} writes a vault file under withFileLock: take withUserFileLock, the lock Lock takes (src/utils/user-file-lock.ts)`)
      if (!w.checks && !VAULT_WRITERS_OK[key] && !CHECKED_BY_CALLERS[key]) {
        problems.push(`${key} changes a vault file (${w.mutations.join(', ')}) but never checks the lock: refuse or skip a locked note (src/core/notes/locked-note.ts, locked-note-moves.ts), or list it in VAULT_WRITERS_OK with why`)
      }
    }
    expect(problems).toEqual([])
    // A stale entry is dropped here too.
    expect([...Object.keys(VAULT_WRITERS_OK), ...Object.keys(CHECKED_BY_CALLERS)].filter((k) => !writers.has(k))).toEqual([])
  })

  it('every caller of a helper that writes a vault file at a path it is handed checks the lock first', () => {
    const problems: string[] = []
    const seen = new Set<string>()
    for (const helper of Object.values(CHECKED_BY_CALLERS)) {
      const callers = grepFiles(String.raw`\b${helper}\(`).flatMap((f) => findCallers(f, read(f), helper).map((c) => ({ key: `${f}#${c.name}`, ...c })))
      expect(callers.length, helper).toBeGreaterThan(0)
      for (const c of callers) {
        seen.add(c.key)
        if (!c.checks && !VAULT_WRITERS_OK[c.key] && !CALLERS_OK[c.key]) problems.push(`${c.key} calls ${helper} without checking the lock first: check it, or list it in CALLERS_OK with where the check runs`)
      }
    }
    expect(problems).toEqual([])
    expect(Object.keys(CALLERS_OK).filter((k) => !seen.has(k))).toEqual([])
  })

  it('the scan is per function: a check in another function of the file does not count, a callback does', () => {
    const scan = (src: string) => findNoteWriters('src/core/x.ts', src).map((w) => `${w.name}:${w.checks ? 'checked' : 'unchecked'}${w.storeLock ? ':store-lock' : ''}`)
    expect(scan(`
      function guarded(rel) { const f = noteAbs(rel); assertFileNotLocked(f); return fsp.writeFile(f, 'x') }
      function plain(rel) { return fsp.writeFile(noteAbs(rel), 'x') }
    `)).toEqual(['guarded:checked', 'plain:unchecked'])
    expect(scan(`
      async function locked(rel) { const f = noteAbs(rel); return withUserFileLock(f, async () => { assertNotLocked(await fsp.readFile(f, 'utf8')); await fsp.rename(f, f + '.x') }) }
      async function viaHelper(rel) { const f = noteAbs(rel); await check(f); await drop(f) }
      async function check(f) { await assertFileNotLocked(f) }
      async function drop(f) { await fsp.rm(f) }
    `)).toEqual(['locked:checked', 'viaHelper:checked'])
    expect(scan(`async function store(rel) { const f = noteAbs(rel); await withFileLock(f, () => fsp.appendFile(f, 'x')) }`))
      .toEqual(['store:unchecked:store-lock'])
    // A check of the lock mark alone lets anyone write a hidden note: it is no check.
    expect(scan(`
      async function lockOnly(rel) { const f = noteAbs(rel); if (looksLockedNoteText(await fsp.readFile(f, 'utf8'))) return; await fsp.writeFile(f, 'x') }
      async function both(rel) { const f = noteAbs(rel); if (looksProtectedNoteText(await fsp.readFile(f, 'utf8'))) return; await fsp.writeFile(f, 'x') }
    `)).toEqual(['lockOnly:unchecked', 'both:checked'])
    // A route handler is its own function, and a closure sees the path its outer function built.
    expect(scan(`
      router.delete('/x/*path', async (req, res) => { await fsp.unlink(resolveNotePath(req.params.path)) })
      function outer() { const root = NOTES_DIR; const inner = () => fsp.cp(root, root + '2'); return inner }
    `)).toEqual(['delete /x/*path:unchecked', 'outer/inner:unchecked'])
  })

  it('every locked-note route answers marked never kept, whichever op reached it (`api` too)', async () => {
    const { vaultNotesV1Router } = await import('../../../src/web/routes/vault-notes-v1.js')
    const { ANSWER_NOT_KEPT_HEADER } = await import('../../../src/lib/answer-not-kept.js')
    type Layer = { route?: { path: string }; match(path: string): boolean; handle: (req: unknown, res: unknown, next: () => void) => void }
    const stack = (vaultNotesV1Router as unknown as { stack: Layer[] }).stack
    const routes = stack.map((layer, at) => ({ layer, at })).filter(({ layer }) => layer.route)
    expect(routes.map(({ layer }) => layer.route!.path)).toContain('/vault/notes/agent/ask/:id/wait')
    // Each route's answer goes through the layers before it that match its path: one of them marks it.
    const unmarked = routes.filter(({ layer, at }) => {
      const url = layer.route!.path.replace(/:[A-Za-z_]+/g, 'x')
      const headers: Record<string, string> = {}
      const res = { setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value } }
      for (const before of stack.slice(0, at)) {
        if (!before.route && before.match(url)) before.handle({ url, method: 'POST', headers: {} }, res, () => undefined)
      }
      return !headers[ANSWER_NOT_KEPT_HEADER]
    }).map(({ layer }) => layer.route!.path)
    expect(unmarked).toEqual([])
    // No other module answers a locked-note route.
    expect(grepFiles('\\.(get|post|put|patch|delete|all|use)\\([\'"`]/vault/notes')).toEqual(['src/web/routes/vault-notes-v1.ts'])
  })

  it('a released note comes in pages small enough that no agent client writes one to a file', async () => {
    // Paging itself (every page under the cap, `next` reads the whole back) is tests/mcp/answer-policy.test.ts.
    const { getOp } = await import('../../../src/ops/index.js')
    const { answerFit } = await import('../../../src/ops/answer.js')
    for (const surface of ['mcp', 'cli'] as const) expect(answerFit(getOp('locked_note_wait')!, surface).max, surface).toBeLessThanOrEqual(8_000)
  })

  it('every module that announces a note change checks the lock, or says why it never writes one', () => {
    const announcers = grepFiles('EventNames\\.NOTES_UPDATED|NOTES_UPDATED\\b')
    const problems = announcers.filter((f) => !NO_LOCKED_WRITE[f] && !CHECKS.test(read(f)))
      .map((f) => `${f} announces a note write but never checks the lock: refuse or skip a locked note (src/core/notes/locked-note.ts), or list it in NO_LOCKED_WRITE with why`)
    expect(problems).toEqual([])
    // A stale entry is dropped here too.
    expect(Object.keys(NO_LOCKED_WRITE).filter((f) => !announcers.includes(f))).toEqual([])
  })

  it('every writer for another machine or a plugin checks the lock', () => {
    expect(OTHER_WRITERS.filter((f) => !CHECKS.test(read(f)))).toEqual([])
  })
})
