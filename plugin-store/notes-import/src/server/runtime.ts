/**
 * The plugin's one live state: the Notion connection, the import that runs (one at a time), the
 * organize plan, and what earlier runs did. Every change is saved to the plugin's data folder and
 * sent to open pages as the `state` event.
 */
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'
import { Journal, undoRun, type UndoInfo } from './undo'
import { runImport, type ImportCounts } from './importer'
import { Mapping } from './mapping'
import { NotionClient } from './notion/client'
import { NotionSource } from './notion/source'
import { applyPlan, makePlan, type OrganizePlan } from './organize'
import { matchCase, safeFolder, stemOf } from './paths'
import { unlinkNotes } from './links'
import { bodyOf, composeNote, importedIdOf } from './note-file'
import type { SourceItem } from './types'

export const DEFAULT_FOLDER = 'Import from Notion'
const TOKEN_SECRET = 'notion_token'
const STATE_FILE = 'state.json'
const HISTORY = 10
/** How long the last look at what the connection can see is shown without looking again on load. */
const ACCESS_FRESH_MS = 24 * 60 * 60 * 1000
/** How long Notion may stay silent before the page says it is waiting on Notion. */
const QUIET_MS = 15_000

/** A top-level page or database; `count` is everything in it, itself included, `databases` how many of those are databases. */
export interface AccessRoot { id: string; title: string; kind: 'page' | 'database'; count: number; databases: number }

export interface JobState {
  folder: string
  phase: 'discovering' | 'importing' | 'done' | 'failed' | 'cancelled'
  counts: ImportCounts
  current?: string
  startedAt: string
  endedAt?: string
  error?: string
  errors: Array<{ title: string; message: string }>
  warnings: string[]
  keptPaths: string[]
  deletedPaths?: string[]
  newPaths?: string[]
  updatedPaths?: string[]
  namedApart?: { path: string; beside: string }[]
  replaced?: { path: string; copy: string }[]
  restored?: string[]
  /** The top-level pages this run was limited to (none: everything). */
  rootIds?: string[]
  /** Notes of pages gone from Notion that the person deleted from this run's list (Undo brings them back). */
  removedPaths?: string[]
  keptUrls?: Record<string, string>
  filesInSource?: Array<{ name: string; note: string }>
  gonePaths?: string[]
  /** No earlier import into this folder finished: everything is new, so there is no "new since" list. */
  first?: boolean
  /** Gone notes the person edited in Walnut since the import wrote them. */
  goneEdited?: string[]
  /** The Notion page of each listed path, to follow a note an organize run moved or merged. */
  pathIds?: Record<string, string>
  firstPath: string | null
  roots: Array<{ title: string; path: string }>
  scope: 'all' | 'chosen'
}

export interface OrganizeState {
  phase: 'idle' | 'planning' | 'ready' | 'applying' | 'applied' | 'undoing' | 'failed'
  folder?: string
  /** What the run is doing now, while applying or undoing. */
  step?: 'changing' | 'restoring'
  plan?: OrganizePlan
  error?: string
  progress?: { done: number; total: number }
  result?: { applied: number; done?: { moved: number; merged: number; indexes: number }; skipped: Array<{ why: string; problem: string }>; openPath: string | null }
  /** The last organize run Undo would reverse (shown; the saved one is `Saved.undo`). */
  backup?: UndoInfo
  undoneAt?: string
  /** Notes changed or made after the organize run, which its undo kept. */
  keptEdits?: string[]
  /** The journal of the run being applied, once it is started (a run cut off before has none). */
  journal?: string
}

export interface PublicState {
  version: 1
  now: number
  replica: boolean
  defaultFolder: string
  notion: {
    connected: boolean
    workspace?: string
    user?: string
    checking: boolean
    /** Seconds Notion has not answered while Walnut waits on it, once that is long enough to say. */
    quietFor?: number
    access?: { pages: number; databases: number; roots: AccessRoot[]; checkedAt: string }
    error?: string
  }
  job: JobState | null
  /** `rootIds`: the top-level pages the run was limited to (absent: everything). */
  history: Array<{ folder: string; at: string; phase: JobState['phase']; counts: ImportCounts; firstPath?: string | null; rootIds?: string[]; rootTitles?: string[] }>
  organize: OrganizeState
}

interface Saved {
  defaultFolder?: string
  account?: { workspace: string; user: string } | null
  job?: JobState | null
  history?: PublicState['history']
  organize?: OrganizeState
  /** The journal of the last organize run, until it is undone; whichever folder is picked now. */
  undo?: UndoInfo | null
  /** What the connection could see when last checked, shown at once after a restart. */
  access?: PublicState['notion']['access'] | null
  /** The notes behind `job.removedPaths`, as they were, until the next import. */
  removedGone?: Array<{ path: string; content: string }>
  /** Notes whose links to a deleted gone note became words: their text before, and the hash after, for Undo. */
  unlinked?: Array<{ path: string; content: string; hash: string }>
}

