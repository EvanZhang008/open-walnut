/**
 * Undo for an organize run: a journal of every change the run makes, written as it goes, and the
 * way back, which reverses exactly those changes, newest first.
 *
 * The journal is the backup: it holds the text each note had before the run rewrote it and the
 * whole text of each note a merge folded away. Nothing else in the vault is touched by an undo, so
 * what the person changed or wrote after the run stays theirs:
 * - a move goes back only when the old place is still free (a note made there since stays, and the
 *   moved one stays where it is, with every link pointing at it where it is);
 * - a note the run rewrote gets its old text back only while it is exactly as the run left it; one
 *   edited since keeps the edit and only has its links pointed back;
 * - an index note the run made is removed only while it is as the run wrote it;
 * - a note a merge removed comes back, beside a note made at its place since if there is one.
 * A move is journaled before it is made, so a run cut off part way (a failure, a restart) can still
 * be undone; an undo cut off part way can simply be run again.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { NotesService } from '@open-walnut/plugin-api/server'
import type { Mapping } from './mapping'
import { rewriteLinks } from './links'
import { dirOf, stemOf } from './paths'

/**
 * Each change is journaled before it is made; a write is followed by a `written` line with the
 * hash the note got (the notes service stamps an id, so the text written is not the text sent).
 */
export type JournalEntry =
  /** Vault paths; `newDirs`: folders the move makes. */
  | { kind: 'move'; from: string; to: string; newDirs?: string[]; done?: boolean }
  /** The move named just before it was made, made (its `done`). */
  | { kind: 'moved'; from: string; to: string }
  /** A note the run makes (an index). `hash` comes from its `written` line. */
  | { kind: 'create'; path: string; hash?: string }
  /**
   * A note the run rewrites (links fixed, notes merged into it), with its text before. `record`:
   * the import record whose stamp follows the note while it is as the import wrote it.
   */
  | { kind: 'rewrite'; path: string; before: string; beforeHash: string; afterHash?: string; record?: { source: string; itemId: string; folder?: string } }
  /** A note a merge removes: its whole text, and the source item it was imported from. */
  | { kind: 'remove'; path: string; content: string; merged?: { source: string; itemId: string; folder?: string } }
  /** The write named just before it was made: the note's hash now. */
  | { kind: 'written'; path: string; hash: string }

export interface UndoInfo {
  id: string
  folder: string
  at: string
  /** The run got to its end (kept beside the journal's handle; one that stopped part way has not). */
  finished?: boolean
}

const KEEP = 5

function dirFor(dataDir: string): string {
  return path.join(dataDir, 'organize')
}

export class Journal {
  private constructor(private readonly file: string, readonly info: UndoInfo) {}

  /** A new journal for a run on `folder`; older ones beyond the last few go, `keep` stays. */
  static async start(dataDir: string, folder: string, keep: string[] = []): Promise<Journal> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
    const dir = dirFor(dataDir)
    await fsp.mkdir(dir, { recursive: true })
    const info: UndoInfo = { id, folder, at: new Date().toISOString() }
    const file = path.join(dir, `${id}.jsonl`)
    await fsp.writeFile(file, `${JSON.stringify(info)}\n`)
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort().reverse()
    for (const name of names.slice(KEEP)) {
      if (!keep.includes(name.replace(/\.jsonl$/, '')) && name !== `${id}.jsonl`) await fsp.rm(path.join(dir, name), { force: true })
    }
    return new Journal(file, info)
  }

  async add(entry: JournalEntry): Promise<void> {
    await fsp.appendFile(this.file, `${JSON.stringify(entry)}\n`)
  }

  static async read(dataDir: string, id: string): Promise<{ info: UndoInfo; entries: JournalEntry[] }> {
    if (!/^[\w-]+$/.test(id)) throw new Error('Not an organize run')
    const text = await fsp.readFile(path.join(dirFor(dataDir), `${id}.jsonl`), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    const info = JSON.parse(lines[0]) as UndoInfo
    const entries: JournalEntry[] = []
    for (const line of lines.slice(1)) {
      // A line cut off by a crash mid-write is the last one; what it named was not done yet.
      let entry: JournalEntry
      try { entry = JSON.parse(line) as JournalEntry } catch { break }
      if (entry.kind === 'moved') {
        for (let i = entries.length - 1; i >= 0; i--) {
          const made = entries[i]
          if (made.kind === 'move' && made.from === entry.from && made.to === entry.to) { made.done = true; break }
        }
        continue
      }
      if (entry.kind !== 'written') { entries.push(entry); continue }
      for (let i = entries.length - 1; i >= 0; i--) {
        const made = entries[i]
        if ((made.kind !== 'rewrite' && made.kind !== 'create') || made.path !== entry.path) continue
        if (made.kind === 'rewrite') made.afterHash = entry.hash
        else made.hash = entry.hash
        break
      }
    }
    return { info, entries }
  }
}

