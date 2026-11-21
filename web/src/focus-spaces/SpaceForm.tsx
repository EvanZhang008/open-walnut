/**
 * Make or change a focus space: a name, the projects in it, and single tasks found by their
 * title. A space only names them: every task stays where it lives, so Main and every lead still
 * see it.
 */
import { useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { isHiddenFromTaskLists } from '@open-walnut/org-tree'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { useProjectRegistry } from '@/hooks/useProjectRegistry'
import { taskUserState } from '@/utils/session-status'
import { createFocusSpace, deleteFocusSpace, enterFocus, updateFocusSpace, type FocusSpace } from './focus-store'

const NO_TASKS: readonly Task[] = []
const MAX_MATCHES = 6

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectNames = useMemo(() => ['Inbox', ...registry.projectNames.filter((p) => p.toLowerCase() !== 'inbox')], [registry.projectNames])
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

  const save = async (enter: boolean) => {
    if (busy || empty) return
    setBusy(true)
    setError(null)
    try {
      const input = { name: name.trim() || 'Focus', projects, tasks: picked }
      const saved = space ? await updateFocusSpace(space.id, input) : await createFocusSpace(input)
      if (enter) await enterFocus({ spaceId: saved.id, ...(length ? { until: Date.now() + length * 60_000 } : {}) })
      onDone(enter)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!space || busy) return
    setBusy(true)
    try { await deleteFocusSpace(space.id); onDone(false) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  return (
    <form className="focus-panel focus-form" data-testid="focus-space-form" onSubmit={(e) => { e.preventDefault(); void save(true) }}>
      <div className="focus-panel-title">{space ? `Edit ${space.name}` : 'New focus space'}</div>
      <label className="focus-form-field">
        <span className="focus-panel-caption">Name</span>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Interview prep" maxLength={60} autoFocus data-no-draft="rename" data-testid="focus-form-name" />
      </label>
      <div className="focus-panel-caption">Projects</div>
      <div className="focus-form-projects" role="group" aria-label="Projects">
        {projectNames.map((p) => (
          <label key={p} className="focus-form-check">
            <input type="checkbox" checked={projects.includes(p)} onChange={() => toggleProject(p)} />
            <span>{p}</span>
          </label>
        ))}
      </div>
      <label className="focus-form-field">
        <span className="focus-panel-caption">Tasks (their subtasks come along)</span>
        <input value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Find a task by its title" data-no-draft="search" data-testid="focus-form-task-search" />
      </label>
      {matches.length > 0 && (
        <div className="focus-space-list" role="list" aria-label="Matching tasks">
          {matches.map((t) => (
            <div key={t.id} className="focus-space-row" role="listitem">
              <button type="button" className="focus-space-enter" onClick={() => { setPicked((l) => [...l, t.id]); setQuery('') }}>
                <span className="focus-space-name">{t.title}</span>
                <span className="focus-space-scope">{t.project || 'Inbox'}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <div className="focus-space-list" role="list" aria-label="Tasks in this space">
          {picked.map((id) => (
            <div key={id} className="focus-space-row" role="listitem">
              <span className="focus-space-picked">{byId.get(id)?.title ?? id}</span>
              <button type="button" className="btn btn-sm" onClick={() => setPicked((l) => l.filter((x) => x !== id))} aria-label={`Remove ${byId.get(id)?.title ?? id}`}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {empty && <div className="focus-panel-empty">Pick at least one project or task.</div>}
      {error && <div className="focus-panel-error" role="alert">{error}</div>}
      <div className="focus-panel-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || empty} data-testid="focus-form-enter">{space ? 'Save and enter' : 'Make and enter'}</button>
        <button type="button" className="btn btn-sm" disabled={busy || empty} onClick={() => void save(false)} data-testid="focus-form-save">Save</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
        {space && <button type="button" className="btn btn-sm focus-form-delete" disabled={busy} onClick={() => void remove()}>Delete</button>}
      </div>
    </form>
  )
}
