/**
 * One import run: everything a source can see, into one notes folder, as notes.
 *
 * 1. Discover the items and plan a path for each (paths.ts).
 * 2. Find what an earlier run imported into this folder, wherever those notes are now (their
 *    frontmatter names the source item), and what it wrote then (mapping.ts).
 * 3. Render and write each item, three at a time: an item whose source did not change since the
 *    last write is skipped without a single API call; a note the person edited since is kept as it
 *    is and counted; everything else is written, links pointing at the notes of the other items.
 *
 * Sub-pages the source finds while rendering join the run as they turn up.
 */
import type { NotesService } from '@open-walnut/plugin-api/server'
import { containerOf, safeName, dirOf, PathPlanner, stemOf } from './paths'
import { bodyIsAsWritten, bodyOf, composeNote, frontmatterValue, importedIdOf, withBody } from './note-file'
import type { Mapping, MappingRow } from './mapping'
import type { NoteSource, SourceItem } from './types'
import { linkOutside, OUTSIDE_MARK, rewriteLinks } from './links'
import { ATTACHMENT_EXTS } from './attachments'

const WORKERS = 3
const MAX_LISTED = 100
const TYPE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
  'application/pdf': 'pdf',
}
const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface ImportCounts {
  found: number
  done: number
  created: number
  updated: number
  unchanged: number
  kept: number
  failed: number
  files: number
  filesKeptInSource: number
  /** Notes the person deleted in Walnut whose page did not change since: not brought back. */
  deleted: number
  /** Notes whose page did not change but whose links this run fixed (a note renamed, moved or newly imported). */
  relinked?: number
}

export interface ImportProgress {
  phase: 'discovering' | 'importing'
  counts: ImportCounts
  current?: string
  /** The files kept in the source so far, so a run stopped part way still names them. */
  filesInSource?: Array<{ name: string; note: string }>
}

export interface ImportOutcome {
  counts: ImportCounts
  errors: Array<{ title: string; message: string }>
  warnings: string[]
  /** Notes the person edited since the last import; Notion's newer version was not written over them. */
  keptPaths: string[]
  /** Where notes the person deleted were; they come back only once their page changes. */
  deletedPaths: string[]
  /** Notes a re-import made (pages new since the last run); none listed on a first import. */
  newPaths: string[]
  /** Notes brought up to date with their page's newer version. */
  updatedPaths?: string[]
  /** New notes named apart from a note of the person's with the page's name: the new note and that one. */
  namedApart?: { path: string; beside: string }[]
  /** Notes that took the source's version on request: the note and where the person's version went. */
  replaced?: { path: string; copy: string }[]
  /** Notes written again on request after the person deleted them. */
  restored?: string[]
  /** The source page of each kept note, to see its newer version there. */
  keptUrls?: Record<string, string>
  /** Files that stayed in the source (a type notes cannot keep, or one that would not download), with the note linking to each. */
  filesInSource: Array<{ name: string; note: string }>
  /** Everything the source listed at the start of the run (the whole workspace, whatever was chosen). */
  listed?: SourceItem[]
  /** Notes whose page is gone from the source (deleted there, or no longer shared): kept, never deleted here. */
  gonePaths: string[]
  /** Gone notes the person edited since the import wrote them. */
  goneEdited: string[]
  /** The source item of each path listed above, so a note moved since can be found where it is now. */
  pathIds: Record<string, string>
  /** The first note written or found, to open when the run ends. */
  firstPath: string | null
  roots: Array<{ title: string; path: string }>
}

