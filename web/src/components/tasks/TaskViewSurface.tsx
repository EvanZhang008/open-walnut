import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import {
  matchesTaskQuery,
  type NormalizedTaskQuery,
  type TaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query'
import { useTasksContext } from '@/contexts/TasksContext'
import { useFavorites } from '@/hooks/useFavorites'
import { useOrdering } from '@/hooks/useOrdering'
import { useProjectRegistry } from '@/hooks/useProjectRegistry'
import { visibleInterval } from '@/utils/page-visibility'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { TasksPageTable } from './TasksPageTable'
import { buildTaskQueryContext, safeNormalizeTaskQuery } from './task-query-state'
import type { TpSort } from './tasks-page-sort'
import type { TaskViewProps } from '@/plugins/types'
import '@/styles/tasks-page.css'

interface TaskViewSurfaceProps extends Omit<TaskViewProps, 'storageKey'> {
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
  onOpenTask,
}: TaskViewSurfaceProps) {
  const { tasks, loading, error, toggleComplete, create, deleteTask, update } = useTasksContext()
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
  const [minuteTick, setMinuteTick] = useState(0)
  const activeProject = project ?? null

  useEffect(() => {
    if (initialSort !== undefined) setCurrentSort(initialSort)
  }, [initialSort?.key, initialSort?.dir])

  useEffect(() => { setCurrentGrouped(initialGrouped) }, [initialGrouped])
  useEffect(() => { setLocalSearch(search) }, [search])
  useEffect(() => visibleInterval(() => setMinuteTick((value) => value + 1), 60_000), [])

  const timeTick = query.time ? minuteTick : 0
  const normalized = useMemo<NormalizedTaskQuery | null>(
    () => safeNormalizeTaskQuery(query as TaskQuery, new Date()),
    [query, timeTick],
  )
  const queryContext = useMemo<TaskQueryContext>(
    () => buildTaskQueryContext(tasks, query.blocked !== undefined),
    [tasks, query.blocked],
  )
  const filtered = useMemo(() => {
    const projectKey = activeProject?.toLowerCase()
    const needle = localSearch.trim().toLowerCase()
    return tasks.filter((task: Task) => {
      if (projectKey !== undefined && (task.project ?? '').toLowerCase() !== projectKey) return false
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

  if (loading) return <div className="plugin-task-view plugin-task-view-loading"><LoadingSpinner /></div>
  if (error) return <div className="plugin-task-view plugin-task-view-error">{error}</div>

  return (
    <div className="plugin-task-view" data-testid="plugin-task-view">
      {toolbar && (
        <div className="plugin-task-view-toolbar">
          <strong>{filtered.length} task{filtered.length === 1 ? '' : 's'}</strong>
          {activeProject === null && (
            <button type="button" className={`tp-chip${currentGrouped ? ' on' : ''}`} onClick={handleGroupedChange}>
              Group
            </button>
          )}
          <input
            type="search"
            aria-label="Filter Plugin tasks"
            placeholder="Filter tasks…"
            value={localSearch}
            onChange={(event) => setLocalSearch(event.target.value)}
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
        onOpenTask={onOpenTask}
      />
    </div>
  )
}