/** `next` (a run for one note) as the report of `prev` with that run's changes added. */
export function mergeReport(prev: JobState, next: JobState): void {
  const union = <T,>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string) => {
    const seen = new Set<string>()
    return [...(a ?? []), ...(b ?? [])].filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true })
  }
  const same = (p: string) => p
  const created = prev.counts.created + next.counts.created
  const updated = prev.counts.updated + next.counts.updated
  next.counts = { ...next.counts, created, updated, unchanged: Math.max(0, next.counts.unchanged - prev.counts.created - prev.counts.updated), files: prev.counts.files + next.counts.files, filesKeptInSource: prev.counts.filesKeptInSource + next.counts.filesKeptInSource, relinked: (prev.counts.relinked ?? 0) + (next.counts.relinked ?? 0) }
  next.newPaths = union(prev.newPaths, next.newPaths, same)
  next.updatedPaths = union(prev.updatedPaths, next.updatedPaths, same)
  next.namedApart = union(prev.namedApart, next.namedApart, (x) => x.path)
  next.replaced = union(prev.replaced, next.replaced, (x) => x.path)
  next.restored = union(prev.restored, next.restored, same)
  next.errors = [...prev.errors, ...next.errors]
  next.warnings = union(prev.warnings, next.warnings, same)
  next.filesInSource = union(prev.filesInSource, next.filesInSource, (x) => `${x.note}\n${x.name}`)
  next.pathIds = { ...prev.pathIds, ...next.pathIds }
  next.first = prev.first || next.first
  next.startedAt = prev.startedAt
}

class UserError extends Error {
  readonly code = 'user'
}

export class Runtime {
  private saved: Saved = {}
  /** Which connection a running access check is for (`accessGen` then), or null. */
  private checkingGen: number | null = null
  /** Moves on every connect and disconnect, so a check of the connection before never lands. */
  private accessGen = 0
  private access: PublicState['notion']['access'] | undefined
  private accessError: string | undefined
  private importAbort: AbortController | null = null
  private planAbort: AbortController | null = null
  /**
   * The one change that runs (an import, a plan, an apply, an undo), taken before the first await,
   * so a second click, a retry after a timeout or another window is refused instead of racing it.
   */
  private busy: 'import' | 'plan' | 'apply' | 'undo' | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  /** The clients talking to Notion now (a check, an import), watched for a Notion that went quiet. */
  private talking = new Set<NotionClient>()
  private quietTicker: ReturnType<typeof setInterval> | null = null
  readonly mapping: Mapping

  constructor(private readonly walnut: WalnutServerApi) {
    this.mapping = new Mapping(walnut.storage.database)
  }

  async load(): Promise<void> {
    this.saved = await this.walnut.storage.readJson<Saved>(STATE_FILE, {})
    // A run cut off by a restart: what it wrote stays; the next run picks up from there.
    if (this.saved.job && (this.saved.job.phase === 'discovering' || this.saved.job.phase === 'importing')) {
      this.saved.job = { ...this.saved.job, phase: 'failed', error: 'Walnut restarted during the import. Import again to finish: notes already brought in are kept.', endedAt: new Date().toISOString() }
    }
    const organize = this.saved.organize
    if (organize?.phase === 'applying' && organize.plan && organize.journal !== this.saved.undo?.id) {
      // Cut off before its journal started: it changed nothing, and the Undo there is an older run's.
      this.saved.organize = { ...organize, phase: 'ready', step: undefined, progress: undefined, error: 'Walnut restarted before organizing began, so nothing changed. The plan is still here.' }
    } else if (organize && (organize.phase === 'planning' || organize.phase === 'applying' || organize.phase === 'undoing')) {
      const cut = organize.phase !== 'planning' && !!this.saved.undo
      this.saved.organize = {
        ...organize, phase: cut ? 'failed' : 'idle', step: undefined, progress: undefined,
        error: cut ? `Walnut restarted while ${organize.phase === 'undoing' ? 'undoing' : 'organizing'}. Undo puts the folder back as it was before organizing.` : undefined,
      }
    }
    this.access = this.saved.account ? this.saved.access ?? undefined : undefined
    await this.save()
    // What the connection can see: the last check is shown at once; a day old (or none), it is
    // looked at again in the background (Check again looks any time).
    const age = this.access ? Date.now() - Date.parse(this.access.checkedAt) : Infinity
    if (this.saved.account && !this.walnut.replica && !(age < ACCESS_FRESH_MS)) void this.checkAccess()
  }

  private async save(): Promise<void> {
    await this.walnut.storage.writeJson(STATE_FILE, this.saved)
  }

