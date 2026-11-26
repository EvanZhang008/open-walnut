/**
 * The Import notes page: the source (Notion: connect it, or its connection), what to import
 * and where with the run under it, and Organize with Walnut. One column, three blocks.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { ConnectedRow, ConnectSteps } from './connect'
import { ImportPanel, organizingWords } from './import-panel'
import { OrganizePanel } from './organize-panel'
import type { ImportStore, PublicState } from './store'
import { inNotes } from './words'
import { folderScope, scopeIds } from './folder-scope'

type Setter<T> = (next: T | ((prev: T) => T)) => void

export function ImportApp(props: AppProps & { walnut: WalnutWebApi; store: ImportStore }) {
  const { walnut, store } = props
  const state = useSyncExternalStore(store.subscribe, store.get)
  const loadError = useSyncExternalStore(store.subscribe, store.loadError)

  useEffect(() => { void store.refresh() }, [store])

  // The import form's folder setter, for a folder's own Import changes below it.
  const pickFolder = useRef<((folder: string) => void) | null>(null)
  // A view choice survives leaving the page (walnut.ui.useView); an older host keeps it in memory.
  function useView<T>(name: string, initial: T): [T, Setter<T>] {
    const fallback = useState<T>(initial)
    const kept = walnut.ui.useView?.<T>(name, initial)
    return kept ?? fallback
  }

  const openNote = (path: string) => props.navigate(`/notes?path=${encodeURIComponent(path)}`)

  return (
    <div className="ni-root" data-testid="ni-app">
      <header>
        <h1 className="page-title">Import notes</h1>
        <p className="ni-lede">Bring your pages in from Notion as Walnut notes. Run it again any time to bring in only what changed.</p>
      </header>
      {!state && !loadError && <p className="ni-muted">Loading…</p>}
      {loadError && <p className="ni-help" data-tone="error" role="alert">{loadError}</p>}
      {state && (
        <>
          {state.replica && <p className="ni-help" data-tone="warn">Imports run on your main Walnut. Open it there to import.</p>}
          <section className="ni-block" aria-labelledby="ni-source-head">
            <div className="ni-block-head"><h2 id="ni-source-head">Notion</h2></div>
            {state.notion.connected ? <ConnectedRow state={state} store={store} /> : <ConnectSteps store={store} />}
          </section>
          {state.notion.connected && <ImportPanel walnut={walnut} store={store} state={state} useView={useView} openNote={openNote} onPickFolder={(set) => { pickFolder.current = set }} />}
          {state.history.length > 0 && <PastImports history={state.history} connected={state.notion.connected} lastFolder={state.job?.folder} navigate={props.navigate} store={store} running={state.job?.phase === 'discovering' || state.job?.phase === 'importing' || !!organizingWords(state.organize.phase)} pickFolder={(folder) => pickFolder.current?.(folder)} rootTitles={new Map([...state.history.flatMap((run) => (run.rootIds ?? []).map((id, i): [string, string] => [id, run.rootTitles?.[i] ?? ''])).filter(([, t]) => t), ...(state.notion.access?.roots ?? []).map((r): [string, string] => [r.id, r.title])])} />}
          {(state.notion.connected || state.history.length > 0) && <OrganizePanel store={store} state={state} useView={useView} openNote={openNote} />}
        </>
      )}
    </div>
  )
}

/**
 * Every folder earlier imports went into, since their notes stay: when disconnected, and when
 * connected with more than the folder of the last run (which its card already shows).
 */
function PastImports({ history, connected, lastFolder, navigate, store, running, pickFolder, rootTitles }: { history: PublicState['history']; connected: boolean; lastFolder?: string; navigate(to: string): void; store: ImportStore; running: boolean; pickFolder(folder: string): void; rootTitles: Map<string, string> }) {
  const [problem, setProblem] = useState<string | null>(null)
  const byFolder = new Map<string, { at: string; open: string | null; rootIds?: string[]; stopped: boolean }>()
  for (const run of history) {
    // Every finished run counts, one that found only pages gone from Notion too; a stopped one only once it brought something in.
    if (run.phase === 'failed' || (run.phase !== 'done' && run.counts.created + run.counts.updated + run.counts.unchanged === 0)) continue
    const seen = byFolder.get(run.folder)
    if (!seen) byFolder.set(run.folder, { at: run.at, open: run.firstPath ?? null, rootIds: run.rootIds, stopped: run.phase === 'cancelled' })
    else if (!seen.open && run.firstPath) seen.open = run.firstPath
  }
  const folders = [...byFolder.keys()]
  if (!folders.length || (connected && folders.every((f) => f === lastFolder))) return null
  return (
    <section className="ni-block" aria-labelledby="ni-past-head">
      <div className="ni-block-head"><h2 id="ni-past-head">Imported notes</h2></div>
      <span className="ni-help ni-block-help">
        {connected ? 'Each folder updates on its own: import into it again to bring in what changed in Notion.' : 'They stay in your notes. Connect again to bring in what changed in Notion.'}
      </span>
      <div className="ni-group" data-testid="ni-past">
        {folders.map((folder) => (
          <div className="ni-row" key={folder}>
            <div className="ni-row-copy">
              <span>{inNotes(folder)}</span>
              <span className="ni-help">{byFolder.get(folder)!.stopped ? 'Stopped part way' : 'Last imported'} {new Date(byFolder.get(folder)!.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {followsWords(folderScope(history, folder), rootTitles)}</span>
            </div>
            <div className="ni-row-actions">
              {connected && folder !== lastFolder && (
                <button
                  className="btn"
                  disabled={running}
                  aria-label={`Import changes into ${folder}`}
                  title="Brings in what changed in Notion, for the pages this folder was made from"
                  onClick={async () => {
                    setProblem(null)
                    // The form above shows this folder and the pages it follows, as the run does.
                    pickFolder(folder)
                    const outcome = await store.call('import_start', { folder, rootIds: scopeIds(folderScope(history, folder)) })
                    if (!outcome.ok) setProblem(outcome.message)
                    else window.scrollTo({ top: 0, behavior: 'smooth' })
                  }}
                  data-testid="ni-past-update"
                >Import changes</button>
              )}
              <button className="btn" aria-label={`Open ${folder} in Notes`} onClick={() => { const at = byFolder.get(folder)!.open; navigate(at ? `/notes?path=${encodeURIComponent(at)}` : '/notes') }}>Open in Notes</button>
            </div>
          </div>
        ))}
      </div>
      {problem && <span className="ni-help" data-tone="error" role="alert">{problem}</span>}
    </section>
  )
}

/** What a folder follows, as the person reads it: "Follows everything", "Follows Home and Journal". */
function followsWords(scope: ReturnType<typeof folderScope>, titles: Map<string, string>): string {
  if (!scope || scope.all) return 'Follows everything shared'
  const names = scope.rootIds.map((id) => titles.get(id)).filter((t): t is string => !!t)
  if (names.length !== scope.rootIds.length) return `Follows ${scope.rootIds.length === 1 ? '1 top-level page' : `${scope.rootIds.length} top-level pages`}`
  return `Follows ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`
}
