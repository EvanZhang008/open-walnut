import { LoadingState, UnavailableState } from '@/components/common/EmptyState'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { projectIdentity } from '@/utils/project-display'
import {
  matchesTaskQuery,
  type TaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query'
import { useTasksContext } from '@/contexts/TasksContext'
import { useUndoableTaskActions } from '@/undo/TaskUndoContext'
import { useFavorites } from '@/hooks/useFavorites'
import { useOrdering } from '@/hooks/useOrdering'
import { useProjectRegistry } from '@/hooks/useProjectRegistry'
import { TasksPageTable } from './TasksPageTable'
import { buildTaskQueryContext } from './task-query-state'
import { useNormalizedTaskQuery } from './useNormalizedTaskQuery'
import type { TpSort } from './tasks-page-sort'
import type { TaskViewProps } from '@/plugins/types'
import '@/styles/tasks-page.css'
import { Chip } from '@/components/controls'
import { MicInput } from '@/components/common/BoxMic'

// The plugin contract's onOpenTask is not taken: a row opens on Home (TasksPageTable, useOpenTask).
interface TaskViewSurfaceProps extends Omit<TaskViewProps, 'storageKey' | 'onOpenTask'> {
  persistenceKey?: string
}

function storageKey(prefix: string | undefined, suffix: string): string | undefined {
  return prefix ? `${prefix}:${suffix}` : undefined
}

function readSort(key: string | undefined, fallback: TpSort | null): TpSort | null {
  if (!key) return fallback
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as TpSort | null
    if (value && typeof value.key === 'string' && (value.dir === 'asc' || value.dir === 'desc')) return value
  } catch { /* ignore invalid persisted state */ }
  return fallback
}

function readGrouped(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch { return fallback }
}

function readCollapsed(key: string | undefined): Set<string> {
  if (!key) return new Set()
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return new Set(value)
  } catch { /* ignore invalid persisted state */ }
  return new Set()
}

export function TaskViewSurface({
  project,
  query = {},
  search = '',
  sort: initialSort,
  grouped: initialGrouped = false,
  toolbar = false,
  persistenceKey,
}: TaskViewSurfaceProps) {
  const { tasks, loading, error, refetch, create, update } = useTasksContext()
  const { toggleComplete, deleteTask } = useUndoableTaskActions()
  const { projectOrder } = useOrdering()
  const { sourceByName, favoriteByName, refresh: refreshRegistry } = useProjectRegistry()
  const { toggleFavoriteProject } = useFavorites()
  const sortKey = storageKey(persistenceKey, 'sort')
  const groupedKey = storageKey(persistenceKey, 'grouped')
  const collapsedKey = storageKey(persistenceKey, 'collapsed')
  const [currentSort, setCurrentSort] = useState<TpSort | null>(() => readSort(sortKey, initialSort ?? null))
  const [currentGrouped, setCurrentGrouped] = useState(() => readGrouped(groupedKey, initialGrouped))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(collapsedKey))
  const [localSearch, setLocalSearch] = useState(search)
  const activeProject = project ?? null

  useEffect(() => {
    if (initialSort !== undefined) setCurrentSort(initialSort)
  }, [initialSort?.key, initialSort?.dir])

  useEffect(() => { setCurrentGrouped(initialGrouped) }, [initialGrouped])
  useEffect(() => { setLocalSearch(search) }, [search])
  // The query against the clock, read again when the clock moves a task across a relative window's
  // edge or the list changes, never once a minute for the whole view (useNormalizedTaskQuery).
  const normalized = useNormalizedTaskQuery(tasks, query as TaskQuery)
  const queryContext = useMemo<TaskQueryContext>(
    () => buildTaskQueryContext(tasks, query.blocked !== undefined),
    [tasks, query.blocked],
  )
  const filtered = useMemo(() => {
    const projectKey = activeProject === null ? undefined : projectIdentity(activeProject)
    const needle = localSearch.trim().toLowerCase()
    return tasks.filter((task: Task) => {
      if (projectKey !== undefined && projectIdentity(task.project) !== projectKey) return false
      if (normalized && !matchesTaskQuery(task, normalized, queryContext)) return false
      if (needle && !task.title.toLowerCase().includes(needle)
        && !(task.project ?? '').toLowerCase().includes(needle)) return false
      return true
    })
  }, [tasks, activeProject, normalized, queryContext, localSearch])

  const handleSortChange = useCallback((next: TpSort | null) => {
    setCurrentSort(next)
    if (!sortKey) return
    try {
      if (next) localStorage.setItem(sortKey, JSON.stringify(next))
      else localStorage.removeItem(sortKey)
    } catch { /* localStorage unavailable */ }
  }, [sortKey])

  const handleToggleGroup = useCallback((group: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      try { if (collapsedKey) localStorage.setItem(collapsedKey, JSON.stringify([...next])) } catch { /* unavailable */ }
      return next
    })
  }, [collapsedKey])

  const handleGroupedChange = useCallback(() => {
    setCurrentGrouped((current) => {
      const next = !current
      try { if (groupedKey) localStorage.setItem(groupedKey, next ? '1' : '0') } catch { /* unavailable */ }
      return next
    })
  }, [groupedKey])

  const handleCreate = useCallback(async (title: string, rowProject?: string) => {
    const target = rowProject !== undefined ? rowProject : (activeProject ?? '')
    await create({ title, priority: 'none', project: target || undefined })
  }, [activeProject, create])

  const handleToggleFavorite = useCallback((name: string) => {
    void toggleFavoriteProject(name).then(refreshRegistry).catch(() => undefined)
  }, [refreshRegistry, toggleFavoriteProject])

  if (loading) return <div className="plugin-task-view"><LoadingState size="pane" title="Loading tasks…" /></div>
  if (error) return <div className="plugin-task-view"><UnavailableState size="pane" title="Couldn't load tasks" detail={error} onRetry={refetch} /></div>

  return (
    <div className="plugin-task-view" data-testid="plugin-task-view">
      {toolbar && (
        <div className="plugin-task-view-toolbar">
          <strong>{filtered.length} task{filtered.length === 1 ? '' : 's'}</strong>
          {activeProject === null && (
            <Chip className="tp-chip" pressed={currentGrouped} onClick={handleGroupedChange}>
              Group
            </Chip>
          )}
          <MicInput fieldClassName="plugin-task-search" data-no-draft="search"
            type="search"
            aria-label="Filter Plugin tasks"
            placeholder="Filter tasks…"
            value={localSearch}
            setText={setLocalSearch}
          />
        </div>
      )}
      <TasksPageTable
        tasks={filtered}
        activeProject={activeProject}
        sourceByName={sourceByName}
        onToggleComplete={toggleComplete}
        onDelete={deleteTask}
        onCreate={handleCreate}
        onUpdate={update}
        favoriteByName={favoriteByName}
        onToggleFavorite={handleToggleFavorite}
        onProjectChanged={() => refreshRegistry()}
        sort={currentSort}
        onSortChange={handleSortChange}
        grouped={activeProject === null && currentGrouped}
        collapsed={collapsed}
        onToggleGroup={handleToggleGroup}
        projectOrder={projectOrder}
      />
    </div>
  )
}