  publicState(): PublicState {
    const account = this.saved.account ?? null
    return {
      version: 1,
      now: Date.now(),
      replica: this.walnut.replica,
      defaultFolder: this.saved.defaultFolder || DEFAULT_FOLDER,
      notion: {
        connected: !!account,
        ...(account ? { workspace: account.workspace, user: account.user } : {}),
        checking: this.checkingGen !== null,
        ...(this.access ? { access: this.access } : {}),
        ...(this.accessError ? { error: this.accessError } : {}),
        ...(this.quietFor() ? { quietFor: this.quietFor() } : {}),
      },
      job: this.saved.job ?? null,
      history: this.saved.history ?? [],
      organize: { ...(this.saved.organize ?? { phase: 'idle' }), backup: this.saved.undo ?? undefined },
    }
  }

  /** Send the state to open pages, at most every 250 ms while an import runs. */
  changed(now = false): void {
    if (now) {
      if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null }
      this.walnut.events.emit('state', this.publicState())
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.walnut.events.emit('state', this.publicState())
    }, 250)
  }

  private take(kind: NonNullable<Runtime['busy']>): void {
    if (this.busy === 'import' || this.importAbort) throw new UserError(kind === 'import' ? 'An import is already running.' : 'Wait for the import to finish.')
    if (this.busy) throw new UserError(this.busy === 'undo' ? 'Walnut is undoing the last organize.' : 'Walnut is already organizing.')
    this.busy = kind
  }

  private guardWrite(): void {
    if (this.walnut.replica) throw new UserError('Imports run on your main Walnut, not on a replica.')
    if (this.walnut.testRun?.()) throw new UserError('An automated test run cannot import into your notes.')
    if (!this.walnut.notes) throw new UserError('This Walnut is too old for imports: update it first.')
  }

  private quietFor(): number {
    let ms = 0
    for (const client of this.talking) ms = Math.max(ms, client.quietMs())
    return ms >= QUIET_MS ? Math.round(ms / 1000) : 0
  }

  /** While a client talks to Notion, open pages hear when it goes quiet (and back). */
  private watch(client: NotionClient): () => void {
    this.talking.add(client)
    this.quietTicker ??= setInterval(() => { if (this.quietFor()) this.changed() }, 5000)
    return () => {
      this.talking.delete(client)
      if (!this.talking.size && this.quietTicker) { clearInterval(this.quietTicker); this.quietTicker = null }
    }
  }

  private async client(): Promise<NotionClient> {
    const token = await this.walnut.secrets.get(TOKEN_SECRET)
    if (!token) throw new UserError('Connect Notion first.')
    return new NotionClient(token)
  }

  async connect(token: string): Promise<PublicState> {
    if (this.walnut.replica) throw new UserError('Connect Notion on your main Walnut.')
    if (this.walnut.testRun?.()) throw new UserError('An automated test run cannot connect your Notion.')
    const trimmed = String(token ?? '').trim()
    if (/^(ntn_|secret_)/.test(trimmed) && !/^(ntn_|secret_)\S{20,}$/.test(trimmed)) {
      throw new UserError(/\s/.test(trimmed) ? 'A Notion secret has no spaces in it: copy it again from the connection\'s Configuration tab.' : 'That secret looks too short: copy the whole secret from the connection\'s Configuration tab (Show, then Copy).')
    }
    if (!/^(ntn_|secret_)\S{20,}$/.test(trimmed)) {
      throw new UserError('That does not look like a Notion secret. It starts with "ntn_" (older ones with "secret_"): copy it from the connection\'s Configuration tab.')
    }
    const account = await new NotionSource(new NotionClient(trimmed)).account()
    await this.walnut.secrets.set(TOKEN_SECRET, trimmed)
    this.saved.account = account
    this.accessGen++
    this.access = undefined
    this.saved.access = null
    this.accessError = undefined
    await this.save()
    this.changed(true)
    void this.checkAccess()
    return this.publicState()
  }

  async disconnect(): Promise<PublicState> {
    if (this.walnut.testRun?.()) throw new UserError('An automated test run cannot disconnect your Notion.')
    if (this.importAbort) throw new UserError('Stop the import first.')
    await this.walnut.secrets.delete(TOKEN_SECRET)
    this.saved.account = null
    this.accessGen++
    this.access = undefined
    this.saved.access = null
    this.accessError = undefined
    await this.save()
    this.changed(true)
    return this.publicState()
  }

  /**
   * Delete notes of pages gone from Notion, from the last run's list only, wherever each note is now
   * (renamed or moved since). Links to them in the folder's other notes become their words, since
   * the page is gone in Notion too. Their text is kept until the next import, so Undo
   * (`restoreGone`) brings the notes and those links back.
   */
  async removeGone(paths: string[]): Promise<PublicState> {
    this.guardWrite()
    if (this.busy) throw new UserError('Wait for the import or organize to finish.')
    const job = this.saved.job
    const listed = new Set(job?.gonePaths ?? [])
    const wanted = [...new Set(paths)].filter((p) => listed.has(p))
    if (!job || !wanted.length) throw new UserError('Those notes are not in the last import\'s list any more.')
    const notes = this.walnut.notes!
    const removed: Array<{ path: string; content: string }> = []
    const done = new Set<string>()
    const missing: string[] = []
    for (const path of wanted) {
      const id = job.pathIds?.[path]
      const at = id ? await this.whereIs(job.folder, id, path) : (await notes.read(path)) ? path : null
      const note = at ? await notes.read(at) : null
      if (!at || !note) { missing.push(path); continue }
      await notes.remove(at)
      removed.push({ path: at, content: note.content })
      done.add(path)
    }
    // Links to the deleted notes in the folder's other notes: their words, kept for Undo.
    const unlinked: Array<{ path: string; content: string; hash: string }> = []
    const gonePaths = new Set(removed.map((r) => r.path))
    if (gonePaths.size) {
      for (const entry of await notes.list(job.folder).catch(() => [])) {
        if (entry.type !== 'note') continue
        const note = await notes.read(entry.path)
        if (!note) continue
        const next = unlinkNotes(note.content, gonePaths)
        if (next === note.content) continue
        const written = await notes.write(entry.path, next, { expectedHash: note.hash }).catch(() => null)
        if (written) unlinked.push({ path: entry.path, content: note.content, hash: written.hash })
      }
    }
    job.gonePaths = (job.gonePaths ?? []).filter((p) => !done.has(p))
    job.removedPaths = [...(job.removedPaths ?? []), ...removed.map((r) => r.path)]
    this.saved.removedGone = [...(this.saved.removedGone ?? []), ...removed]
    this.saved.unlinked = [...(this.saved.unlinked ?? []), ...unlinked]
    await this.save()
    this.changed(true)
    if (missing.length) throw new UserError(`Walnut could not find ${missing.length === 1 ? `the note of ${missing[0].replace(/\.md$/, '').split('/').pop()}` : `${missing.length} of those notes`} anywhere in the folder, so nothing was deleted for ${missing.length === 1 ? 'it' : 'them'}.`)
    return this.publicState()
  }

  /** Where the note of `id` is now: at `hint`, at its record's path, or wherever in the folder its frontmatter names that page. */
  private async whereIs(folder: string, id: string, hint?: string): Promise<string | null> {
    const notes = this.walnut.notes!
    const holds = async (path: string) => { const note = await notes.read(path).catch(() => null); return !!note && importedIdOf(note.content, 'notion') === id }
    if (hint && await holds(hint)) return hint
    const row = (await this.mapping.all(folder, 'notion')).get(id)
    if (row && await holds(row.path)) return row.path
    for (const entry of await notes.list(folder).catch(() => [])) if (entry.type === 'note' && await holds(entry.path)) return entry.path
    return null
  }

  /**
   * The last run's lists name notes where the run left them. After an organize run (or its undo)
   * moved or merged some, each that is no longer there follows its page's record to where it is now;
   * one still there (the person may have renamed it before) stays.
   */
  private async followMovedNotes(): Promise<void> {
    const job = this.saved.job
    if (!job?.pathIds || !Object.keys(job.pathIds).length) return
    const rows = await this.mapping.all(job.folder, 'notion')
    const merged = await this.mapping.mergedInto(job.folder, 'notion')
    const there = new Set((await this.walnut.notes!.list(job.folder).catch(() => [])).map((e) => e.path))
    const moved = new Map<string, string>()
    // A note merged into another is no note of its own any more: nothing to delete or replace.
    const mergedAway = new Set<string>()
    for (const [path, id] of Object.entries(job.pathIds)) {
      if (there.has(path)) continue
      if (merged.has(id)) { mergedAway.add(path); moved.set(path, merged.get(id)!); continue }
      const now = rows.get(id)?.path
      if (now && now !== path && there.has(now)) moved.set(path, now)
    }
    if (!moved.size) return
    const at = (p: string) => moved.get(p) ?? p
    const list = (xs?: string[]) => (xs ? [...new Set(xs.map(at))] : xs)
    const own = (xs?: string[]) => (xs ? list(xs.filter((p) => !mergedAway.has(p))) : xs)
    job.keptPaths = own(job.keptPaths)!
    job.deletedPaths = list(job.deletedPaths)
    job.newPaths = list(job.newPaths)
    job.updatedPaths = list(job.updatedPaths)
    job.restored = list(job.restored)
    job.gonePaths = own(job.gonePaths)
    job.goneEdited = own(job.goneEdited)
    job.namedApart = job.namedApart?.map((x) => ({ ...x, path: at(x.path) }))
    job.replaced = job.replaced?.map((x) => ({ ...x, path: at(x.path) }))
    if (job.keptUrls) job.keptUrls = Object.fromEntries(Object.entries(job.keptUrls).map(([p, u]) => [at(p), u]))
    if (job.firstPath) job.firstPath = at(job.firstPath)
    job.pathIds = Object.fromEntries(Object.entries(job.pathIds).filter(([p]) => !mergedAway.has(p)).map(([p, id]) => [at(p), id]))
  }

  /**
   * Bring back the notes `removeGone` deleted, and the links to them it turned into words (in notes
   * not changed since); a note made at one's place since stays, and that one is not brought back.
   */
  async restoreGone(): Promise<PublicState> {
    this.guardWrite()
    if (this.busy) throw new UserError('Wait for the import or organize to finish.')
    const job = this.saved.job
    const notes = this.walnut.notes!
    const back: string[] = []
    const left: Array<{ path: string; content: string }> = []
    for (const r of this.saved.removedGone ?? []) {
      try {
        await notes.write(r.path, r.content, { createOnly: true })
        back.push(r.path)
      } catch (error) {
        if ((error as { code?: string })?.code !== 'note_exists') throw error
        left.push(r)
      }
    }
    for (const u of this.saved.unlinked ?? []) {
      const now = await notes.read(u.path).catch(() => null)
      if (now && now.hash === u.hash) await notes.write(u.path, u.content, { expectedHash: now.hash }).catch(() => undefined)
    }
    this.saved.unlinked = undefined
    if (job) {
      job.gonePaths = [...(job.gonePaths ?? []), ...back]
      job.removedPaths = left.length ? left.map((r) => r.path) : undefined
    }
    this.saved.removedGone = left.length ? left : undefined
    await this.save()
    this.changed(true)
    if (left.length) throw new UserError(`${left.length === 1 ? 'A note was' : `${left.length} notes were`} made where ${left.length === 1 ? 'it was' : 'they were'} since, so ${left.length === 1 ? 'it stays' : 'they stay'} deleted.`)
    return this.publicState()
  }

  /** What the connection can see: counts and the top-level pages, for the page picker. */
  async checkAccess(): Promise<PublicState> {
    const gen = this.accessGen
    if (this.checkingGen === gen || !this.saved.account) return this.publicState()
    this.checkingGen = gen
    this.accessError = undefined
    this.changed(true)
    try {
      const client = await this.client()
      const unwatch = this.watch(client)
      let items: SourceItem[]
      try { items = await new NotionSource(client).discover(this.walnut.signal, () => undefined) } finally { unwatch() }
      if (gen === this.accessGen) {
        this.access = summarize(items)
        this.saved.access = this.access
        await this.save()
      }
    } catch (error) {
      if (gen === this.accessGen) {
        this.accessError = error instanceof Error ? error.message : String(error)
        if ((error as { code?: string })?.code === 'source_auth') {
          this.saved.account = null
          this.saved.access = null
          this.access = undefined
          this.accessGen++
          await this.save()
        }
      }
    } finally {
      if (this.checkingGen === gen) this.checkingGen = null
      this.changed(true)
    }
    return this.publicState()
  }

  /**
   * A note the person edited, beside Notion's version of its page now: both texts, for the page to
   * show side by side. Reads Notion only; writes nothing, downloads no file.
   */
  async previewNotion(path: string): Promise<{ path: string; title: string; mine: string; theirs: string }> {
    const notes = this.walnut.notes!
    const note = await notes.read(path)
    if (!note) throw new UserError('That note is not there any more.')
    const id = importedIdOf(note.content, 'notion')
    if (!id) throw new UserError('That note did not come from Notion.')
    const client = await this.client()
    const source = new NotionSource(client)
    const signal = this.walnut.signal
    const item = await source.lookup(id, signal)
    if (!item) throw new UserError('Notion no longer has that page, or no longer shares it with the connection.')
    // Links read as they do in the note: to the note a page became, else the page's title.
    const record = await this.mapping.recordAt('notion', path)
    const paths = new Map([...(record ? await this.mapping.all(record.folder, 'notion') : [])].map(([itemId, row]) => [itemId, row.path]))
    const rendered = await source.render(item, {
      linkTo: (linked, title) => { const at = paths.get(linked); const label = title || (at ? stemOf(at) : 'Untitled'); return at ? `[[${at.replace(/\.md$/, '')}|${label}]]` : label },
      saveAttachment: async () => null,
      discovered: () => undefined,
      warn: () => undefined,
      signal,
    })
    return { path, title: item.title, mine: bodyOf(note.content).trim(), theirs: bodyOf(composeNote('notion', item, rendered.body, rendered.properties)).trim() }
  }

  async folders(): Promise<string[]> {
    if (!this.walnut.notes) return []
    const entries = await this.walnut.notes.list()
    return entries
      .filter((e) => e.type === 'folder' && !e.path.split('/').some((part) => part === '_attachment' || part.startsWith('.')))
      .map((e) => e.path)
      .slice(0, 2000)
  }

  async startImport(input: { folder?: string; rootIds?: string[]; takeNotion?: string[]; bringBack?: string[] }): Promise<PublicState> {
    this.guardWrite()
    const typed = safeFolder(input.folder || this.saved.defaultFolder || DEFAULT_FOLDER)
    if (!typed) throw new UserError('Pick a folder to import into.')
    // A folder the notes have under another case is that folder (one folder on a Mac's disk).
    const folder = matchCase(typed, [...(this.saved.history ?? []).map((run) => run.folder), ...await this.folders().catch(() => [])])
    if (folder.split('/').includes('_attachment')) throw new UserError('Folders named _attachment hold the files of notes. Pick another folder.')
    const rootIds = (input.rootIds ?? []).filter((id) => typeof id === 'string' && id)
    this.take('import')
    const abort = new AbortController()
    this.importAbort = abort
    let client: NotionClient
    // Notes the person asked to take Notion's version of, by the page each one came from.
    const replace: string[] = []
    const restore: string[] = []
    try {
      client = await this.client()
      for (const path of (input.takeNotion ?? []).filter((p) => typeof p === 'string' && p.startsWith(`${folder}/`))) {
        const note = await this.walnut.notes!.read(path)
        const id = note ? importedIdOf(note.content, 'notion') : null
        if (id) replace.push(id)
      }
      // Notes the person deleted, by the record that names their place.
      const wantBack = new Set((input.bringBack ?? []).filter((p) => typeof p === 'string'))
      if (wantBack.size) for (const [id, row] of await this.mapping.all(folder, 'notion')) if (wantBack.has(row.path)) restore.push(id)
    } catch (error) { this.importAbort = null; this.busy = null; throw error }
    const source = new NotionSource(client)
    const unwatch = this.watch(client)
    const job: JobState = {
      folder,
      phase: 'discovering',
      counts: { found: 0, done: 0, created: 0, updated: 0, unchanged: 0, kept: 0, failed: 0, files: 0, filesKeptInSource: 0, deleted: 0 },
      startedAt: new Date().toISOString(),
      errors: [], warnings: [], keptPaths: [], firstPath: null, roots: [],
      scope: rootIds.length ? 'chosen' : 'all',
      ...(rootIds.length ? { rootIds } : {}),
      first: !(this.saved.history ?? []).some((run) => run.folder === folder && run.phase === 'done'),
    }
    const before = { job: this.saved.job, defaultFolder: this.saved.defaultFolder, removedGone: this.saved.removedGone, unlinked: this.saved.unlinked }
    this.saved.job = job
    // A new run's list stands on its own: what the last one deleted is no longer offered back.
    this.saved.removedGone = undefined
    this.saved.unlinked = undefined
    this.saved.defaultFolder = folder
    try { await this.save() } catch (error) {
      Object.assign(this.saved, before)
      unwatch()
      this.importAbort = null
      this.busy = null
      throw error
    }
    this.changed(true)
    const signal = AbortSignal.any([abort.signal, this.walnut.signal])
    let ended = false
    // The connection this run is for, and whether the run saw all it can see.
    const gen = this.accessGen
    let seen = false
    void (async () => {
      try {
        const outcome = await runImport({
          source, notes: this.walnut.notes!, mapping: this.mapping, folder, rootIds, replace, restore,
          download: (url, max, s) => client.download(url, max, s),
          signal,
          onProgress: (p) => {
            // A late report never turns an ended run back into a running one.
            if (ended) return
            job.phase = p.phase
            job.counts = p.counts
            job.current = p.current
            if (p.filesInSource) job.filesInSource = p.filesInSource
            this.changed()
          },
        })
        Object.assign(job, { phase: 'done', counts: outcome.counts, errors: outcome.errors, warnings: outcome.warnings, keptPaths: outcome.keptPaths, deletedPaths: outcome.deletedPaths, newPaths: outcome.newPaths, updatedPaths: outcome.updatedPaths, namedApart: outcome.namedApart, replaced: outcome.replaced, restored: outcome.restored, keptUrls: outcome.keptUrls, filesInSource: outcome.filesInSource, gonePaths: outcome.gonePaths, goneEdited: outcome.goneEdited, pathIds: outcome.pathIds, firstPath: outcome.firstPath, roots: outcome.roots })
        // A run for one note (Use Notion's version, Bring back) adds to the report of the run before
        // it instead of replacing it: what that run found stays on the page.
        if ((replace.length || restore.length) && before.job?.phase === 'done' && before.job.folder === folder) mergeReport(before.job, job)
        // Carry on finishes the stopped run: one report for the whole import.
        else if (before.job?.phase === 'cancelled' && before.job.folder === folder) mergeReport(before.job, job)
        // The run listed the whole workspace: what the connection can see is that list now.
        if (outcome.listed && gen === this.accessGen) {
          this.access = summarize(outcome.listed)
          this.saved.access = this.access
          seen = true
        }
        this.walnut.log.info('import finished', { folder, ...outcome.counts, calls: client.calls })
      } catch (error) {
        const cancelled = abort.signal.aborted
        job.phase = cancelled ? 'cancelled' : 'failed'
        if (!cancelled) job.error = error instanceof Error ? error.message : String(error)
        if ((error as { code?: string })?.code === 'source_auth') this.saved.account = null
        this.walnut.log.warn('import ended early', { folder, cancelled, error: job.error })
      } finally {
        unwatch()
        ended = true
        job.current = undefined
        job.endedAt = new Date().toISOString()
        this.importAbort = null
        this.busy = null
        this.saved.history = [{ folder, at: job.endedAt, phase: job.phase, counts: job.counts, firstPath: job.firstPath, ...(rootIds.length ? { rootIds, rootTitles: rootIds.map((id) => this.access?.roots.find((r) => r.id === id)?.title ?? '') } : {}) }, ...(this.saved.history ?? [])].slice(0, HISTORY)
        await this.save().catch(() => undefined)
        this.changed(true)
        // A run that ended without its list (stopped, failed): what the connection can see is looked
        // at again, so the counts and the page picker are not those of before the run.
        if (job.phase === 'done' && !seen && this.saved.account) void this.checkAccess()
      }
    })()
    return this.publicState()
  }

  cancelImport(): PublicState {
    this.importAbort?.abort(new Error('cancelled'))
    return this.publicState()
  }

  async plan(folderInput: string | undefined): Promise<PublicState> {
    this.guardWrite()
    const folder = safeFolder(folderInput || this.saved.job?.folder || this.saved.defaultFolder || DEFAULT_FOLDER)
    if (!folder) throw new UserError('Pick a folder to organize.')
    // A run that stopped part way is undone first: a new run would take its Undo away.
    if (this.saved.undo && !this.saved.undo.finished) throw new UserError('The last organize stopped part way. Undo it first, so the folder is whole again.')
    this.take('plan')
    const abort = new AbortController()
    this.planAbort = abort
    const before = this.saved.organize
    this.saved.organize = { phase: 'planning', folder }
    try { await this.save() } catch (error) { this.planAbort = null; this.busy = null; this.saved.organize = before; throw error }
    this.changed(true)
    void (async () => {
      try {
        const plan = await makePlan(this.walnut, this.walnut.notes!, folder, AbortSignal.any([abort.signal, this.walnut.signal]))
        if (!abort.signal.aborted) this.saved.organize = { phase: 'ready', folder, plan }
      } catch (error) {
        if (!abort.signal.aborted) this.saved.organize = { phase: 'failed', folder, error: error instanceof Error ? error.message : String(error) }
        else if (this.planAbort === abort) this.saved.organize = { phase: 'idle', folder }
      } finally {
        // A cancelled run let go when it was cancelled; one that ends after that changes nothing.
        if (this.planAbort === abort) {
          this.planAbort = null
          this.busy = null
          await this.save().catch(() => undefined)
          this.changed(true)
        }
      }
    })()
    return this.publicState()
  }

  async cancelPlan(): Promise<PublicState> {
    const organize = this.saved.organize
    if (this.planAbort) {
      // The plan is dropped at once: the AI run may take a moment to stop, and only reads.
      this.planAbort.abort(new Error('cancelled'))
      this.planAbort = null
      this.busy = null
      this.saved.organize = { phase: 'idle', folder: organize?.folder }
      await this.save()
      this.changed(true)
      return this.publicState()
    }
    // Discard a plan, or put a finished (or failed) run aside: Undo stays possible from idle.
    if (!this.planAbort && organize && (organize.phase === 'ready' || organize.phase === 'applied' || organize.phase === 'failed')) {
      this.saved.organize = { phase: 'idle', folder: organize.folder }
      await this.save()
      this.changed(true)
    }
    return this.publicState()
  }

  async apply(leaveOut: number[] = [], madeAt?: string): Promise<PublicState> {
    this.guardWrite()
    const organize = this.saved.organize
    if (organize?.phase !== 'ready' || !organize.plan) throw new UserError('There is no plan to apply.')
    // The steps left out are positions in the plan the person looked at, so only that plan is applied.
    if (madeAt && madeAt !== organize.plan.madeAt) throw new UserError('The plan changed since you looked at it. Check the new plan, then apply it.')
    const left = new Set(leaveOut)
    const plan = { ...organize.plan, steps: organize.plan.steps.filter((_, i) => !left.has(i)) }
    // Every step the person saw, the ones left out too: an index links where those would have put a note.
    const allSteps = organize.plan.steps.map((s) => s.step)
    if (!plan.steps.some((s) => s.ok)) throw new UserError('Every step is left out: there is nothing to apply.')
    this.take('apply')
    this.saved.organize = { ...organize, phase: 'applying', step: 'changing', progress: { done: 0, total: plan.steps.length }, error: undefined }
    this.changed(true)
    void (async () => {
      let journal: Journal | null = null
      try {
        await this.save()
        journal = await Journal.start(this.walnut.storage.dataDir, plan.folder)
        // From here on Undo reverses whatever this run did, however far it got.
        this.saved.undo = journal.info
        this.saved.organize = { ...this.saved.organize!, undoneAt: undefined, keptEdits: undefined, journal: journal.info.id }
        await this.save()
        this.changed(true)
        const result = await applyPlan({
          notes: this.walnut.notes!, mapping: this.mapping, sourceId: 'notion', plan, journal, signal: this.walnut.signal,
          allSteps,
          onStep: (done, total) => { this.saved.organize = { ...this.saved.organize!, progress: { done, total } }; this.changed() },
        })
        const { moves: _moves, ...shown } = result
        this.saved.undo = { ...journal.info, finished: true }
        this.saved.organize = { ...this.saved.organize!, phase: 'applied', step: undefined, result: shown }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Before the journal was started nothing changed: the plan is still there to apply.
        this.saved.organize = !journal
          ? { ...this.saved.organize!, phase: 'ready', step: undefined, progress: undefined, error: `Could not start, so nothing changed: ${message}` }
          : { ...this.saved.organize!, phase: 'failed', step: undefined, error: message }
      } finally {
        this.busy = null
        await this.followMovedNotes().catch(() => undefined)
        await this.save().catch(() => undefined)
        this.changed(true)
      }
    })()
    return this.publicState()
  }

  async undo(): Promise<PublicState> {
    this.guardWrite()
    const run = this.saved.undo
    if (!run) throw new UserError('There is nothing to undo.')
    this.take('undo')
    const before = this.saved.organize
    this.saved.organize = { phase: 'undoing', folder: run.folder, step: 'restoring', progress: { done: 0, total: 0 } }
    this.changed(true)
    void (async () => {
      try {
        await this.save()
        const { kept } = await undoRun({
          notes: this.walnut.notes!, mapping: this.mapping, dataDir: this.walnut.storage.dataDir, id: run.id, signal: this.walnut.signal,
          onStep: (done, total) => { this.saved.organize = { ...this.saved.organize!, progress: { done, total } }; this.changed() },
        })
        this.saved.undo = null
        this.saved.organize = { phase: 'idle', folder: run.folder, undoneAt: new Date().toISOString(), keptEdits: kept.slice(0, 100) }
      } catch (error) {
        // The journal stays, so Undo can be run again: what it already reversed it skips.
        this.saved.organize = { ...(before ?? { phase: 'idle' }), phase: 'failed', folder: run.folder, step: undefined, progress: undefined, plan: undefined, error: `Undo did not finish: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        this.busy = null
        await this.followMovedNotes().catch(() => undefined)
        await this.save().catch(() => undefined)
        this.changed(true)
      }
    })()
    return this.publicState()
  }


  stop(): void {
    this.importAbort?.abort(new Error('stopped'))
    this.planAbort?.abort(new Error('stopped'))
    if (this.emitTimer) clearTimeout(this.emitTimer)
    if (this.quietTicker) clearInterval(this.quietTicker)
  }
}

function summarize(items: SourceItem[]): NonNullable<PublicState['notion']['access']> {
  const children = new Map<string, string[]>()
  for (const item of items) if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id])
  const kindOf = new Map(items.map((item) => [item.id, item.kind]))
  const countUnder = (id: string): { count: number; databases: number } => {
    let count = 0
    let databases = 0
    const stack = [id]
    const seen = new Set<string>()
    while (stack.length) {
      const next = stack.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      count++
      if (kindOf.get(next) === 'database') databases++
      stack.push(...(children.get(next) ?? []))
    }
    return { count, databases }
  }
  const roots = items
    .filter((item) => !item.parentId)
    .map((item) => ({ id: item.id, title: item.title, kind: item.kind, ...countUnder(item.id) }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
  return {
    pages: items.filter((item) => item.kind === 'page').length,
    databases: items.filter((item) => item.kind === 'database').length,
    roots,
    checkedAt: new Date().toISOString(),
  }
}

export { UserError }
