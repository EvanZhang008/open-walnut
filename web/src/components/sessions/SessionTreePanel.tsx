import { useState, useMemo } from 'react';
import type {
  SessionTreeCategory,
  SessionTreeTask,
  SessionRecord,
} from '@/types/session';
import { WORK_LABELS, PROCESS_LABELS, compositeColor } from '@/utils/session-status';

type ProcessFilter = 'all' | 'running' | 'idle' | 'stopped';
type WorkFilter = 'all' | 'in_progress' | 'agent_complete' | 'await_human_action' | 'completed' | 'error';
type TaskFilter = 'all' | 'starred' | 'high';

interface SessionTreePanelProps {
  tree: SessionTreeCategory[];
  orphanSessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  hideCompleted: boolean;
  onToggleHideCompleted: () => void;
  onBack?: () => void;
}

// ── localStorage persistence helpers ──

const LS_COLLAPSED_CATS = 'walnut-session-tree-collapsed-cats';
const LS_COLLAPSED_PROJS = 'walnut-session-tree-collapsed-projs';
const LS_COLLAPSED_TASKS = 'walnut-session-tree-collapsed-tasks';

function readSetFromStorage(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function persistSet(key: string, set: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]));
}

// ── Status helpers ──

function getSessionDotColor(s: SessionRecord): string {
  return compositeColor(s.process_status, s.work_status);
}

function matchesProcessFilter(s: SessionRecord, filter: ProcessFilter): boolean {
  if (filter === 'all') return true;
  return s.process_status === filter;
}

function matchesWorkFilter(s: SessionRecord, filter: WorkFilter): boolean {
  if (filter === 'all') return true;
  return s.work_status === filter;
}

function matchesTaskFilter(t: SessionTreeTask, filter: TaskFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'starred') return t.taskStarred;
  if (filter === 'high') return t.taskPriority === 'high';
  return true;
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

function sessionCount(tasks: SessionTreeTask[]): number {
  return tasks.reduce((sum, t) => sum + t.sessions.length, 0);
}

const PROCESS_FILTERS: { label: string; value: ProcessFilter }[] = [
  { label: 'All', value: 'all' },
  { label: PROCESS_LABELS.running, value: 'running' },
  { label: PROCESS_LABELS.idle, value: 'idle' },
  { label: PROCESS_LABELS.stopped, value: 'stopped' },
];

const WORK_FILTERS: { label: string; value: WorkFilter }[] = [
  { label: 'All', value: 'all' },
  { label: WORK_LABELS.in_progress, value: 'in_progress' },
  { label: WORK_LABELS.agent_complete, value: 'agent_complete' },
  { label: WORK_LABELS.await_human_action, value: 'await_human_action' },
  { label: WORK_LABELS.completed, value: 'completed' },
  { label: WORK_LABELS.error, value: 'error' },
];

const TASK_FILTERS: { label: string; value: TaskFilter }[] = [
  { label: 'All Tasks', value: 'all' },
  { label: 'Starred', value: 'starred' },
  { label: 'High Priority', value: 'high' },
];

// ── Component ──

