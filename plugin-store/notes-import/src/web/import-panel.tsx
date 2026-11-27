/**
 * What to import and where, the Import button, and the run: its progress while it goes and
 * what it did when it ends.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import type { ImportStore, PublicState } from './store'
import { inNotes, plural, pointWords } from './words'
import { matchCase, safeFolder } from '../server/paths'
import { folderScope, scopeIds, type FolderScope } from './folder-scope'
import { diffNoteLines } from './line-diff'
import { Checkbox, Radio } from './host-controls'

type Setter<T> = (next: T | ((prev: T) => T)) => void
type UseView = <T>(name: string, initial: T) => [T, Setter<T>]

/** "6 pages, 1 database": what choosing a top-level page brings in. */
function whatIsIn(root: { count: number; databases?: number }): string {
  const databases = root.databases ?? 0
  return [root.count - databases ? plural(root.count - databases, 'page') : '', databases ? plural(databases, 'database') : ''].filter(Boolean).join(', ')
}

export function ImportPanel(props: { walnut: WalnutWebApi; store: ImportStore; state: PublicState; useView: UseView; openNote(path: string): void; onPickFolder?(set: (folder: string) => void): void }) {
  const { store, state, useView } = props
  const access = state.notion.access
  const job = state.job
  const running = job?.phase === 'discovering' || job?.phase === 'importing'
  // An organize run holds the notes while it plans, applies or undoes: importing waits for it.
  const organizing = organizingWords(state.organize.phase)
  const [scope, setScope] = useView<'all' | 'some'>('scope', 'all')
  const [chosen, setChosen] = useView<string[]>('chosen', [])
  // null: not typed in yet, so the last folder used (or the default) shows. An emptied field stays empty.
  const [folder, setFolder] = useView<string | null>('folder', null)
  const [folders, setFolders] = useState<string[] | null>(null)
  const [filterText, setFilterText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The folder as the import will name it (`../a//b` is `a/b`), so every check below reads that.
  const typedFolder = (folder ?? state.defaultFolder).trim()
  const named = safeFolder(typedFolder)
  const cleaned = !!named && named !== typedFolder.replace(/\/+$/, '')
  // A folder the notes have under another case is that folder: a Mac's disk takes both for one.
  const target = matchCase(named, [...state.history.map((run) => run.folder), ...(folders ?? [])])
  const recased = target !== named
  const inAttachments = target.split('/').includes('_attachment')

  useEffect(() => {
    let live = true
    void store.call<{ folders: string[] }>('folders').then((outcome) => { if (live && outcome.ok) setFolders(outcome.result.folders) })
    return () => { live = false }
  }, [store, job?.endedAt])

  const roots = access?.roots ?? []
  const visibleRoots = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    return q ? roots.filter((root) => root.title.toLowerCase().includes(q)) : roots
  }, [roots, filterText])
  const total = access ? access.pages + access.databases : 0
  // The folder once typing pauses: the lines below and What follow that, not each key ("Proj" on the
  // way to "Projects", or an import folder a longer path passes through).
  const [settled, setSettled] = useState(target)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(target), 500)
    return () => clearTimeout(timer)
  }, [target])
  const before = state.history.some((run) => run.folder === settled && run.phase === 'done')
  const stopped = job?.phase === 'cancelled' && job.folder === settled
  // Folders this Notion went into before: another one gets its own copy, updated on its own.
  const elsewhere = [...new Set(state.history.filter((run) => run.phase === 'done' && run.folder !== settled).map((run) => run.folder))]
  // An import folder this one would sit inside (its notes are the other import's to keep).
  const insideOf = elsewhere.find((f) => settled.startsWith(`${f}/`))
  // Each import folder keeps the pages it was made from, and What follows them while Into names
  // it; the person's own choice comes back when Into names another folder, or with one click.
  const followed = folderScope(state.history, settled)
  // Pages the folder follows that Notion no longer shows (deleted there, or no longer shared): an
  // import still looks for them, and lists their notes as gone, to keep or delete.
  const goneRoots: string[] = roots.length > 0 && followed && !followed.all ? followed.rootIds.filter((id) => !roots.some((root) => root.id === id)) : []
  const chosenLive = chosen.filter((id) => roots.some((root) => root.id === id) || goneRoots.includes(id))
  const chosenGone = chosenLive.filter((id) => goneRoots.includes(id))
  const goneTitle = (id: string) => state.history.flatMap((run) => (run.rootIds ?? []).map((r, i) => (r === id ? run.rootTitles?.[i] : undefined))).find(Boolean) || 'A page'
  const chosenRoots = roots.filter((root) => chosenLive.includes(root.id))
  const chosenCount = { count: chosenRoots.reduce((sum, root) => sum + root.count, 0), databases: chosenRoots.reduce((sum, root) => sum + (root.databases ?? 0), 0) }
  const applyScope = (kept: FolderScope) => {
    if (kept.all) setScope('all')
    else { setScope('some'); setChosen(kept.rootIds) }
  }
  const own = useRef<{ scope: 'all' | 'some'; chosen: string[] } | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const lastSettled = useRef(settled)
  useEffect(() => {
    if (lastSettled.current === settled) return
    lastSettled.current = settled
    if (running) return
    const kept = folderScope(state.history, settled)
    if (kept) {
      own.current ??= { scope, chosen }
      applyScope(kept)
      setFollowing(settled)
    } else {
      if (own.current) { setScope(own.current.scope); setChosen(own.current.chosen) }
      own.current = null
      setFollowing(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])
  // A choice the person makes is theirs from then on.
  const chooseScope = (next: 'all' | 'some') => { own.current = null; setFollowing(null); setScope(next) }
  const chooseRoots: typeof setChosen = (next) => { own.current = null; setFollowing(null); setChosen(next) }
  const useOwn = () => {
    if (own.current) { setScope(own.current.scope); setChosen(own.current.chosen) }
    own.current = null
    setFollowing(null)
  }
  props.onPickFolder?.((f) => {
    setFolder(f)
    const kept = folderScope(state.history, f)
    if (kept) applyScope(kept)
  })
  // Importing less than the folder follows updates only that part; more brings new pages into it.
  // Both read the page list: not before the connection's check has one.
  const narrower = roots.length > 0 && !!followed && scope === 'some' && (followed.all || followed.rootIds.some((id) => !chosenLive.includes(id)))
  const broader = roots.length > 0 && !!followed && !followed.all && !narrower && (scope === 'all' || chosenLive.some((id) => !followed.rootIds.includes(id)))
  const canStart = !running && !organizing && !busy && !!target && target === settled && !inAttachments && !!access && total > 0 && (scope === 'all' || chosenLive.length > 0)

  async function start() {
    setBusy(true)
    setProblem(null)
    const outcome = await store.call('import_start', { folder: target, rootIds: scope === 'some' ? chosenLive : [] })
    setBusy(false)
    if (!outcome.ok) { setProblem(outcome.message); return }
    // The field shows the folder as the import named it.
    if (target !== typedFolder) setFolder(target)
    // The run's card, with its progress and Stop, comes into view.
    requestAnimationFrame(() => document.querySelector('[data-testid="ni-run"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  return (
    <section className="ni-block" aria-labelledby="ni-import-head">
      <div className="ni-block-head"><h2 id="ni-import-head">Import</h2></div>
      <div className="ni-group">
        <div className="ni-row ni-row-top">
          <div className="ni-row-copy">
            <span>What</span>
            <div className="ni-choice" role="group" aria-label="What to import">
              <Radio name="ni-scope" checked={scope === 'all'} onChange={() => chooseScope('all')} disabled={running} data-testid="ni-scope-all"
                label={`Everything shared with the connection${access ? ` (${[plural(access.pages, 'page'), access.databases ? plural(access.databases, 'database') : ''].filter(Boolean).join(', ')})` : ''}`} />
              <Radio name="ni-scope" checked={scope === 'some'} onChange={() => chooseScope('some')} disabled={running || !roots.length} data-testid="ni-scope-some"
                label="Only some top-level pages" />
            </div>
            <span className="ni-help">Sub-pages come along, including ones Notion only lists inside a page, so the count can grow while it imports.</span>
            {target === settled && following === settled && followed && !narrower && !broader && (
              <span className="ni-help ni-note" data-testid="ni-scope-picked">
                Set to match {inNotes(settled)}: {followed.all ? 'everything' : `the ${plural(followed.rootIds.length, 'top-level page')}`} it was made from, so its notes update together.
                {own.current && <>{' '}<button type="button" className="btn btn-link ni-link" onClick={useOwn} disabled={running} data-testid="ni-scope-use-own">Use my own choice</button></>}
              </span>
            )}
            {scope === 'some' && roots.length > 0 && (
              <div className="ni-picker" data-testid="ni-root-picker">
                {roots.length > 8 && (
                  <input className="ni-input ni-filter" placeholder="Find a page" aria-label="Find a page" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                )}
                <div className="ni-picker-list">
                  {visibleRoots.map((root) => (
                    <Checkbox
                      key={root.id}
                      className="ni-check"
                      checked={chosenLive.includes(root.id)}
                      disabled={running}
                      onChange={(on) => chooseRoots((prev) => on ? [...new Set([...prev, root.id])] : prev.filter((id) => id !== root.id))}
                      data-testid="ni-root"
                      label={<span className="ni-check-line"><span className="ni-check-title">{root.title}</span><span className="ni-muted">{whatIsIn(root)}</span></span>}
                    />
                  ))}
                  {!visibleRoots.length && <span className="ni-muted ni-pad">No page matches.</span>}
                </div>
                {chosenGone.length > 0 && (
                  <span className="ni-help" data-tone="warn" data-testid="ni-scope-gone">
                    {chosenGone.length === 1 ? `${goneTitle(chosenGone[0])} is` : `${chosenGone.map(goneTitle).join(', ')} are`} no longer in Notion (deleted there, or no longer shared with the connection). Import changes looks for {chosenGone.length === 1 ? 'it' : 'them'} and lists the notes, so you can keep or delete them.
                  </span>
                )}
                <span className="ni-muted">{chosenLive.length ? `${plural(chosenLive.length, 'top-level page')} chosen: ${whatIsIn(chosenCount)}, with what is under ${chosenLive.length === 1 ? 'it' : 'them'}` : 'Choose at least one page'}</span>
              </div>
            )}
          </div>
        </div>
        <div className="ni-row">
          <div className="ni-row-copy">
            <label htmlFor="ni-folder">Into</label>
            {!target && <span className="ni-help" data-tone="warn">Type the name of a folder to import into.</span>}
            {/* One line of where the pages go, then at most one warning, once typing pauses. */}
            {target && target === settled && !running && !inAttachments && (
              <span className="ni-help" data-testid="ni-folder-kind">
                {(cleaned || recased) && <span data-testid="ni-folder-cleaned">Imports into {inNotes(target)}{cleaned ? ', as folder names keep only what notes can hold' : ''}. </span>}
                {stopped ? 'This folder holds the import you stopped: Carry on finishes it.'
                  : !folders ? 'A folder in your notes: type a new name, or pick one you have.'
                  : folders.some((f) => f.toLowerCase() === target.toLowerCase())
                    ? before ? 'This folder holds an earlier import.' : 'A folder you have: the pages go in beside what is there, never over it.'
                    : 'A new folder: Walnut makes it.'}
              </span>
            )}
            {target === settled && narrower && (
              <span className="ni-help" data-tone="warn" data-testid="ni-scope-narrower">
                This folder was made from {followed!.all ? 'everything shared with the connection' : plural(followed!.rootIds.length, 'top-level page')}. This import updates only the pages ticked above; its other notes stay as they are.
                {' '}<button type="button" className="btn btn-link ni-link" onClick={() => { applyScope(followed!); own.current = null }} disabled={running} data-testid="ni-scope-use-folder">Import all it was made from</button>
              </span>
            )}
            {target === settled && broader && (
              <span className="ni-help" data-tone="warn" data-testid="ni-scope-broader">
                This folder was made from {plural(followed!.rootIds.length, 'top-level page')}. This import also brings {scope === 'all' ? 'everything else shared with the connection' : 'the other ticked pages'} into it.
                {' '}<button type="button" className="btn btn-link ni-link" onClick={() => { applyScope(followed!); own.current = null }} disabled={running} data-testid="ni-scope-use-folder">Import only its pages</button>
              </span>
            )}
            {inAttachments && <span className="ni-help" data-tone="warn" data-testid="ni-folder-attachments">Folders named _attachment hold the files of notes. Pick another folder.</span>}
            {target && target === settled && !running && !stopped && !inAttachments && !before && !narrower && !broader && (insideOf || elsewhere.length > 0) && (
              <span className="ni-help" data-tone="warn" data-testid="ni-second-copy">
                {insideOf
                  ? <>This sits inside "{insideOf}", an earlier import, so it would be a second copy inside the first.</>
                  : elsewhere.length === 1
                    ? <>A separate copy: "{elsewhere[0]}" already holds an import of this Notion, and the two update apart.</>
                    : <>A separate copy: {elsewhere.length} other folders already hold imports of this Notion (under Imported notes), and each updates apart.</>}
                {(insideOf || elsewhere.length === 1) && <>{' '}<button type="button" className="btn btn-link ni-link" onClick={() => setFolder(insideOf ?? elsewhere[0])} disabled={running} data-testid="ni-second-copy-use">Import into "{insideOf ?? elsewhere[0]}"</button></>}
              </span>
            )}
          </div>
          <div className="ni-row-actions">
            <span className="ni-folder-prefix" aria-hidden="true">Notes /</span>
            <input
              id="ni-folder"
              aria-label="Folder to import into"
              className="ni-input ni-folder"
              list="ni-folder-list"
              value={folder ?? state.defaultFolder}
              placeholder="Folder name"
              onChange={(e) => setFolder(e.target.value)}
              disabled={running}
              data-testid="ni-folder"
            />
            <datalist id="ni-folder-list">
              {(folders ?? []).map((f) => <option key={f} value={f} />)}
            </datalist>
          </div>
        </div>
        <div className="ni-row ni-row-top">
          <div className="ni-row-copy">
            <span className="ni-help">
              {before
                ? 'Brings in pages that are new or changed in Notion since the last import. Notes you edited in Walnut since are left as they are.'
                : 'Pages keep their tree, formatting, tables, databases, images and documents. Run it again later to bring in only what changed.'}
            </span>
            <details className="ni-details" data-testid="ni-conversions">
              <summary>What changes on the way in, and when you import again</summary>
              <ul>
                <li>A page with sub-pages becomes a folder holding a note of the same name; the folder opens that note.</li>
                <li>Two pages of the same title in one place become two notes, the second named "Title (2)", because two notes in one folder cannot share a name.</li>
                <li>Toggles become folded callouts, closed until you open them with their arrow. Equations are typeset.</li>
                <li>Columns come one after the other. Embeds and bookmarks become links.</li>
                <li>Images, PDFs and Office documents are saved beside the note. Other files (a zip, a video, audio) stay in Notion, and the note links to each one there.</li>
                <li>Databases become a note with a table of their rows; each row is its own note.</li>
              </ul>
              <span className="ni-details-head">When you import again</span>
              <ul data-testid="ni-reimport-rules">
                <li>Only pages that changed in Notion come in again; the rest are left as they are.</li>
                <li>A note you edited in Walnut is never written over. If its page changed in Notion too, yours stays; you can compare the two and take Notion's version, with yours kept beside it.</li>
                <li>A page deleted in Notion keeps its note. You choose whether to delete it from Walnut, and Undo brings it back.</li>
              </ul>
            </details>
            {organizing && <span className="ni-help" data-tone="warn" data-testid="ni-import-wait">Walnut is {organizing}. You can import once it is done.</span>}
            {problem && <span className="ni-help" data-tone="error" role="alert" data-testid="ni-import-error">{problem}</span>}
          </div>
          <div className="ni-row-actions">
            <button className="btn btn-primary" disabled={!canStart} onClick={() => void start()} data-testid="ni-import">
              {busy ? 'Starting…' : job?.phase === 'cancelled' && job.folder === target ? 'Carry on' : before ? 'Import changes' : 'Import'}
            </button>
          </div>
        </div>
      </div>
      {job && <RunCard job={job} store={store} openNote={props.openNote} quietFor={state.notion.quietFor} useView={useView} locked={!!organizing} otherFolder={!!target && target === settled && target !== job.folder} />}
    </section>
  )
}

/** A long list's tail, said: the run lists at most 100 of a kind. */
function More({ shown, total }: { shown: number; total: number }) {
  return total > shown ? <span className="ni-muted">and {(total - shown).toLocaleString()} more</span> : null
}

function RunCard({ job, store, openNote, quietFor, useView, locked, otherFolder }: { job: NonNullable<PublicState['job']>; store: ImportStore; openNote(path: string): void; quietFor?: number; useView: UseView; locked: boolean; otherFolder?: boolean }) {
  // Open stays open after going to a note and back.
  const [detailsOpen, setDetailsOpen] = useView<boolean>('detailsOpen', false)
  // The kept note whose "Use Notion's version" is waiting for a yes, and a refusal to show.
  const [taking, setTaking] = useState<string | null>(null)
  const [takeProblem, setTakeProblem] = useState<string | null>(null)
  // A kept note shown beside Notion's version of its page.
  const [comparing, setComparing] = useState<{ path: string; loading?: boolean; error?: string; mine?: string; theirs?: string } | null>(null)
  const compare = async (path: string) => {
    if (comparing?.path === path) { setComparing(null); return }
    setComparing({ path, loading: true })
    const outcome = await store.call<{ mine: string; theirs: string }>('notion_preview', { path })
    setComparing((now) => now?.path !== path ? now : outcome.ok ? { path, mine: outcome.result.mine, theirs: outcome.result.theirs } : { path, error: outcome.message })
  }
  // A gone note (or '*', all of them) whose Delete is waiting for a yes.
  const [removing, setRemoving] = useState<string | null>(null)
  const [goneProblem, setGoneProblem] = useState<string | null>(null)
  const removeGone = async (paths: string[]) => {
    setRemoving(null)
    setGoneProblem(null)
    const outcome = await store.call('import_remove_gone', { paths })
    if (!outcome.ok) setGoneProblem(outcome.message)
  }
  const bringBack = async (path: string) => {
    setGoneProblem(null)
    const outcome = await store.call('import_start', { folder: job.folder, rootIds: scopeIds(folderScope(store.get()?.history ?? [], job.folder)), bringBack: [path] })
    if (!outcome.ok) setGoneProblem(outcome.message)
  }
  const restoreGone = async () => {
    setGoneProblem(null)
    const outcome = await store.call('import_restore_gone')
    if (!outcome.ok) setGoneProblem(outcome.message)
  }
  const takeNotion = async (path: string) => {
    setTaking(null)
    setTakeProblem(null)
    const outcome = await store.call('import_start', { folder: job.folder, rootIds: scopeIds(folderScope(store.get()?.history ?? [], job.folder)), takeNotion: [path] })
    if (!outcome.ok) setTakeProblem(outcome.message)
  }
  const c = job.counts
  // A note's place inside the import folder, as the tree shows it.
  // A folder note (`Home/Home`) reads as its folder.
  const shortPath = (p: string) => (p.startsWith(`${job.folder}/`) ? p.slice(job.folder.length + 1) : p).replace(/\.md$/, '').replace(/(^|\/)([^/]+)\/\2$/, '$1$2')
  const stemOfNote = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const running = job.phase === 'discovering' || job.phase === 'importing'
  // The form above names another folder: this card is only the last run's line, labelled as such.
  const compact = !running && !!otherFolder
  const pct = c.found ? Math.min(100, Math.round((c.done / c.found) * 100)) : 0
  const stats: Array<[string, number, string?]> = [
    // A note brought back on request is no new page: it is counted apart.
    ['new', c.created - (job.restored?.length ?? 0)],
    ['brought back', job.restored?.length ?? 0],
    ['updated', c.updated],
    ['unchanged', c.unchanged],
    [(c.relinked ?? 0) === 1 ? 'note with links fixed' : 'notes with links fixed', c.relinked ?? 0],
    ['kept your edits', c.kept],
    ['you deleted, left out', c.deleted ?? 0],
    ['gone from Notion, kept', job.gonePaths?.length ?? 0],
    [c.files === 1 ? 'file' : 'files', c.files],
    [c.filesKeptInSource === 1 ? 'file left in Notion' : 'files left in Notion', c.filesKeptInSource],
    ['failed', c.failed, 'error'],
  ]
  const apart = job.namedApart ?? []
  let headline: string
  // Only some pages: the search goes through the whole workspace first, so its count is not theirs.
  if (job.phase === 'discovering') headline = job.scope === 'chosen' ? 'Looking through your workspace for the chosen pages…' : c.found ? `Finding pages… ${c.found.toLocaleString()} so far` : 'Finding pages…'
  else if (job.phase === 'importing') headline = `Importing ${c.done.toLocaleString()} of ${c.found.toLocaleString()} found so far`
  else if (job.phase === 'done') headline = c.failed ? `Imported, ${plural(c.failed, 'page')} failed` : c.created + c.updated + c.kept + (c.deleted ?? 0) + (job.gonePaths?.length ?? 0) === 0 && c.unchanged > 0 && !job.replaced?.length && !job.restored?.length ? (job.scope === 'chosen' ? 'The chosen pages are up to date' : 'Everything is up to date') : 'Imported'
  else if (job.phase === 'cancelled') headline = 'Stopped'
  else headline = 'The import stopped'

  return (
    <div className="ni-group ni-run" data-testid="ni-run" data-phase={job.phase} aria-live="polite">
      <div className="ni-row ni-row-top">
        <div className="ni-row-copy">
          <span className="ni-run-title" data-testid="ni-run-headline">{headline}</span>
          <span className="ni-help" data-testid="ni-run-where">
            {compact ? `The last import, into ${inNotes(job.folder)}, not the folder above` : inNotes(job.folder)}{job.endedAt ? ` · ${pointWords(job.endedAt)}` : ` · started ${pointWords(job.startedAt)}`}
          </span>
          {running && (
            <>
              <div className="ni-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.phase === 'importing' ? pct : undefined}>
                <div className="ni-bar-fill" data-indeterminate={job.phase === 'discovering' ? 'true' : undefined} style={{ width: job.phase === 'importing' ? `${pct}%` : undefined }} />
              </div>
              {job.current && <span className="ni-muted ni-current" data-testid="ni-current">{job.current}</span>}
              {quietFor ? (
                <span className="ni-help" data-tone="warn" data-testid="ni-quiet">
                  Notion has not answered for {quietFor} s. Walnut keeps trying; Stop is safe, and Import carries on later.
                </span>
              ) : null}
            </>
          )}
          {job.error && <span className="ni-help" data-tone="error" role="alert" data-testid="ni-run-error">{job.error}</span>}
          {!compact && !running && apart.length === 1 && (
            <span className="ni-help" data-testid="ni-named-apart">
              A note named <button className="btn btn-link ni-link" onClick={() => openNote(apart[0].beside)}>{stemOfNote(apart[0].beside)}</button> was already there, so the page came in beside it as <button className="btn btn-link ni-link" onClick={() => openNote(apart[0].path)}>{stemOfNote(apart[0].path)}</button>. Yours is unchanged.
            </span>
          )}
          {!compact && !running && apart.length > 1 && (
            <span className="ni-help" data-testid="ni-named-apart">
              {plural(apart.length, 'page')} came in beside notes of yours with the same name, as "Name (2)"; yours are unchanged. They are listed under Details.
            </span>
          )}
          {!compact && !running && (job.removedPaths?.length ?? 0) > 0 && (
            <span className="ni-help" data-testid="ni-gone-removed">
              Deleted {job.removedPaths!.length === 1 ? stemOfNote(job.removedPaths![0]) : plural(job.removedPaths!.length, 'note')} from Walnut.{' '}
              <button className="btn btn-link ni-link" onClick={() => void restoreGone()} disabled={locked} data-testid="ni-gone-undo">Undo</button>
            </span>
          )}
          {!compact && !running && (job.restored ?? []).map((p) => (
            <span key={p} className="ni-help" data-testid="ni-restored">
              Brought back <button className="btn btn-link ni-link" onClick={() => openNote(p)}>{stemOfNote(p)}</button>.
            </span>
          ))}
          {!compact && !running && (job.replaced ?? []).map((r) => (
            <span key={r.path} className="ni-help" data-testid="ni-replaced">
              <button className="btn btn-link ni-link" onClick={() => openNote(r.path)}>{stemOfNote(r.path)}</button> now has Notion's version; your edits are in <button className="btn btn-link ni-link" onClick={() => openNote(r.copy)}>{stemOfNote(r.copy)}</button>.
            </span>
          ))}
          {!compact && job.phase === 'cancelled' && <span className="ni-help">Press Carry on to finish it: what came in is kept, and the rest follows.</span>}
          {(job.phase !== 'discovering') && (
            <div className="ni-stats" data-testid="ni-stats">
              {stats.filter(([, n]) => n > 0 || !running).filter(([label, n]) => n > 0 || (label === 'new' && stats.every(([, m]) => m === 0))).map(([label, n, tone]) => (
                <span key={label} className="ni-stat" data-tone={n > 0 ? tone : undefined}><b>{n.toLocaleString()}</b> {label}</span>
              ))}
            </div>
          )}
        </div>
        <div className="ni-row-actions">
          {running && <button className="btn" onClick={() => void store.call('import_cancel')} data-testid="ni-stop">Stop</button>}
          {!running && job.firstPath && <button className="btn" onClick={() => openNote(job.firstPath!)} data-testid="ni-open-notes">Open in Notes</button>}
        </div>
      </div>
      {!running && !compact && (job.errors.length > 0 || job.keptPaths.length > 0 || (job.deletedPaths?.length ?? 0) > 0 || (!job.first && (job.newPaths ?? []).some((p) => !job.restored?.includes(p))) || (job.updatedPaths?.length ?? 0) > 0 || apart.length > 1 || (job.gonePaths?.length ?? 0) > 0 || job.warnings.length > 0 || c.filesKeptInSource > 0) && (
        <details className="ni-details" data-testid="ni-run-details" open={detailsOpen} onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Details</summary>
          {job.errors.length > 0 && (
            <div className="ni-detail-group">
              <b>Failed ({job.errors.length})</b>
              <ul>{job.errors.map((e, i) => <li key={i}>{e.title}: {e.message}</li>)}</ul>
            </div>
          )}
          {job.keptPaths.length > 0 && (
            <div className="ni-detail-group">
              <b>Changed in Notion, but you edited them in Walnut, so they were kept ({c.kept})</b>
              <ul>{job.keptPaths.map((p) => (
                <li key={p}>
                  <button className="btn btn-link ni-link" onClick={() => openNote(p)}>{shortPath(p)}</button>
                  <span className="ni-acts">
                  <button className="btn btn-sm" onClick={() => void compare(p)} data-testid="ni-compare">{comparing?.path === p ? 'Hide the comparison' : 'Compare with Notion'}</button>
                  {job.keptUrls?.[p] && <a className="btn btn-sm" href={job.keptUrls[p]} target="_blank" rel="noreferrer">Open in Notion</a>}
                  {taking !== p && <button className="btn btn-sm" onClick={() => setTaking(p)} disabled={locked} data-testid="ni-take-notion">Use Notion's version</button>}
                  </span>
                  {taking === p && (
                    <span className="ni-confirm-inline">
                      Replace it with Notion's version? Yours is kept beside it as "{stemOfNote(p)} (your edit)".{' '}
                      <span className="ni-acts">
                        <button className="btn btn-sm" onClick={() => setTaking(null)}>Cancel</button>
                        <button className="btn btn-sm btn-primary" onClick={() => void takeNotion(p)} disabled={locked} data-testid="ni-take-notion-yes">Replace</button>
                      </span>
                    </span>
                  )}
                  {comparing?.path === p && (
                    <div className="ni-compare" data-testid="ni-compare-view">
                      {comparing.loading ? <span className="ni-muted">Reading Notion's version…</span> : comparing.error ? <span className="ni-help" data-tone="error">{comparing.error}</span> : (
                        <CompareView mine={comparing.mine ?? ''} notion={comparing.theirs ?? ''} />
                      )}
                    </div>
                  )}
                </li>
              ))}</ul>
              <More shown={job.keptPaths.length} total={c.kept} />
              {takeProblem && <span className="ni-help" data-tone="error" role="alert">{takeProblem}</span>}
            </div>
          )}
          {apart.length > 1 && (
            <div className="ni-detail-group">
              <b>Named apart from your notes ({apart.length})</b>
              <ul>{apart.map((a) => (
                <li key={a.path}>
                  <button className="btn btn-link ni-link" onClick={() => openNote(a.path)}>{shortPath(a.path)}</button> · beside your <button className="btn btn-link ni-link" onClick={() => openNote(a.beside)}>{stemOfNote(a.beside)}</button>
                </li>
              ))}</ul>
            </div>
          )}
          {!job.first && (job.newPaths ?? []).some((p) => !job.restored?.includes(p)) && (
            <div className="ni-detail-group">
              <b>New since the last import ({c.created - (job.restored?.length ?? 0)})</b>
              <ul>{job.newPaths!.filter((p) => !job.restored?.includes(p)).map((p) => <li key={p}><button className="btn btn-link ni-link" onClick={() => openNote(p)}>{shortPath(p)}</button></li>)}</ul>
              <More shown={job.newPaths!.length} total={c.created} />
            </div>
          )}
          {(job.updatedPaths?.length ?? 0) > 0 && (
            <div className="ni-detail-group" data-testid="ni-updated">
              <b>Updated from Notion ({c.updated})</b>
              <ul>{job.updatedPaths!.map((p) => <li key={p}><button className="btn btn-link ni-link" onClick={() => openNote(p)}>{shortPath(p)}</button></li>)}</ul>
              <More shown={job.updatedPaths!.length} total={c.updated} />
            </div>
          )}
          {(job.gonePaths?.length ?? 0) > 0 && (
            <div className="ni-detail-group" data-testid="ni-gone">
              <b>No longer in Notion, so they stay here as they are</b>
              <span className="ni-muted">Deleted in Notion or no longer shared with the connection. Keep them, or delete the ones you do not want.</span>
              <ul>{job.gonePaths!.map((p) => (
                <li key={p}>
                  <button className="btn btn-link ni-link" onClick={() => openNote(p)}>{shortPath(p)}</button>
                  {removing === p ? (
                    <span className="ni-confirm-inline">
                      {job.goneEdited?.includes(p) ? 'You edited this note in Walnut. Delete it, your edits too?' : 'Delete this note from Walnut?'}
                      <span className="ni-acts">
                        <button className="btn btn-sm" onClick={() => setRemoving(null)}>Cancel</button>
                        <button className="btn btn-sm btn-danger" onClick={() => void removeGone([p])} disabled={locked} data-testid="ni-gone-delete-yes">Delete</button>
                      </span>
                    </span>
                  ) : (
                    <span className="ni-acts">
                      {job.goneEdited?.includes(p) && <span className="ni-muted" data-testid="ni-gone-edited">has your edits</span>}
                      <button className="btn btn-sm btn-danger" onClick={() => setRemoving(p)} disabled={locked} data-testid="ni-gone-delete">Delete from Walnut</button>
                    </span>
                  )}
                </li>
              ))}</ul>
              {job.gonePaths!.length > 1 && (removing === '*' ? (
                <span className="ni-confirm-inline">
                  Delete {job.gonePaths!.length === 2 ? 'both' : `all ${job.gonePaths!.length}`} from Walnut?{(job.goneEdited?.length ?? 0) > 0 ? ` ${job.goneEdited!.length === 1 ? 'One has' : `${job.goneEdited!.length} have`} your edits.` : ''}
                  <span className="ni-acts">
                    <button className="btn btn-sm" onClick={() => setRemoving(null)}>Cancel</button>
                    <button className="btn btn-sm btn-danger" onClick={() => void removeGone(job.gonePaths!)} disabled={locked} data-testid="ni-gone-delete-all-yes">Delete all</button>
                  </span>
                </span>
              ) : (
                <span className="ni-list-actions"><button className="btn btn-sm btn-danger" onClick={() => setRemoving('*')} disabled={locked} data-testid="ni-gone-delete-all">Delete {job.gonePaths!.length === 2 ? 'both' : `all ${job.gonePaths!.length}`} from Walnut</button></span>
              ))}
            </div>
          )}
          {goneProblem && <span className="ni-help" data-tone="error" role="alert">{goneProblem}</span>}
          {(job.deletedPaths?.length ?? 0) > 0 && (
            <div className="ni-detail-group" data-testid="ni-deleted">
              <b>You deleted these in Walnut, so they were left out</b>
              <span className="ni-muted">Each stays out until its page changes in Notion, or until you press Bring back.</span>
              <ul>{job.deletedPaths!.map((p) => (
                <li key={p}>
                  {shortPath(p)}
                  <span className="ni-acts"><button className="btn btn-sm" onClick={() => void bringBack(p)} disabled={locked} data-testid="ni-bring-back">Bring back</button></span>
                </li>
              ))}</ul>
            </div>
          )}
          {c.filesKeptInSource > 0 && (
            <div className="ni-detail-group">
              <b>{plural(c.filesKeptInSource, 'file')} stayed in Notion</b>
              <span className="ni-muted">Videos, audio and other file types notes do not keep are linked back to their place in Notion, from the note they were in.</span>
              {(job.filesInSource?.length ?? 0) > 0 && (
                <ul>{job.filesInSource!.map((f, i) => <li key={i}>{f.name}, in <button className="btn btn-link ni-link" onClick={() => openNote(f.note)}>{f.note.replace(/\.md$/, '').split('/').pop()}</button></li>)}</ul>
              )}
            </div>
          )}
          {job.warnings.length > 0 && (
            <div className="ni-detail-group">
              <b>Notes</b>
              <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </details>
      )}
    </div>
  )
}

/** What an organize run is doing, while it holds the notes; null when it is not running. */
export function organizingWords(phase: PublicState['organize']['phase']): string | null {
  if (phase === 'planning') return 'making an organize plan'
  if (phase === 'applying') return 'applying an organize plan'
  if (phase === 'undoing') return 'undoing an organize run'
  return null
}

/** The person's note against Notion's version in one column: their lines red, Notion's green, shared runs folded. */
function CompareView({ mine, notion }: { mine: string; notion: string }) {
  const diff = diffNoteLines(mine, notion)
  if (!diff.mine && !diff.notion) return <span className="ni-muted">The two versions have the same text; only spacing or blank lines differ.</span>
  return (
    <>
      <div className="ni-compare-key">
        <span className="ni-diff-chip" data-side="mine">− {diff.mine} {diff.mine === 1 ? 'line' : 'lines'} only in yours</span>
        <span className="ni-diff-chip" data-side="notion">+ {diff.notion} {diff.notion === 1 ? 'line' : 'lines'} only in Notion's</span>
      </div>
      <pre className="ni-diff" data-testid="ni-compare-diff">{diff.rows.map((row, i) => row.kind === 'fold'
        ? <span key={i} className="ni-diff-line" data-side="fold">… {row.count} {row.count === 1 ? 'line' : 'lines'} the same</span>
        : <span key={i} className="ni-diff-line" data-side={row.kind}><span className="ni-diff-mark" aria-hidden="true">{row.kind === 'mine' ? '−' : row.kind === 'notion' ? '+' : ' '}</span>{row.text || ' '}</span>)}</pre>
    </>
  )
}
