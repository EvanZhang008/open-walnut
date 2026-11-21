/**
 * Make or change a focus space: a name, the projects in it, and single tasks found by their
 * title. A space only names them: every task stays where it lives, so Main and every lead still
 * see it. Projects and tasks are the card family's ticks (`.org-answer-check`), the picked ones
 * first and edged in blue.
 */
import { useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { isHiddenFromTaskLists } from '@open-walnut/org-tree'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { useProjectRegistry } from '@/hooks/useProjectRegistry'
import { taskUserState } from '@/utils/session-status'
import { createFocusSpace, deleteFocusSpace, enterFocus, updateFocusSpace, useFocusSnapshot, type FocusAppMode, type FocusSpace } from './focus-store'
import { focusAppMode } from '@open-walnut/focus-scope'

const NO_TASKS: readonly Task[] = []
const MAX_MATCHES = 6
/** More projects than this: a box to find one by name. */
const PROJECT_FIND_AT = 8

function Tick({ on, label, detail, onToggle, testId }: { on: boolean; label: string; detail?: string; onToggle(): void; testId?: string }) {
  return (
    <label className={`org-answer-check${on ? ' is-on' : ''}`} title={detail} {...(testId ? { 'data-testid': testId } : {})}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span className="focus-tick-text">
        <span className="focus-tick-label">{label}</span>
        {detail && <span className="focus-tick-detail">{detail}</span>}
      </span>
    </label>
  )
}

export function SpaceForm({ space, length, onDone }: {
  space?: FocusSpace
  /** The length picked for entering (minutes; null = until left). */
  length: number | null
  /** `entered`: the person also went into it. */
  onDone(entered: boolean): void
}) {
  const registry = useProjectRegistry()
  const tasks = useTaskListSelect(({ tasks: list }) => list) ?? NO_TASKS
  const [name, setName] = useState(space?.name ?? '')
  const [projects, setProjects] = useState<string[]>(space?.projects ?? [])
  const [picked, setPicked] = useState<string[]>(space?.tasks ?? [])
  const [query, setQuery] = useState('')
  const [projectQuery, setProjectQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { apps } = useFocusSnapshot()
  // Per app: what the person set here (absent = what its manifest declares, focusAppMode).
  const [appModes, setAppModes] = useState<Record<string, FocusAppMode>>(space?.apps ?? {})

  // The picked projects first, so a long list never hides what is in the space.
  const projectNames = useMemo(() => {
    const all = ['Inbox', ...registry.projectNames.filter((p) => p.toLowerCase() !== 'inbox')]
    const chosen = new Set(projects.map((p) => p.toLowerCase()))
    return [...all.filter((p) => chosen.has(p.toLowerCase())), ...all.filter((p) => !chosen.has(p.toLowerCase()))]
    // Ordered when the form opens and as the registry loads, never under the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry.projectNames])
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return tasks
      .filter((t) => !isHiddenFromTaskLists(t) && taskUserState(t) !== 'done' && !picked.includes(t.id) && t.title.toLowerCase().includes(q))
      .slice(0, MAX_MATCHES)
  }, [tasks, query, picked])

  const empty = projects.length === 0 && picked.length === 0
  const toggleProject = (p: string) => setProjects((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]))
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  const save = async (enter: boolean) => {
    if (busy || empty) return
    setBusy(true)
    setError(null)
    try {
      const input = { name: name.trim() || 'Focus', projects, tasks: picked, apps: appModes }
      const saved = space ? await updateFocusSpace(space.id, input) : await createFocusSpace(input)
      if (enter) await enterFocus({ spaceId: saved.id, ...(length ? { until: Date.now() + length * 60_000 } : {}) })
      onDone(enter)
    } catch (err) { fail(err) } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!space || busy) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true)
    try { await deleteFocusSpace(space.id); onDone(false) } catch (err) { fail(err) } finally { setBusy(false) }
  }

  return (
    <form className="focus-panel focus-form" data-testid="focus-space-form" onSubmit={(e) => { e.preventDefault(); void save(true) }}>
      <div className="focus-panel-title">{space ? `Edit ${space.name}` : 'New focus space'}</div>
      <label className="focus-form-field">
        <span className="focus-panel-caption">Name</span>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Interview prep" maxLength={60} autoFocus data-no-draft="rename" data-testid="focus-form-name" />
      </label>
      <div className="focus-panel-caption">{`Projects (${projects.length} of ${projectNames.length} picked)`}</div>
      {projectNames.length > PROJECT_FIND_AT && (
        <input value={projectQuery} onChange={(e) => setProjectQuery(e.currentTarget.value)} placeholder="Find a project" aria-label="Find a project" data-no-draft="search" data-testid="focus-form-project-search" />
      )}
      <div className="focus-form-projects" role="group" aria-label="Projects">
        <div className="ask-card">
          <div className="ask-card-answer focus-ticks">
            {projectNames
              .filter((p) => projects.includes(p) || !projectQuery.trim() || p.toLowerCase().includes(projectQuery.trim().toLowerCase()))
              .map((p) => <Tick key={p} on={projects.includes(p)} label={p} onToggle={() => toggleProject(p)} />)}
          </div>
        </div>
      </div>
      <label className="focus-form-field">
        <span className="focus-panel-caption">Tasks (their subtasks come along)</span>
        <input value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Find a task by its title" data-no-draft="search" data-testid="focus-form-task-search" />
      </label>
      {(picked.length > 0 || matches.length > 0) && (
        <div className="ask-card"><div className="ask-card-answer focus-ticks" role="group" aria-label="Tasks">
          {picked.map((id) => (
            <Tick key={id} on label={byId.get(id)?.title ?? id} detail={byId.get(id)?.project || 'Inbox'} onToggle={() => setPicked((l) => l.filter((x) => x !== id))} />
          ))}
          {matches.map((t) => (
            <Tick key={t.id} on={false} label={t.title} detail={t.project || 'Inbox'} testId="focus-form-match"
              onToggle={() => { setPicked((l) => [...l, t.id]); setQuery('') }} />
          ))}
        </div></div>
      )}
      {apps.length > 0 && (
        <>
          <div className="focus-panel-caption">Apps in this space</div>
          <div className="ask-card"><div className="ask-card-answer focus-ticks" role="group" aria-label="Apps">
            {apps.map((a) => {
              const mode = focusAppMode(appModes[a.pluginId], a.declared)
              const shown = mode !== 'off'
              const detail = !shown ? 'Hidden here' : mode === 'inherit' ? 'Same as Main' : 'Starts fresh here'
              return (
                <Tick key={a.pluginId} on={shown} label={a.name} detail={detail} testId={`focus-form-app-${a.pluginId}`}
                  // Shown: a fresh one when the app can keep a state per space, else Main's.
                  onToggle={() => setAppModes((m) => ({ ...m, [a.pluginId]: shown ? 'off' : a.declared === 'scoped' ? 'isolated' : 'inherit' }))} />
              )
            })}
          </div></div>
        </>
      )}
      {empty && <div className="focus-panel-empty">Pick at least one project or task.</div>}
      {error && <div className="focus-panel-error" role="alert">{error}</div>}
      <div className="ask-card-answer focus-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || empty} data-testid="focus-form-enter">{space ? 'Save and enter' : 'Make and enter'}</button>
        <button type="button" className="btn btn-sm" disabled={busy || empty} onClick={() => void save(false)} data-testid="focus-form-save">Save</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
        {space && (
          <button type="button" className="btn btn-sm focus-form-delete" disabled={busy} onClick={() => void remove()}
            aria-label={confirmDelete ? `Delete ${space.name} for good` : `Delete ${space.name}`}>
            {confirmDelete ? 'Delete for good?' : 'Delete'}
          </button>
        )}
      </div>
    </form>
  )
}