export interface DownloadFile {
  (url: string, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; type: string } | null>
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export async function runImport(input: {
  source: NoteSource
  notes: NotesService
  mapping: Mapping
  folder: string
  /** Limit the run to these items and everything below them; absent = everything. */
  rootIds?: string[]
  /** Items whose note takes the source's version even though the person edited it; their version is kept beside it. */
  replace?: string[]
  /** Items whose note the person deleted in Walnut, to write again. */
  restore?: string[]
  download: DownloadFile
  signal: AbortSignal
  onProgress(progress: ImportProgress): void
}): Promise<ImportOutcome> {
  const { source, notes, mapping, folder, signal } = input
  const counts: ImportCounts = { found: 0, done: 0, created: 0, updated: 0, unchanged: 0, kept: 0, failed: 0, files: 0, filesKeptInSource: 0, deleted: 0 }
  const errors: ImportOutcome['errors'] = []
  const warnings: string[] = []
  const keptPaths: string[] = []
  const deletedPaths: string[] = []
  const newPaths: string[] = []
  const updatedPaths: string[] = []
  const namedApart: { path: string; beside: string }[] = []
  const replaced: { path: string; copy: string }[] = []
  const replace = new Set(input.replace ?? [])
  const restore = new Set(input.restore ?? [])
  const restored: string[] = []
  // One line per kind of warning, naming the pages it came from (a big workspace repeats one a lot).
  const pageWarnings = new Map<string, { titles: Set<string>; count: number }>()
  const keptUrls: Record<string, string> = {}
  const filesInSource: Array<{ name: string; note: string }> = []
  const gonePaths: string[] = []
  const pathIds: Record<string, string> = {}
  const goneEdited: string[] = []
  const keptInSource = (name: string, note: string) => {
    counts.filesKeptInSource++
    if (filesInSource.length < MAX_LISTED) filesInSource.push({ name, note })
  }
  const progress = (phase: ImportProgress['phase'], current?: string) => input.onProgress({ phase, counts: { ...counts }, ...(current ? { current } : {}), ...(filesInSource.length ? { filesInSource: [...filesInSource] } : {}) })

  progress('discovering')
  let items = await source.discover(signal, (n) => { counts.found = n; progress('discovering') })
  const listed = items
  // Every page the connection showed, chosen or not: a link to one outside this import keeps its title.
  const titles = new Map(items.map((item) => [item.id, item.title]))
  if (input.rootIds?.length) {
    const wanted = new Set(input.rootIds)
    const byId = new Map(items.map((item) => [item.id, item]))
    const under = (item: SourceItem): boolean => {
      for (let current: SourceItem | undefined = item, hops = 0; current && hops < 64; current = current.parentId ? byId.get(current.parentId) : undefined, hops++) {
        if (wanted.has(current.id)) return true
      }
      return false
    }
    items = items.filter(under)
    // A chosen item is a root of this import even when its parent is shared too.
    for (const item of items) if (wanted.has(item.id)) item.parentId = null
  }

  // What is in the folder now: every path (so nothing lands on a note of the person's), and
  // where each note an earlier run made sits today.
  await notes.mkdir(folder)
  const entries = await notes.list(folder)
  const occupied = entries.map((entry) => entry.path)
  const existingFile = new Set(entries.filter((entry) => entry.type !== 'folder').map((entry) => entry.path))
  const located = new Map<string, string>()
  const remembered = await mapping.all(folder, source.id)
  let merged = await mapping.merged(folder, source.id)
  // A note another import folder records (one nested inside this folder, say) is that folder's
  // copy of the page; the note this folder's record names wins over any other copy.
  const othersCopies = await mapping.pathsOfOtherFolders(folder, source.id)
  for (const entry of entries) {
    if (entry.type !== 'note' || othersCopies.has(entry.path)) continue
    const note = await notes.read(entry.path)
    const id = note ? importedIdOf(note.content, source.id) : null
    if (id && (!located.has(id) || remembered.get(id)?.path === entry.path)) located.set(id, entry.path)
  }
  for (const [id, row] of remembered) if (!located.has(id) && existingFile.has(row.path)) located.set(id, row.path)
  // Notes the person moved out of the folder since: found by their frontmatter anywhere in the
  // vault, so the next import updates them where they are instead of making them again.
  // A note another import folder records is that folder's copy of the same page, never this one's.
  const away = new Set([...remembered.keys()].filter((id) => !located.has(id) && !merged.has(id)))
  if (away.size) {
    for (const entry of await notes.list()) {
      if (!away.size) break
      if (entry.type !== 'note' || entry.path.startsWith(`${folder}/`) || othersCopies.has(entry.path)) continue
      const note = await notes.read(entry.path)
      const id = note ? importedIdOf(note.content, source.id) : null
      if (!id || !away.has(id)) continue
      away.delete(id)
      located.set(id, entry.path)
      existingFile.add(entry.path)
    }
  }

  // A folder emptied of every note this importer made is a fresh start: everything comes in
  // again, pages an organize run merged away included.
  const freshStart = located.size === 0
  if (freshStart && merged.size) {
    await mapping.clearMerged(folder, source.id)
    merged = new Set()
  }
  items = items.filter((item) => !merged.has(item.id))
  // Notes the person moved out of the folder keep their sub-pages beside them: what is around
  // them is taken too, so a sub-page never lands on a note there.
  for (const dir of new Set([...located.values()].filter((at) => !at.startsWith(`${folder}/`)).map(containerOf))) {
    for (const entry of await notes.list(dir).catch(() => [])) occupied.push(entry.path)
  }
  // A page imported before that discovery did not list this time (search lags, or it is only
  // reachable through a parent's blocks): ask for it by id, so a change to it is not missed.
  if (source.lookup) {
    const listed = new Set(items.map((item) => item.id))
    // With chosen roots, only notes that sit under a chosen root's note are asked for.
    const rootDirs = (input.rootIds ?? []).map((id) => located.get(id)).filter((p): p is string => !!p)
      .map((p) => (stemOf(p) === dirOf(p).split('/').pop() ? `${dirOf(p)}/` : `${p.replace(/\.md$/, '')}/`))
    for (const [id, at] of located) {
      if (listed.has(id) || merged.has(id)) continue
      if (input.rootIds?.length && !input.rootIds.includes(id) && !rootDirs.some((dir) => at.startsWith(dir))) continue
      let failed = false
      const found = await source.lookup(id, signal).catch((error) => {
        if ((error as { code?: string })?.code === 'source_auth') throw error
        failed = true
        return null
      })
      // Gone only when the source said so (not when the request failed).
      if (!found && !failed && gonePaths.length < MAX_LISTED) {
        gonePaths.push(at)
        pathIds[at] = id
        const row = remembered.get(id)
        // Renamed or moved by the person since: the record follows it, so later steps find it there.
        if (row && row.path !== at) await mapping.put(folder, source.id, id, { ...row, path: at })
        const now = await notes.read(at).catch(() => null)
        if (row && now && now.hash !== row.hash) goneEdited.push(at)
      }
      if (found && (!input.rootIds?.length || (found.parentId && listed.has(found.parentId)))) {
        if (found.parentId && !listed.has(found.parentId)) found.parentId = null
        items.push(found)
        listed.add(found.id)
      }
    }
  }
  const known = new Map(items.map((item) => [item.id, item]))
  const listedAtStart = new Set(known.keys())
  const hasChildren = new Set(items.map((item) => item.parentId).filter((id): id is string => !!id))
  // Files this importer saved for a page whose note a stopped run never wrote (a restart between
  // a page's attachments and its note) hold no name: the page gets the same path when the import
  // runs again, so links written to that path meanwhile still lead to it, and its files are found
  // again where they are. A folder holds a name only when something else is under it.
  const ownFiles = new Set([...(await mapping.files(folder, source.id)).values()].map((p) => p.toLowerCase()))
  const holding = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'folder' || ownFiles.has(entry.path.toLowerCase())) continue
    for (let dir = dirOf(entry.path); dir && !holding.has(dir); dir = dirOf(dir)) holding.add(dir)
  }
  const inFolder = new Set(entries.map((entry) => entry.path))
  const folders = new Set(entries.filter((entry) => entry.type === 'folder').map((entry) => entry.path))
  const planned = occupied.filter((p) => !inFolder.has(p) || (folders.has(p) ? holding.has(p) : !ownFiles.has(p.toLowerCase())))
  const planner = new PathPlanner(folder, located, planned)
  // A new "Title (2)" beside a note of the person's named "Title" (not one an import made).
  const imported = new Set([...located.values()].map((p) => p.toLowerCase()))
  const personsNotes = new Map(occupied.filter((p) => p.endsWith('.md') && !imported.has(p.toLowerCase())).map((p) => [p.toLowerCase(), p]))
  const personsNoteNamed = (path: string): string | null => {
    const m = /^(.*) \(\d+\)$/.exec(stemOf(path))
    if (!m) return null
    const dir = dirOf(path)
    const parent = dir.slice(dir.lastIndexOf('/') + 1) === stemOf(path) ? dirOf(dir) : dir
    for (const at of [`${parent}/${m[1]}.md`, `${parent}/${m[1]}/${m[1]}.md`]) {
      const found = personsNotes.get(at.toLowerCase())
      if (found) return found
    }
    return null
  }
  planner.plan(items, hasChildren)
  counts.found = items.length

  let firstPath: string | null = null

  const queue: SourceItem[] = [...items].sort((a, b) => (planner.paths.get(a.id)!.split('/').length - planner.paths.get(b.id)!.split('/').length))
  const linkTo = (id: string, title: string): string => {
    const path = planner.paths.get(id)
    // A page no longer listed (trashed in Notion, its note kept) is named by its note.
    let label = (title || known.get(id)?.title || '').replace(/[[\]|]/g, '')
    // Two pages of one title: the second note is "Title (2)", and its links say so too.
    const numbered = path ? /^(.*) \(\d+\)$/.exec(stemOf(path)) : null
    if (numbered && label && numbered[1] === safeName(label)) label = stemOf(path!)
    if (path) return `[[${path.replace(/\.md$/, '')}|${label || stemOf(path)}]]`
    const outside = label || (titles.get(id) ?? '').replace(/[[\]|]/g, '')
    return `[${outside ? `${outside} (in Notion)` : 'Page in Notion'}](https://www.notion.so/${id.replace(/-/g, '')})`
  }

  // Notes holding a link to a page that had no note when they were written (it came later in
  // this run, or in a run after theirs): the links are made again once the run ends.
  const outsideLinked = new Set<string>()
  const relinked = new Set<string>()

  const savedFiles = await mapping.files(folder, source.id)
  const savedPaths = new Set(savedFiles.values())
  let takenLower: Set<string> | null = null
  async function saveAttachment(notePath: string, file: { url: string; name: string; key: string }): Promise<string | null> {
    let ext = extOf(file.name)
    if (ext && !ATTACHMENT_EXTS.has(ext)) { keptInSource(file.name, notePath); return null }
    // Saved before under its own name (or, by an earlier version, under name-<key>): the same file.
    const savedAt = savedFiles.get(file.key)
    if (savedAt && existingFile.has(savedAt)) return savedAt
    const stem = safeName(file.name.replace(/\.[^.]+$/, ''), 'file').slice(0, 60)
    const dir = `${dirOf(notePath) ? `${dirOf(notePath)}/` : ''}_attachment`
    const fix = (e: string) => (e === 'jpeg' ? 'jpg' : e)
    const keyed = (e: string) => `${dir}/${stem}-${file.key.replace(/-/g, '').slice(-10)}.${fix(e)}`
    if (ext && existingFile.has(keyed(ext))) { await mapping.putFile(folder, source.id, file.key, keyed(ext)); return keyed(ext) }
    const got = await input.download(file.url, MAX_FILE_BYTES, signal)
    if (!got) { keptInSource(file.name, notePath); warnings.length < MAX_LISTED && warnings.push(`${file.name}: could not download (or over 50 MB); it links back to Notion`); return null }
    ext ||= TYPE_EXT[got.type] ?? ''
    if (!ATTACHMENT_EXTS.has(ext)) { keptInSource(file.name, notePath); return null }
    // The name it has in Notion; a second file of that name beside it is "name (2)".
    takenLower ??= new Set([...existingFile].map((p) => p.toLowerCase()))
    let path = `${dir}/${stem}.${fix(ext)}`
    for (let n = 2; takenLower.has(path.toLowerCase()); n++) {
      // With no record of it (another machine, cleared plugin data), a file of that name holding
      // these very bytes is the one saved before.
      const there = existingFile.has(path) && !savedPaths.has(path) ? await notes.readFile(path).catch(() => null) : null
      if (there && sameBytes(there, got.bytes)) { savedFiles.set(file.key, path); savedPaths.add(path); await mapping.putFile(folder, source.id, file.key, path); return path }
      path = `${dir}/${stem} (${n}).${fix(ext)}`
    }
    await notes.writeFile(path, got.bytes)
    existingFile.add(path)
    takenLower.add(path.toLowerCase())
    savedFiles.set(file.key, path)
    savedPaths.add(path)
    await mapping.putFile(folder, source.id, file.key, path)
    counts.files++
    return path
  }

  // Plain notes that became folder notes mid-run (old vault path without .md → new path), and the
  // notes this run wrote, whose links to them are fixed at the end.
  const promoted = new Map<string, string>()
  const writtenThisRun = new Set<string>()

  /** A sub-page an earlier render found and this run has not: asked for by id and queued. */
  async function bringBack(item: SourceItem, childIds: string[] | undefined): Promise<void> {
    if (!source.lookup) return
    for (const id of childIds ?? []) {
      if (known.has(id) || merged.has(id)) continue
      const found = await source.lookup(id, signal).catch((error) => {
        if ((error as { code?: string })?.code === 'source_auth') throw error
        return null
      })
      if (!found || known.has(found.id)) continue
      found.parentId = item.id
      known.set(found.id, found)
      planner.planOne(found)
      counts.found++
      queue.push(found)
      nudge()
    }
  }

  async function importOne(item: SourceItem): Promise<void> {
    let path = planner.paths.get(item.id)!
    const current = existingFile.has(path) ? await notes.read(path) : null
    const record = remembered.get(item.id)
    if (!current && record && !freshStart && !located.has(item.id) && record.edited === item.editedAt && !restore.has(item.id)) {
      // Written before, deleted in Walnut since, and unchanged in the source: the person's choice stands.
      counts.deleted++
      if (deletedPaths.length < MAX_LISTED) { deletedPaths.push(record.path); pathIds[record.path] = item.id }
      return
    }
    // A note found by its frontmatter on a box with no record of the run that wrote it (a fresh
    // install, a restored vault) is taken as written then, with its own edited stamp.
    // It is unedited only while body and frontmatter are still as written (the stamped hash matches,
    // no key of the person's). A note naming the page that this importer never stamped (another
    // export, a sync tool) is the person's, and stays as it is.
    const editedOnDisk = current ? frontmatterValue(current.content, `${source.id}_edited`) : undefined
    const before: MappingRow | undefined = remembered.get(item.id)
      ?? (current
        ? { path, edited: editedOnDisk ?? '', hash: editedOnDisk !== undefined && bodyIsAsWritten(current.content, source.id) ? current.hash : '' }
        : undefined)
    if (current && before && before.edited === item.editedAt) {
      counts.unchanged++
      if (current.content.includes(OUTSIDE_MARK)) outsideLinked.add(item.id)
      // A note the person renamed or moved: its record follows it.
      if (!remembered.has(item.id) || before.path !== path) await mapping.put(folder, source.id, item.id, { ...before, path, edited: item.editedAt })
      await bringBack(item, before.children)
      return
    }
    if (current && before && before.hash !== current.hash && replace.has(item.id)) {
      // The person asked for the source's version: theirs is kept first, as a note of its own beside it.
      const dir = dirOf(path)
      for (let n = 1; ; n++) {
        const copy = `${dir ? `${dir}/` : ''}${stemOf(path)} (your edit${n > 1 ? ` ${n}` : ''}).md`
        try {
          await notes.write(copy, `*Your version of [[${path.replace(/\.md$/, '')}|${stemOf(path)}]], kept when you took Notion's version.*\n\n${bodyOf(current.content).replace(/^\s+/, '')}`, { createOnly: true })
          replaced.push({ path, copy })
          break
        } catch (error) {
          if ((error as { code?: string })?.code !== 'note_exists' || n >= 20) throw error
        }
      }
    } else if (current && before && before.hash !== current.hash) {
      // Changed in the source, and the person edited this note since the last import: theirs stays.
      counts.kept++
      if (keptPaths.length < MAX_LISTED) {
        keptPaths.push(path)
        pathIds[path] = item.id
        if (item.url) keptUrls[path] = item.url
      }
      await bringBack(item, before.children)
      return
    }
    progress('importing', item.title)
    let foundChildren = 0
    const children: string[] = []
    const rendered = await source.render(item, {
      linkTo,
      saveAttachment: (file) => saveAttachment(path, file),
      discovered(found) {
        if (found.parentId === item.id && !listedAtStart.has(found.id) && !children.includes(found.id)) children.push(found.id)
        if (known.has(found.id) || merged.has(found.id)) return
        if (input.rootIds?.length && !found.parentId) return
        known.set(found.id, found)
        if (found.parentId === item.id) foundChildren++
        planner.planOne(found)
        counts.found++
        queue.push(found)
        nudge()
      },
      warn(message) {
        const group = pageWarnings.get(message) ?? { titles: new Set<string>(), count: 0 }
        if (!group.titles.has(item.title)) group.count++
        group.titles.add(item.title)
        pageWarnings.set(message, group)
      },
      signal,
    })
    if (foundChildren && !current) {
      const next = planner.promote(item.id)
      if (next) {
        promoted.set(path, next)
        path = next
      }
    }
    const content = composeNote(source.id, item, rendered.body, rendered.properties)
    // An update replaces only the note as it was read; a new note never replaces one made at its
    // path meanwhile (the planner only knew the folder as listed at the start): it takes the next
    // free name instead.
    let written
    for (let attempt = 0; ; attempt++) {
      try {
        written = await notes.write(path, content, current ? { expectedHash: current.hash } : { createOnly: true })
        break
      } catch (error) {
        if (current || (error as { code?: string })?.code !== 'note_exists' || attempt >= 5) throw error
        path = planner.replan(item)
      }
    }
    existingFile.add(written.path)
    writtenThisRun.add(written.path)
    if (content.includes(OUTSIDE_MARK)) outsideLinked.add(item.id)
    await mapping.put(folder, source.id, item.id, { path: written.path, edited: item.editedAt, hash: written.hash, children })
    pathIds[written.path] = item.id
    if (current) {
      counts.updated++
      if (updatedPaths.length < MAX_LISTED) updatedPaths.push(written.path)
    } else {
      counts.created++
      if (!freshStart && newPaths.length < MAX_LISTED) newPaths.push(written.path)
      if (restore.has(item.id)) restored.push(written.path)
      const beside = personsNoteNamed(written.path)
      if (beside && namedApart.length < MAX_LISTED) namedApart.push({ path: written.path, beside })
    }
    firstPath ??= written.path
  }

  // A pool of workers over a queue that grows while it runs (sub-pages found while rendering):
  // an idle worker waits while another is still busy, since that one may add more.
  let busy = 0
  let wake: (() => void) | null = null
  const nudge = () => { const w = wake; wake = null; w?.() }
  // A rejected secret ends the run for every worker, not only the one that met it.
  let fatal: unknown = null
  async function worker(): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      if (fatal) throw fatal
      const item = queue.shift()
      if (!item) {
        if (busy === 0) { nudge(); return }
        // Woken by more work, by the last busy worker finishing, or by Stop.
        await new Promise<void>((resolve) => {
          const prev = wake
          const done = () => { signal.removeEventListener('abort', done); resolve() }
          wake = () => { prev?.(); done() }
          signal.addEventListener('abort', done, { once: true })
        })
        continue
      }
      busy++
      try {
        await importOne(item)
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        if ((error as { code?: string })?.code === 'source_auth') { fatal = error; nudge(); throw error }
        counts.failed++
        if (errors.length < MAX_LISTED) errors.push({ title: item.title, message: error instanceof Error ? error.message : String(error) })
      } finally {
        busy--
        counts.done++
        progress('importing')
        nudge()
      }
    }
  }

  progress('importing')
  // Every worker has stopped before the run ends: none goes on writing (or reporting progress)
  // after a Stop or a failure.
  const settled = await Promise.allSettled(Array.from({ length: WORKERS }, () => worker()))
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failure) throw failure.reason

  if (promoted.size) {
    const rows = await mapping.all(folder, source.id)
    for (const path of writtenThisRun) {
      const note = await notes.read(path)
      if (!note) continue
      const body = bodyOf(note.content)
      const nextBody = rewriteLinks(body, promoted)
      if (nextBody === body) continue
      const id = importedIdOf(note.content, source.id)
      const row = id ? rows.get(id) : undefined
      // Only a note still as this run wrote it; one the person opened and changed meanwhile is theirs.
      if (!row || row.hash !== note.hash) continue
      try {
        const written = await notes.write(path, withBody(note.content, source.id, nextBody), { expectedHash: note.hash })
        await mapping.put(folder, source.id, id!, { ...row, hash: written.hash })
      } catch (error) {
        if ((error as { code?: string })?.code !== 'note_conflict') throw error
      }
    }
  }
  // Notes the person renamed or moved since the last import: the links the import wrote to them
  // (in notes still as it wrote them) point where they are now. Notes the person edited are theirs.
  const relocated = new Map<string, string>()
  for (const [id, row] of remembered) {
    const now = located.get(id)
    if (now && now !== row.path) relocated.set(row.path, now)
  }
  // A page that became a folder note in a run a restart cut short: its parent was written with a
  // link to `dir/Name`, and the end-of-run pass that points it at `dir/Name/Name` never ran. Every
  // link the import wrote to a folder note's plain-note path leads to the folder note.
  for (const path of planner.paths.values()) {
    const dir = dirOf(path)
    const stem = stemOf(path)
    if (!dir || dir.slice(dir.lastIndexOf('/') + 1) !== stem || !existingFile.has(path)) continue
    const flat = `${dirOf(dir) ? `${dirOf(dir)}/` : ''}${stem}.md`
    if (!existingFile.has(flat) && !relocated.has(flat)) relocated.set(flat, path)
  }
  if (relocated.size) {
    for (const [id, row] of await mapping.all(folder, source.id)) {
      signal.throwIfAborted()
      const note = await notes.read(row.path)
      if (!note || note.hash !== row.hash || importedIdOf(note.content, source.id) !== id) continue
      const body = bodyOf(note.content)
      const nextBody = rewriteLinks(body, relocated)
      if (nextBody === body) continue
      try {
        const written = await notes.write(row.path, withBody(note.content, source.id, nextBody), { expectedHash: note.hash })
        await mapping.put(folder, source.id, id, { ...row, hash: written.hash })
        if (!writtenThisRun.has(row.path) && !relinked.has(row.path)) { relinked.add(row.path); counts.relinked = relinked.size }
      } catch (error) {
        if ((error as { code?: string })?.code !== 'note_conflict') throw error
      }
    }
  }
  if (outsideLinked.size) {
    const rows = await mapping.all(folder, source.id)
    const noteLink = (id: string, title: string): string | null => {
      const path = planner.paths.get(id)
      return path && existingFile.has(path) ? linkTo(id, title) : null
    }
    for (const id of outsideLinked) {
      signal.throwIfAborted()
      const row = rows.get(id)
      if (!row) continue
      const note = await notes.read(row.path)
      // Only a note still as an import wrote it; one the person changed is theirs.
      if (!note || note.hash !== row.hash || importedIdOf(note.content, source.id) !== id) continue
      const body = bodyOf(note.content)
      const nextBody = linkOutside(body, noteLink)
      if (nextBody === body) continue
      try {
        const written = await notes.write(row.path, withBody(note.content, source.id, nextBody), { expectedHash: note.hash })
        await mapping.put(folder, source.id, id, { ...row, hash: written.hash })
        if (!writtenThisRun.has(row.path) && !relinked.has(row.path)) { relinked.add(row.path); counts.relinked = relinked.size }
      } catch (error) {
        if ((error as { code?: string })?.code !== 'note_conflict') throw error
      }
    }
  }
  const roots = items.filter((item) => !item.parentId).map((item) => ({ title: item.title, path: planner.paths.get(item.id)! }))
  firstPath = roots[0]?.path ?? (firstPath && promoted.get(firstPath)) ?? firstPath
  for (const [message, { titles, count }] of pageWarnings) {
    const names = [...titles].slice(0, 3).map((t) => `"${t}"`)
    const more = count - names.length
    warnings.push(`${message}: ${count === 1 ? `in ${names[0]}` : `in ${count} pages, ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`}`)
  }
  return { counts, errors, warnings, keptPaths, deletedPaths, newPaths, updatedPaths, namedApart, replaced, restored, keptUrls, filesInSource, listed, gonePaths, goneEdited, pathIds, firstPath, roots }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