export function SessionTreePanel({
  tree,
  orphanSessions,
  selectedId,
  onSelect,
  hideCompleted,
  onToggleHideCompleted,
  onBack,
}: SessionTreePanelProps) {
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_CATS));
  const [collapsedProjs, setCollapsedProjs] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_PROJS));
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_TASKS));
  const [processFilter, setProcessFilter] = useState<ProcessFilter>('all');
  const [workFilter, setWorkFilter] = useState<WorkFilter>('all');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');

  const toggleCat = (cat: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      persistSet(LS_COLLAPSED_CATS, next);
      return next;
    });
  };

  const toggleProj = (key: string) => {
    setCollapsedProjs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistSet(LS_COLLAPSED_PROJS, next);
      return next;
    });
  };

  const toggleTask = (key: string) => {
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistSet(LS_COLLAPSED_TASKS, next);
      return next;
    });
  };

  // Apply filters to compute a filtered tree
  const { filteredTree, filteredOrphans, totalCount } = useMemo(() => {
    const filterSessions = (sessions: SessionRecord[]) =>
      sessions.filter((s) => matchesProcessFilter(s, processFilter) && matchesWorkFilter(s, workFilter));

    const filterTasks = (tasks: SessionTreeTask[]) => {
      if (taskFilter === 'all' && processFilter === 'all' && workFilter === 'all') return tasks;
      return tasks.reduce<SessionTreeTask[]>((acc, t) => {
        if (!matchesTaskFilter(t, taskFilter)) return acc;
        const filtered = filterSessions(t.sessions);
        if (filtered.length > 0) {
          acc.push({ ...t, sessions: filtered });
        }
        return acc;
      }, []);
    };

    const fTree = tree.reduce<SessionTreeCategory[]>((acc, cat) => {
      const directTasks = filterTasks(cat.directTasks);
      const projects = cat.projects.reduce<typeof cat.projects>((pacc, proj) => {
        const tasks = filterTasks(proj.tasks);
        if (tasks.length > 0) pacc.push({ ...proj, tasks });
        return pacc;
      }, []);
      if (directTasks.length > 0 || projects.length > 0) {
        acc.push({ ...cat, directTasks, projects });
      }
      return acc;
    }, []);

    const fOrphans = filterSessions(orphanSessions);

    let count = fOrphans.length;
    for (const cat of fTree) {
      count += sessionCount(cat.directTasks);
      for (const proj of cat.projects) {
        count += sessionCount(proj.tasks);
      }
    }

    return { filteredTree: fTree, filteredOrphans: fOrphans, totalCount: count };
  }, [tree, orphanSessions, processFilter, workFilter, taskFilter]);

  const renderSession = (s: SessionRecord) => {
    const sid = s.claudeSessionId;
    const title = s.title || s.description || sid || 'Untitled session';
    const isPlan = s.mode === 'plan';
    return (
      <div
        key={sid}
        className={`session-tree-session${sid === selectedId ? ' session-tree-session-selected' : ''}`}
        onClick={() => onSelect(sid)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(sid); }}
      >
        <span
          className="session-status-dot"
          style={{ background: getSessionDotColor(s) }}
        />
        {isPlan && (
          <span
            className="session-tree-plan-badge"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            Plan
          </span>
        )}
        {s.provider === 'embedded' && (
          <span
            style={{
              color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            🤖
          </span>
        )}
        <span className="session-tree-session-title">{title}</span>
        <span className="session-tree-session-time text-xs text-muted">{formatShortDate(s.startedAt)}</span>
      </div>
    );
  };

  const renderTaskNode = (task: SessionTreeTask, keyPrefix: string) => {
    const taskKey = `${keyPrefix}/${task.taskId}`;
    const isCollapsed = collapsedTasks.has(taskKey);
    const count = task.sessions.length;

    const statusIcon = task.taskStatus === 'done' ? '✓' : task.taskStatus === 'in_progress' ? '●' : '○';

    return (
      <div key={taskKey} className="session-tree-task">
        <div
          className="session-tree-task-header"
          onClick={() => toggleTask(taskKey)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') toggleTask(taskKey); }}
        >
          <span className="session-tree-arrow">{isCollapsed ? '▶' : '▼'}</span>
          <span className="session-tree-task-status">{statusIcon}</span>
          <span className="session-tree-task-name truncate">
            {task.taskStarred && <span className="session-tree-star">★ </span>}
            {task.taskTitle}
          </span>
          <span className="session-tree-count">{count}</span>
        </div>
        {!isCollapsed && (
          <div className="session-tree-task-children">
            {task.sessions.map(renderSession)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="session-tree-panel">
      <div className="session-tree-header">
        {onBack && (
          <button className="session-tree-back-btn" onClick={onBack} title="Back" aria-label="Go back">&larr;</button>
        )}
        <span className="session-tree-header-title">Sessions</span>
        <span className="session-tree-count">{totalCount}</span>
      </div>

      {/* Filter bars */}
      <div className="session-tree-filters">
        <div className="session-tree-filter-group">
          <span className="session-tree-filter-label">Process</span>
          <div className="session-tree-filter-chips">
            {PROCESS_FILTERS.map((f) => (
              <button
                key={f.value}
                className={`session-tree-chip${processFilter === f.value ? ' session-tree-chip-active' : ''}`}
                onClick={() => setProcessFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="session-tree-filter-group">
          <span className="session-tree-filter-label">Work</span>
          <div className="session-tree-filter-chips">
            {WORK_FILTERS.map((f) => (
              <button
                key={f.value}
                className={`session-tree-chip${workFilter === f.value ? ' session-tree-chip-active' : ''}`}
                onClick={() => setWorkFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="session-tree-filter-group">
          <span className="session-tree-filter-label">Task</span>
          <div className="session-tree-filter-chips">
            {TASK_FILTERS.map((f) => (
              <button
                key={f.value}
                className={`session-tree-chip${taskFilter === f.value ? ' session-tree-chip-active' : ''}`}
                onClick={() => setTaskFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
            <button
              className={`session-tree-chip${hideCompleted ? ' session-tree-chip-active' : ''}`}
              onClick={onToggleHideCompleted}
            >
              Hide Done
            </button>
          </div>
        </div>
      </div>

      <div className="session-tree-scroll">
        {filteredTree.map((cat) => {
          const catCollapsed = collapsedCats.has(cat.category);
          const catCount = sessionCount(cat.directTasks) +
            cat.projects.reduce((sum, p) => sum + sessionCount(p.tasks), 0);

          return (
            <div key={cat.category} className="session-tree-category">
              <div
                className="session-tree-category-header"
                onClick={() => toggleCat(cat.category)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') toggleCat(cat.category); }}
              >
                <span className="session-tree-arrow">{catCollapsed ? '▶' : '▼'}</span>
                <span className="session-tree-category-name">{cat.category}</span>
                <span className="session-tree-count">{catCount}</span>
              </div>

              {!catCollapsed && (
                <>
                  {cat.directTasks.map((t) => renderTaskNode(t, cat.category))}

                  {cat.projects.map((proj) => {
                    const projKey = `${cat.category}/${proj.project}`;
                    const projCollapsed = collapsedProjs.has(projKey);
                    const projCount = sessionCount(proj.tasks);

                    return (
                      <div key={projKey} className="session-tree-project">
                        <div
                          className="session-tree-project-header"
                          onClick={() => toggleProj(projKey)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter') toggleProj(projKey); }}
                        >
                          <span className="session-tree-arrow">{projCollapsed ? '▶' : '▼'}</span>
                          <span className="session-tree-project-name">{proj.project}</span>
                          <span className="session-tree-count">{projCount}</span>
                        </div>

                        {!projCollapsed && proj.tasks.map((t) => renderTaskNode(t, projKey))}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}

        {filteredOrphans.length > 0 && (
          <div className="session-tree-category">
            <div className="session-tree-category-header session-tree-orphan-header">
              <span className="session-tree-category-name">Unlinked Sessions</span>
              <span className="session-tree-count">{filteredOrphans.length}</span>
            </div>
            {filteredOrphans.map(renderSession)}
          </div>
        )}

        {filteredTree.length === 0 && filteredOrphans.length === 0 && (
          <div className="session-tree-empty">
            <p className="text-muted text-sm">No sessions match filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
