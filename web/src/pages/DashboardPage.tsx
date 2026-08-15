import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTasksContext } from '@/contexts/TasksContext';
import { useOrdering } from '@/hooks/useOrdering';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { useFavorites } from '@/hooks/useFavorites';
import { createProject } from '@/api/projects';
import { TasksPageRail, type RailProjectItem } from '@/components/tasks/TasksPageRail';
import { TasksPageTable } from '@/components/tasks/TasksPageTable';
import { TaskForm, type TaskFormData } from '@/components/tasks/TaskForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { TpSort } from '@/components/tasks/tasks-page-sort';
import {
  ViewDropdown,
  DEFAULT_TASK_QUERY_FILTER_STATE,
  logTaskQueryChange,
  toTaskQuery,
  type TaskQueryFilterState,
} from '@/components/tasks/ViewDropdown';
import { TaskFilterChips } from '@/components/tasks/TaskFilterChips';
import {
  buildTaskQueryContext,
  deriveSourceOptions,
  deriveSprintOptions,
  safeNormalizeTaskQuery,
} from '@/components/tasks/task-query-state';
import {
  matchesTaskQuery,
  type NormalizedTaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query';
import type { Task } from '@open-walnut/core';
import { visibleInterval } from '@/utils/page-visibility';
import '@/styles/tasks-page.css';

const LS_SORT = 'walnut-tasks-page-sort';
const LS_GROUPED = 'walnut-tasks-page-grouped';
const LS_COLLAPSED = 'walnut-tasks-page-collapsed';

function readSort(): TpSort | null {
  try {
    const raw = localStorage.getItem(LS_SORT);
    if (!raw) return null;
    const v = JSON.parse(raw) as TpSort;
    if (v && typeof v.key === 'string' && (v.dir === 'asc' || v.dir === 'desc')) return v;
  } catch { /* ignore */ }
  return null;
}

function readGrouped(): boolean {
  try { return localStorage.getItem(LS_GROUPED) !== '0'; } catch { return true; }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

/** /tasks — dense two-pane workspace: project rail (left) + task table (right). */
export function DashboardPage() {
  const { tasks, loading, error, toggleComplete, create, deleteTask, update } = useTasksContext();
  const { projectOrder, reorderProjects } = useOrdering();
  const { projectNames, sourceByName, favoriteByName, refresh: refreshRegistry } = useProjectRegistry();
  const { toggleFavoriteProject } = useFavorites();

  // null = All Tasks, '' = Inbox, otherwise a project name. The rail NAVIGATES,
  // so it is deliberately not a query condition: the query panel's own `projects`
  // chips are the refinement, and mixing the two would make "clear all filters"
  // silently move the board off the project the user was looking at.
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  // The SAME canonical query state the home panel uses. Seeded with
  // completion: ['todo','in_progress'] to preserve this page's shipped default
  // (Todo on, Done off): hiding completed tasks is an explicit choice a surface
  // makes, never a rule buried inside the shared evaluator.
  const [query, setQuery] = useState<TaskQueryFilterState>(() => ({
    ...DEFAULT_TASK_QUERY_FILTER_STATE,
    completion: ['todo', 'in_progress'],
  }));

  const handleQueryChange = useCallback((next: TaskQueryFilterState) => {
    setQuery(next);
    logTaskQueryChange('tasks-page', next);
  }, []);

  // The two toolbar status chips map onto the completion dimension. An EMPTY
  // completion array means "no condition", i.e. show everything — so both chips
  // read as ON there, matching what the table actually shows.
  const noCompletionCondition = query.completion.length === 0;
  const showTodoChip = noCompletionCondition
    || query.completion.includes('todo') || query.completion.includes('in_progress');
  const showDoneChip = noCompletionCondition || query.completion.includes('complete');

  // Both chip handlers compute the next state with the CURRENT `query` rather
  // than a setQuery updater: logging is a side effect, and an updater callback
  // can run twice (StrictMode) or be replayed, which would double-log. They're
  // click handlers on a single state field, so there is no batching race to lose.
  const toggleCompletionChip = useCallback((which: 'todo' | 'done') => {
    const hadTodo = query.completion.length === 0
      || query.completion.includes('todo') || query.completion.includes('in_progress');
    const hadDone = query.completion.length === 0 || query.completion.includes('complete');
    let todo = which === 'todo' ? !hadTodo : hadTodo;
    let done = which === 'done' ? !hadDone : hadDone;
    // At least one side stays on — an empty status set would show nothing and
    // read as data loss (this page's long-standing rule).
    if (!todo && !done) { if (which === 'todo') done = true; else todo = true; }
    const completion: TaskQueryFilterState['completion'] = [];
    if (todo) completion.push('todo', 'in_progress');
    if (done) completion.push('complete');
    // Both on = no condition at all, so the chips stop showing up as filters.
    handleQueryChange({ ...query, completion: todo && done ? [] : completion });
  }, [query, handleQueryChange]);

  const togglePriorityChip = useCallback((value: 'immediate' | 'important') => {
    handleQueryChange({
      ...query,
      priorities: query.priorities.includes(value)
        ? query.priorities.filter((p) => p !== value)
        : [...query.priorities, value],
    });
  }, [query, handleQueryChange]);

  // ── table view state (persisted) ──
  const [sort, setSort] = useState<TpSort | null>(readSort);
  const [grouped, setGrouped] = useState(readGrouped);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const handleSortChange = useCallback((s: TpSort | null) => {
    setSort(s);
    try {
      if (s) localStorage.setItem(LS_SORT, JSON.stringify(s));
      else localStorage.removeItem(LS_SORT);
    } catch { /* ignore */ }
  }, []);

  const handleGroupedToggle = useCallback(() => {
    setGrouped((v) => {
      try { localStorage.setItem(LS_GROUPED, v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }, []);

  const persistCollapsed = (next: Set<string>) => {
    try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next])); } catch { /* ignore */ }
  };

  const handleToggleGroup = useCallback((project: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      persistCollapsed(next);
      return next;
    });
  }, []);

  // ── rail data: registry projects (incl. zero-task ones) ∪ task-derived names,
  //    ordered projectOrder-first then alphabetical. Inbox is separate/last. ──
  const openCountByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === 'done') continue;
      const key = (t.project || '').toLowerCase();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [tasks]);

  const railProjects = useMemo<RailProjectItem[]>(() => {
    // Union registry names with task-derived ones (case-insensitive; registry
    // spelling is canonical when both exist).
    const byLower = new Map<string, string>();
    for (const name of projectNames) byLower.set(name.toLowerCase(), name);
    for (const t of tasks) {
      const p = t.project || '';
      if (p && !byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
    }
    const names = Array.from(byLower.values());
    const orderIndex = new Map(projectOrder.map((name, i) => [name.toLowerCase(), i]));
    names.sort((a, b) => {
      const ai = orderIndex.get(a.toLowerCase());
      const bi = orderIndex.get(b.toLowerCase());
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b);
    });
    return names.map((name) => ({
      name,
      source: sourceByName.get(name.toLowerCase()),
      favorite: favoriteByName.has(name.toLowerCase()),
      openCount: openCountByProject.get(name.toLowerCase()) ?? 0,
    }));
  }, [projectNames, tasks, projectOrder, sourceByName, favoriteByName, openCountByProject]);

  const allOpenCount = useMemo(
    () => tasks.filter((t) => t.status !== 'done').length,
    [tasks],
  );

  // All projects currently visible in the grouped table ('' excluded) — the
  // Collapse-all target set and the reorder baseline.
  const visibleProjectKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const t of tasks) keys.add(t.project || '');
    return keys;
  }, [tasks]);

  // `every` is vacuously true on an empty set, so with ZERO tasks loaded the
  // toolbar claimed everything was collapsed and offered "Expand all" — clicking
  // it then wrote an empty set over the user's persisted per-project collapse
  // state. No visible groups means nothing is collapsed.
  const allGroupsCollapsed = useMemo(
    () => visibleProjectKeys.size > 0 && [...visibleProjectKeys].every((k) => collapsed.has(k)),
    [visibleProjectKeys, collapsed],
  );

  const handleCollapseExpandAll = useCallback(() => {
    setCollapsed(() => {
      const next = allGroupsCollapsed ? new Set<string>() : new Set(visibleProjectKeys);
      persistCollapsed(next);
      return next;
    });
  }, [allGroupsCollapsed, visibleProjectKeys]);

  // ── right pane data ──
  const inScope = useMemo(() => {
    if (activeProject === null) return tasks;
    const key = activeProject.toLowerCase();
    return tasks.filter((t) => (t.project || '').toLowerCase() === key);
  }, [tasks, activeProject]);

  const stats = useMemo(() => ({
    todo: inScope.filter((t) => t.status !== 'done').length,
    done: inScope.filter((t) => t.status === 'done').length,
  }), [inScope]);

  // Value lists for the query panel — registry names union task-derived ones, so
  // a zero-task project is still selectable. '' (Inbox) leads: it's a real value.
  const queryProjectOptions = useMemo(
    () => ['', ...railProjects.map((p) => p.name)],
    [railProjects],
  );
  const querySourceOptions = useMemo(() => deriveSourceOptions(tasks), [tasks]);
  const querySprintOptions = useMemo(() => deriveSprintOptions(tasks), [tasks]);

  // ── the shared evaluator ──
  //
  // Identical model to the home panel (src/core/task-query.ts): the only reason
  // /tasks and / can agree on "project X, updated in the last 24h" is that this
  // is literally the same predicate. Presentation (column sort, grouping,
  // collapse) stays in TasksPageTable, which is still a pure display component.

  // Re-evaluate relative windows on a minute tick, matching the home panel.
  // visibleInterval, not setInterval: a hidden tab must not burn re-renders
  // (and gets ONE catch-up tick when it comes back).
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => visibleInterval(() => setMinuteTick((n) => n + 1), 60_000), []);

  // The tick only reaches the memo while a relative window is actually set —
  // otherwise every minute re-normalized the query and re-ran the filter pass
  // over the whole table for a guaranteed-identical result.
  const timeTick = query.timePreset === null ? 0 : minuteTick;

  // ONE captured `now` per evaluation, so a window can't slide mid-pass.
  const normalized = useMemo<NormalizedTaskQuery | null>(
    () => safeNormalizeTaskQuery(toTaskQuery(query), new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeTick re-arms relative time windows
    [query, timeTick],
  );

  // Same context builder the home panel uses.
  const queryContext = useMemo<TaskQueryContext>(
    () => buildTaskQueryContext(tasks, query.blocked !== undefined),
    [tasks, query.blocked],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inScope.filter((t: Task) => {
      if (normalized && !matchesTaskQuery(t, normalized, queryContext)) return false;
      // Local title/project text match — the candidate role search plays here
      // (this page has no semantic search service). It ANDs with the query.
      if (q && !t.title.toLowerCase().includes(q) && !(t.project ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inScope, normalized, queryContext, search]);

  const handleGhostCreate = useCallback(async (title: string, project?: string) => {
    // Grouped ghost rows pass their own project; the top ghost falls back to
    // the rail selection. '' stays '' (Inbox).
    const target = project !== undefined ? project : (activeProject || '');
    await create({ title, priority: 'none', project: target || undefined });
  }, [create, activeProject]);

  const handleCreateProject = useCallback(async (name: string, source?: string) => {
    // Select the CANONICAL spelling: project identity is case-insensitive and an
    // existing row's spelling wins, so selecting the raw input could highlight
    // nothing in the rail and file ghost-created tasks under the wrong casing.
    const res = await createProject(name, source);
    refreshRegistry();
    setActiveProject(res.name);
  }, [refreshRegistry]);

  const handleFormCreate = useCallback(async (data: TaskFormData) => {
    await create({
      title: data.title,
      priority: data.priority,
      project: data.project || undefined,
      due_date: data.due_date || undefined,
    });
    setShowForm(false);
  }, [create]);

  const handleReorderProjects = useCallback((order: string[]) => {
    // The rail only shows NAMED projects, but ordering.projects may hold other
    // entries — notably '' (Inbox), placed by the home panel's tier-label drag.
    // A wholesale replace would silently drop them; re-insert each missing
    // entry at its old index so a rail drag never rewrites slots it can't see.
    const railSet = new Set(order.map((n) => n.toLowerCase()));
    const merged = [...order];
    projectOrder.forEach((entry, oldIdx) => {
      if (!railSet.has(entry.toLowerCase())) {
        merged.splice(Math.min(oldIdx, merged.length), 0, entry);
        railSet.add(entry.toLowerCase());
      }
    });
    void reorderProjects(merged);
  }, [reorderProjects, projectOrder]);

  const handleToggleFavorite = useCallback((project: string) => {
    // Registry rows fold the favorite flag in server-side, so refresh after.
    void toggleFavoriteProject(project).then(refreshRegistry).catch(() => {});
  }, [toggleFavoriteProject, refreshRegistry]);

  // Rail/table project menu renamed or deleted a project: refresh the registry
  // and follow the rename (or fall back to All Tasks) so the board doesn't
  // point at a name that no longer exists.
  const handleProjectChanged = useCallback((kind: 'rename' | 'delete', project: string, newName?: string) => {
    refreshRegistry();
    setActiveProject((prev) => {
      if (prev === null || prev.toLowerCase() !== project.toLowerCase()) return prev;
      return kind === 'rename' && newName ? newName : null;
    });
  }, [refreshRegistry]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  const boardTitle = activeProject === null ? 'All Tasks' : (activeProject || 'Inbox');
  const isAll = activeProject === null;

  return (
    <div className="tasks-page">
      <TasksPageRail
        projects={railProjects}
        allOpenCount={allOpenCount}
        inboxOpenCount={openCountByProject.get('') ?? 0}
        activeKey={activeProject}
        onSelect={setActiveProject}
        onCreateProject={handleCreateProject}
        onReorderProjects={handleReorderProjects}
        onToggleFavorite={handleToggleFavorite}
        onProjectChanged={handleProjectChanged}
      />

      <main className="tp-board">
        <div className="tp-toolbar">
          <span className="tp-title" title={boardTitle}>{boardTitle}</span>
          <span className="tp-stats">{stats.todo} todo · {stats.done} done</span>
          {/* The high-frequency conditions stay one click away as chips; every
              other dimension lives in the shared View panel next to them. Both
              write the SAME query state, so a chip and a panel chip can never
              disagree. */}
          <button
            type="button"
            className={`tp-chip${showTodoChip ? ' on' : ''}`}
            onClick={() => toggleCompletionChip('todo')}
          >
            ○ Todo
          </button>
          <button
            type="button"
            className={`tp-chip${showDoneChip ? ' on' : ''}`}
            onClick={() => toggleCompletionChip('done')}
          >
            ✓ Done
          </button>
          <button
            type="button"
            className={`tp-chip${query.priorities.includes('immediate') ? ' on' : ''}`}
            onClick={() => togglePriorityChip('immediate')}
          >
            <span className="tp-p-dot p0" />P0
          </button>
          <button
            type="button"
            className={`tp-chip${query.priorities.includes('important') ? ' on' : ''}`}
            onClick={() => togglePriorityChip('important')}
          >
            <span className="tp-p-dot p1" />P1
          </button>
          <ViewDropdown
            onClearAll={() => handleQueryChange({ ...DEFAULT_TASK_QUERY_FILTER_STATE, sort: query.sort })}
            query={query}
            onQueryChange={handleQueryChange}
            queryProjectOptions={queryProjectOptions}
            querySourceOptions={querySourceOptions}
            querySprintOptions={querySprintOptions}
          />
          {isAll && (
            <>
              <button
                type="button"
                className={`tp-chip${grouped ? ' on' : ''}`}
                title={grouped ? 'Grouped by project — click for a flat list' : 'Flat list — click to group by project'}
                onClick={handleGroupedToggle}
              >
                ⊟ Group
              </button>
              {grouped && (
                <button
                  type="button"
                  className="tp-chip"
                  title={allGroupsCollapsed ? 'Expand all projects' : 'Collapse all projects'}
                  onClick={handleCollapseExpandAll}
                >
                  {allGroupsCollapsed ? '⌃⌃ Expand all' : '⌄⌄ Collapse all'}
                </button>
              )}
            </>
          )}
          <input
            className="tp-search"
            type="search"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="tp-newtask-btn" onClick={() => setShowForm(true)}>＋ Task</button>
        </div>

        {/* Same chips component as the home panel: one removable chip per value. */}
        <TaskFilterChips query={query} onQueryChange={handleQueryChange} />

        <TasksPageTable
          tasks={filtered}
          activeProject={activeProject}
          sourceByName={sourceByName}
          onToggleComplete={toggleComplete}
          onDelete={deleteTask}
          onCreate={handleGhostCreate}
          onUpdate={update}
          favoriteByName={favoriteByName}
          onToggleFavorite={handleToggleFavorite}
          onProjectChanged={handleProjectChanged}
          sort={sort}
          onSortChange={handleSortChange}
          grouped={grouped}
          collapsed={collapsed}
          onToggleGroup={handleToggleGroup}
          projectOrder={projectOrder}
        />
      </main>

      {showForm && (
        <TaskForm
          initial={activeProject ? { project: activeProject } : undefined}
          projects={railProjects.map((p) => p.name)}
          onSubmit={handleFormCreate}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
