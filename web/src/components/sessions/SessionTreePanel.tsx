import { useState, useMemo, useEffect, useRef } from 'react';
import type {
  SessionTreeCategory,
  SessionTreeTask,
  SessionRecord,
} from '@/types/session';
import { PHASE_LABELS, PROCESS_LABELS, compositePhaseColor } from '@/utils/session-status';
import type { TaskPhase } from '@/types/session';
import { ICON_CLOSE, ICON_SEARCH } from '@/components/common/Icons';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { resolveSessionRecordStatus } from '@/stores/session-status-store';

type ProcessFilter = 'all' | 'running' | 'idle' | 'stopped' | 'error';
type TaskFilter = 'all' | 'starred' | 'high';

interface SessionTreePanelProps {
  tree: SessionTreeCategory[];
  orphanSessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  hideCompleted: boolean;
  onToggleHideCompleted: () => void;
  onBack?: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  total: number;
  remaining: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

// ── localStorage persistence helpers ──

const LS_COLLAPSED_CATS = 'open-walnut-session-tree-collapsed-cats';
const LS_COLLAPSED_PROJS = 'open-walnut-session-tree-collapsed-projs';
const LS_EXPANDED_TASKS = 'open-walnut-session-tree-expanded-tasks-v2';

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

function getSessionDotColor(s: SessionRecord, taskPhase?: TaskPhase): string {
  return compositePhaseColor(s.process_status, taskPhase);
}

function matchesProcessFilter(s: SessionRecord, filter: ProcessFilter): boolean {
  if (filter === 'all') return true;
  return s.process_status === filter;
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
  { label: PROCESS_LABELS.error, value: 'error' },
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
  query,
  onQueryChange,
  total,
  remaining,
  hasMore,
  loadingMore,
  onLoadMore,
}: SessionTreePanelProps) {
  const statusEpoch = useSessionStatusEpoch();
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_CATS));
  const [collapsedProjs, setCollapsedProjs] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_PROJS));
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(() => readSetFromStorage(LS_EXPANDED_TASKS));
  const [processFilter, setProcessFilter] = useState<ProcessFilter>('all');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const panelRef = useRef<HTMLDivElement>(null);
  const previousExactResultRef = useRef('');
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const isSearching = query.trim().length > 0;
  const loadedCount = useMemo(() => {
    let count = orphanSessions.length;
    for (const category of tree) {
      count += sessionCount(category.directTasks);
      for (const project of category.projects) count += sessionCount(project.tasks);
    }
    return count;
  }, [tree, orphanSessions]);

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
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistSet(LS_EXPANDED_TASKS, next);
      return next;
    });
  };

  // Apply filters to compute a filtered tree
  const { filteredTree, filteredOrphans, totalCount, filteredSessions } = useMemo(() => {
    const filterSessions = (sessions: SessionRecord[]) =>
      sessions
        .map((session) => resolveSessionRecordStatus(session))
        .filter((session) => matchesProcessFilter(session, processFilter));

    const filterTasks = (tasks: SessionTreeTask[]) => {
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

    const allSessions = [
      ...fTree.flatMap((category) => [
        ...category.directTasks.flatMap((task) => task.sessions),
        ...category.projects.flatMap((project) => project.tasks.flatMap((task) => task.sessions)),
      ]),
      ...fOrphans,
    ];

    return { filteredTree: fTree, filteredOrphans: fOrphans, totalCount: count, filteredSessions: allSessions };
  }, [tree, orphanSessions, processFilter, taskFilter, statusEpoch]);

  useEffect(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const only = filteredSessions.length === 1 ? filteredSessions[0] : undefined;
    const exactResult = normalized
      && only?.claudeSessionId.toLocaleLowerCase() === normalized
      ? only
      : undefined;
    const selectionKey = exactResult ? `${normalized}\0${exactResult.claudeSessionId}` : '';
    const previousKey = previousExactResultRef.current;
    previousExactResultRef.current = selectionKey;

    // Selection follows the result transition, not selectedId changes. Mobile
    // Back clears selectedId while the exact result remains mounted; that must
    // return to the master list instead of immediately selecting it again.
    if (exactResult
      && selectionKey !== previousKey
      && selectedIdRef.current !== exactResult.claudeSessionId) {
      onSelect(exactResult.claudeSessionId);
    }
  }, [query, filteredSessions, onSelect]);

  useEffect(() => {
    if (!selectedId) return;
    const frame = requestAnimationFrame(() => {
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>('[data-session-id]');
      const selected = nodes ? [...nodes].find((node) => node.dataset.sessionId === selectedId) : undefined;
      const active = document.activeElement;
      if (selected && (active === document.body || active?.hasAttribute('data-session-id'))) {
        selected.focus({ preventScroll: true });
      }
      selected?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, filteredTree, filteredOrphans]);

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!current) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .filter((item) => item.getClientRects().length > 0);
    const index = items.indexOf(current);
    const focusAt = (nextIndex: number) => {
      const next = items[nextIndex];
      if (!next) return;
      event.preventDefault();
      next.focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        focusAt(Math.min(items.length - 1, index + 1));
        break;
      case 'ArrowUp':
        focusAt(Math.max(0, index - 1));
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'ArrowRight': {
        const expanded = current.getAttribute('aria-expanded');
        if (expanded === 'false') {
          event.preventDefault();
          current.click();
        } else if (expanded === 'true') {
          focusAt(index + 1);
        }
        break;
      }
      case 'ArrowLeft': {
        const expanded = current.getAttribute('aria-expanded');
        if (expanded === 'true') {
          event.preventDefault();
          current.click();
          break;
        }
        const parentGroup = current.parentElement?.closest<HTMLElement>('[role="group"]');
        const parentItem = parentGroup?.parentElement
          ?.querySelector<HTMLElement>(':scope > [role="treeitem"]');
        if (parentItem) {
          event.preventDefault();
          parentItem.focus();
        }
        break;
      }
    }
  };

  const renderSession = (s: SessionRecord, level: number) => {
    const sid = s.claudeSessionId;
    const title = s.title || s.description || sid || 'Untitled session';
    const isPlan = s.mode === 'plan' || !!s.planCompleted;
    return (
      <button
        type="button"
        key={sid}
        className={`session-tree-session${sid === selectedId ? ' session-tree-session-selected' : ''}`}
        onClick={() => onSelect(sid)}
        role="treeitem"
        aria-level={level}
        aria-selected={sid === selectedId}
        aria-label={`${title}${s.engine === 'codex' ? ', Codex' : ''}`}
        data-session-id={sid}
      >
        <span
          className="session-status-dot"
          style={{ background: getSessionDotColor(s) }}
          aria-hidden="true"
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
        {s.engine === 'codex' && (
          <span className="session-tree-codex-badge" title="Codex session via ACP">
            Codex
          </span>
        )}
        <span className="session-tree-session-title" title={s.recap || undefined}>{title}</span>
        <span className="session-tree-session-time text-xs text-muted">{formatShortDate(s.startedAt)}</span>
      </button>
    );
  };

  const renderTaskNode = (task: SessionTreeTask, keyPrefix: string, level: number) => {
    const taskKey = `${keyPrefix}/${task.taskId}`;
    const isCollapsed = !isSearching && !expandedTasks.has(taskKey);
    const count = task.sessions.length;

    const statusIcon = task.taskStatus === 'done' ? '✓' : task.taskStatus === 'in_progress' ? '●' : '○';

    return (
      <div key={taskKey} className="session-tree-task" role="none">
        <button
          type="button"
          className="session-tree-task-header"
          onClick={() => toggleTask(taskKey)}
          role="treeitem"
          aria-level={level}
          aria-expanded={!isCollapsed}
          aria-label={`${task.taskTitle}, ${count} ${count === 1 ? 'session' : 'sessions'}`}
        >
          <span className="session-tree-arrow" aria-hidden="true">{isCollapsed ? '▶' : '▼'}</span>
          <span className="session-tree-task-status" aria-hidden="true">{statusIcon}</span>
          <span className="session-tree-task-name truncate">
            {task.taskStarred && <span className="session-tree-star">★ </span>}
            {task.taskTitle}
          </span>
          <span className="session-tree-count">{count}</span>
        </button>
        {!isCollapsed && (
          <div className="session-tree-task-children" role="group">
            {task.sessions.map((session) => renderSession(session, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="session-tree-panel" ref={panelRef}>
      <div className="session-tree-header">
        {onBack && (
          <button className="session-tree-back-btn" onClick={onBack} title="Back" aria-label="Go back">&larr;</button>
        )}
        <span className="session-tree-header-title">Sessions</span>
        <span className="session-tree-count">
          {processFilter === 'all' && taskFilter === 'all' ? total : totalCount}
        </span>
      </div>

      <div className="session-tree-search">
        <span className="session-tree-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
        {query && (
          <button
            type="button"
            className="session-tree-search-clear"
            onClick={() => onQueryChange('')}
            aria-label="Clear session search"
            title="Clear search"
          >
            {ICON_CLOSE}
          </button>
        )}
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
        <div role="tree" aria-label="Sessions" onKeyDown={handleTreeKeyDown}>
        {filteredTree.map((cat) => {
          const catCollapsed = !isSearching && collapsedCats.has(cat.category);
          const catCount = sessionCount(cat.directTasks) +
            cat.projects.reduce((sum, p) => sum + sessionCount(p.tasks), 0);

          return (
            <div key={cat.category} className="session-tree-category" role="none">
              <button
                type="button"
                className="session-tree-category-header"
                onClick={() => toggleCat(cat.category)}
                role="treeitem"
                aria-level={1}
                aria-expanded={!catCollapsed}
                aria-label={`${cat.category}, ${catCount} ${catCount === 1 ? 'session' : 'sessions'}`}
              >
                <span className="session-tree-arrow" aria-hidden="true">{catCollapsed ? '▶' : '▼'}</span>
                <span className="session-tree-category-name">{cat.category}</span>
                <span className="session-tree-count">{catCount}</span>
              </button>

              {!catCollapsed && (
                <div role="group">
                  {cat.directTasks.map((t) => renderTaskNode(t, cat.category, 2))}

                  {cat.projects.map((proj) => {
                    const projKey = `${cat.category}/${proj.project}`;
                    const projCollapsed = !isSearching && collapsedProjs.has(projKey);
                    const projCount = sessionCount(proj.tasks);

                    return (
                      <div key={projKey} className="session-tree-project" role="none">
                        <button
                          type="button"
                          className="session-tree-project-header"
                          onClick={() => toggleProj(projKey)}
                          role="treeitem"
                          aria-level={2}
                          aria-expanded={!projCollapsed}
                          aria-label={`${proj.project}, ${projCount} ${projCount === 1 ? 'session' : 'sessions'}`}
                        >
                          <span className="session-tree-arrow" aria-hidden="true">{projCollapsed ? '▶' : '▼'}</span>
                          <span className="session-tree-project-name">{proj.project}</span>
                          <span className="session-tree-count">{projCount}</span>
                        </button>

                        {!projCollapsed && (
                          <div role="group">
                            {proj.tasks.map((t) => renderTaskNode(t, projKey, 3))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {filteredOrphans.length > 0 && (
          <div className="session-tree-category" role="none">
            <div className="session-tree-category-header session-tree-orphan-header">
              <span className="session-tree-category-name">Unlinked Sessions</span>
              <span className="session-tree-count">{filteredOrphans.length}</span>
            </div>
            {filteredOrphans.map((session) => renderSession(session, 1))}
          </div>
        )}

        {filteredTree.length === 0 && filteredOrphans.length === 0 && (
          <div className="session-tree-empty">
            <p className="text-muted text-sm">No sessions match filters</p>
          </div>
        )}
        </div>
        {hasMore && remaining > 0 && total > loadedCount && (
          <div className="session-tree-load-more">
            <button type="button" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : `Load more (${remaining} remaining)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