async function present(notes: NotesService, at: string): Promise<boolean> {
  return at.endsWith('.md') ? !!(await notes.read(at)) : !!(await notes.readFile(at))
}

/** `Name (restored).md`, `Name (restored 2).md`, … beside `at`, free. */
async function besideName(notes: NotesService, at: string): Promise<string> {
  const dir = dirOf(at)
  for (let n = 1; ; n++) {
    const candidate = `${dir ? `${dir}/` : ''}${stemOf(at)} (restored${n > 1 ? ` ${n}` : ''}).md`
    if (!(await notes.read(candidate))) return candidate
  }
}

export interface UndoOutcome {
  /** Notes the person changed or made after the run, which the undo left as they are. */
  kept: string[]
}

export async function undoRun(input: {
  notes: NotesService
  mapping: Mapping
  dataDir: string
  id: string
  onStep?(done: number, total: number): void
  signal?: AbortSignal
}): Promise<UndoOutcome> {
  const { notes, mapping } = input
  const { info, entries } = await Journal.read(input.dataDir, input.id)
  const folderOf = (f?: string) => f ?? info.folder
  const reversed = [...entries].reverse()

  // First pass: which moves can go back. A move goes back only when its note is at the new place
  // and the old place is free, as the steps undone before it leave the vault.
  const presence = new Map<string, boolean>()
  const isThere = async (at: string) => presence.get(at) ?? present(notes, at)
  const undoable = new Set<JournalEntry>()
  // Moves this undo makes, and ones an undo that was cut short made already: both end at `from`.
  const goesBack = new Set<JournalEntry>()
  for (const entry of reversed) {
    if (entry.kind === 'move') {
      const atNew = await isThere(entry.to)
      const atOld = await isThere(entry.from)
      if (atNew && !atOld) {
        undoable.add(entry)
        goesBack.add(entry)
        presence.set(entry.to, false)
        presence.set(entry.from, true)
      } else if (!atNew && atOld && entry.done) {
        goesBack.add(entry)
      }
    } else if (entry.kind === 'create') {
      const current = presence.get(entry.path) === false ? null : await notes.read(entry.path)
      if (current && entry.hash && current.hash === entry.hash) presence.set(entry.path, false)
    } else if (entry.kind === 'remove') {
      presence.set(entry.path, true)
    }
  }
  // Where each moved note is at the end of the run (from its place before the run), and where it
  // will be once this undo is done (from its place at the end of the run).
  // A move written down but never made (it failed, or the run stopped right there) counts only
  // when the vault shows it made.
  const made = new Set<JournalEntry>()
  for (const entry of entries) {
    if (entry.kind === 'move' && (entry.done || goesBack.has(entry) || ((await present(notes, entry.to)) && !(await present(notes, entry.from))))) made.add(entry)
  }
  const endOf = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== 'move' || !made.has(entry)) continue
    const orig = [...endOf].find(([, at]) => at === entry.from)?.[0] ?? entry.from
    endOf.set(orig, entry.to)
  }
  const afterUndo = new Map<string, string>()
  for (const entry of reversed) {
    if (entry.kind !== 'move' || !goesBack.has(entry)) continue
    const key = [...afterUndo].find(([, at]) => at === entry.to)?.[0] ?? entry.to
    afterUndo.set(key, entry.from)
  }
  const placeAfter = (end: string) => afterUndo.get(end) ?? end
  // Links that point at a note's place at the end of the run, to where it will be after the undo.
  const back = new Map<string, string>()
  for (const [end, at] of afterUndo) if (at !== end) back.set(end, at)
  // Links as they were before the run, to where a note that cannot go back stays.
  const stay = new Map<string, string>()
  for (const [orig, end] of endOf) if (placeAfter(end) !== orig) stay.set(orig, placeAfter(end))

  const kept = new Set<string>()
  const madeDirs = new Set<string>()
  const total = entries.length
  let done = 0
  for (const entry of reversed) {
    if (input.signal?.aborted) throw new Error('Undo was stopped; run it again to finish.')
    if (entry.kind === 'rewrite') {
      const current = await notes.read(entry.path)
      // Gone since (the person deleted it), or never written, or already put back: nothing to do.
      if (current && current.hash !== entry.beforeHash) {
        if (entry.afterHash && current.hash === entry.afterHash) {
          const written = await notes.write(entry.path, rewriteLinks(entry.before, stay), { expectedHash: current.hash })
          if (entry.record) {
            const { source, itemId } = entry.record
            const recordFolder = folderOf(entry.record.folder)
            const row = (await mapping.all(recordFolder, source)).get(itemId)
            if (row && row.hash === current.hash) await mapping.put(recordFolder, source, itemId, { ...row, hash: written.hash })
          }
        } else {
          const relinked = rewriteLinks(current.content, back)
          if (relinked !== current.content) await notes.write(entry.path, relinked, { expectedHash: current.hash })
          kept.add(entry.path)
        }
      }
    } else if (entry.kind === 'create') {
      const current = await notes.read(entry.path)
      // No hash: the run never made it (a note already there was left alone).
      if (current && entry.hash) {
        if (current.hash === entry.hash) await notes.remove(entry.path)
        else kept.add(entry.path)
      }
    } else if (entry.kind === 'remove') {
      const current = await notes.read(entry.path)
      let target = entry.path
      if (!current || current.content !== entry.content) {
        if (current) target = await besideName(notes, entry.path)
        await notes.write(target, rewriteLinks(entry.content, stay), { createOnly: true })
        if (current) kept.add(entry.path)
      }
      if (entry.merged) {
        const { source, itemId } = entry.merged
        const recordFolder = folderOf(entry.merged.folder)
        await mapping.unmarkMerged(recordFolder, source, itemId)
        // The merge pointed its record at the note it went into; it records its own note again.
        const row = (await mapping.all(recordFolder, source)).get(itemId)
        if (row && row.path !== target) await mapping.put(recordFolder, source, itemId, { ...row, path: target })
      }
    } else if (entry.kind === 'move') {
      if (undoable.has(entry) && (await present(notes, entry.to)) && !(await present(notes, entry.from))) {
        await notes.move(entry.to, entry.from)
        await mapping.movePathAnywhere(entry.to, entry.from)
        for (const d of entry.newDirs ?? []) madeDirs.add(d)
      } else if (await present(notes, entry.to)) {
        kept.add(entry.from)
      }
    }
    input.onStep?.(++done, total)
  }
  // Folders the run's moves made, once nothing is left in them (hidden files keep a folder).
  const { isEmptyFolder } = await import('./organize')
  for (const dir of [...madeDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (await isEmptyFolder(notes, dir)) await notes.remove(dir)
  }
  return { kept: [...kept] }
}
