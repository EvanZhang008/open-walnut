/**
 * The parts only the By project layout draws (panel-design.ts): its per-project folds.
 */
import { useCallback, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { LS_PROJECT_FOLDS_KEY, projectFoldKey } from './panel-design';
import { SECTION_ICONS, SectionRows, type SectionRowHandlers } from './StatusSections';
import { STATUS_SECTION_TITLES, projectRuns, sortSectionTasks, stateSectionNoNeeds, isWatched } from './status-sections';

export interface ProjectFoldTasks { waiting: Task[]; done: Task[] }

/** A region's waiting and completed tasks by project (watched ones stay under Watching). */
export function foldTasksByProject(
  scope: readonly Task[],
  passes: (t: Task) => boolean,
  snoozed?: (t: Task) => boolean,
): Map<string, ProjectFoldTasks> {
  const out = new Map<string, ProjectFoldTasks>();
  const seen = new Set<string>();
  for (const t of scope) {
    if (seen.has(t.id) || isWatched(t) || !passes(t)) continue;
    seen.add(t.id);
    // Needs you stays in the list in this design: only a parked or snoozed one folds.
    const s = stateSectionNoNeeds(t, snoozed);
    if (s !== 'waiting' && s !== 'done') continue;
    const key = t.project || '';
    let f = out.get(key);
    if (!f) { f = { waiting: [], done: [] }; out.set(key, f); }
    f[s].push(t);
  }
  for (const f of out.values()) {
    f.waiting = sortSectionTasks('waiting', f.waiting);
    f.done = sortSectionTasks('done', f.done);
  }
  return out;
}

/** The open folds, stored across reloads. */
export function useProjectFolds(): [Set<string>, (key: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_PROJECT_FOLDS_KEY) ?? '[]') as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
    } catch { return new Set(); }
  });
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try {
        if (next.size) localStorage.setItem(LS_PROJECT_FOLDS_KEY, JSON.stringify([...next]));
        else localStorage.removeItem(LS_PROJECT_FOLDS_KEY);
      } catch { /* quota: the fold still flips for this page */ }
      return next;
    });
  }, []);
  return [open, toggle];
}

const FOLD_LABEL = { waiting: 'Waiting / snoozed', done: 'Completed' } as const;

/**
 * The By project design's row at the end of a project: its waiting and completed
 * tasks, each a folded line ("⧗ 3 Waiting / snoozed") that opens in place.
 * `label` draws a project heading too, for a project with no open row in the region.
 */
export function ProjectStatusFolds({ region, project, tasks, open, onToggle, handlers, label }: {
  region: string;
  project: string;
  tasks: ProjectFoldTasks | undefined;
  open: Set<string>;
  onToggle: (key: string) => void;
  handlers: SectionRowHandlers;
  label?: boolean;
}) {
  if (!tasks || (tasks.waiting.length === 0 && tasks.done.length === 0)) return null;
  const kinds = (['waiting', 'done'] as const).filter((k) => tasks[k].length > 0);
  // Inside a tier the cards are that tier's: no tier glyph on them.
  const rowHandlers = region === 'list' ? handlers : { ...handlers, viewSection: region };
  return (
    <div className="project-status-folds" data-testid="project-status-folds" data-project={project}>
      {label && (
        <div className="tier-project-label recent-project-label project-status-folds-project">
          <span className="tier-project-label-name">{project || 'Inbox'}</span>
        </div>
      )}
      <div className="project-status-fold-row">
        {kinds.map((k) => {
          const key = projectFoldKey(region, project, k);
          const isOpen = open.has(key);
          return (
            <button
              key={k}
              type="button"
              className={`project-status-fold project-status-fold-${k}${isOpen ? ' open' : ''}`}
              aria-expanded={isOpen}
              data-testid={`project-status-fold-${k}`}
              title={`${STATUS_SECTION_TITLES[k]}. Click to ${isOpen ? 'collapse' : 'expand'}.`}
              onClick={(e) => { e.stopPropagation(); onToggle(key); }}
            >
              <span className="project-status-count-icon" aria-hidden="true">{SECTION_ICONS[k]}</span>
              {tasks[k].length} {FOLD_LABEL[k]}
            </button>
          );
        })}
      </div>
      {kinds.map((k) => open.has(projectFoldKey(region, project, k)) && (
        <SectionRows key={k} sectionKey={k} tasks={tasks[k]} total={tasks[k].length} handlers={rowHandlers} inProject />
      ))}
    </div>
  );
}

/** Projects of a region whose only tasks here are waiting or completed: drawn at its end. */
export function leftoverFoldProjects(folds: Map<string, ProjectFoldTasks>, drawn: ReadonlySet<string>): string[] {
  return projectRuns([...folds.entries()].flatMap(([, f]) => [...f.waiting, ...f.done]))
    .map((r) => r.project)
    .filter((p) => !drawn.has(p));
}
