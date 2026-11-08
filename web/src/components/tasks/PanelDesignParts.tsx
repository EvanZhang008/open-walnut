/**
 * The parts only the By project layout draws (panel-design.ts): its per-project folds,
 * which hold only waiting tasks (completed ones fold once, at the bottom of the view).
 */
import { useMemo } from 'react';
import { LS_PROJECT_FOLDS_KEY, projectFoldKey, type ProjectFoldTasks } from './panel-design';
import { NavigationChevron } from './NavigationSections';
import { SECTION_ICONS, SectionRows, type SectionRowHandlers } from './StatusSections';
import { FOLD_KEY_ATTR, foldIsOpen, projectFoldKind } from './section-fold-rule';
import { useFoldStore } from './useFoldStore';
import { statusFoldTooltip } from './status-sections';
import { projectDisplayName } from '../../utils/project-display';

/** The open folds, by the one fold rule (section-fold-rule.ts): folded by default, folded again 60 s after the last action in the panel. */
export function useProjectFolds(): [Set<string>, (key: string) => void] {
  const { store, toggle } = useFoldStore(LS_PROJECT_FOLDS_KEY, projectFoldKind);
  const open = useMemo(() => new Set(Object.keys(store).filter((k) => foldIsOpen(store, k, projectFoldKind))), [store]);
  return [open, toggle];
}

/**
 * The By project design's row at the end of a project: its waiting tasks, a folded
 * line ("⧗ 3 Waiting / snoozed") that opens in place.
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
  if (!tasks || tasks.waiting.length === 0) return null;
  // Inside a tier the cards are that tier's: no tier glyph on them.
  const rowHandlers = region === 'list' ? handlers : { ...handlers, viewSection: region };
  const key = projectFoldKey(region, project, 'waiting');
  const isOpen = open.has(key);
  return (
    <div className="project-status-folds" data-testid="project-status-folds" data-project={project}>
      {label && (
        <div className="tier-project-label recent-project-label project-status-folds-project">
          <span className="tier-project-label-name">{projectDisplayName(project)}</span>
        </div>
      )}
      <div className="project-status-fold-row">
        <button
          type="button"
          className={`project-status-fold project-status-fold-waiting${isOpen ? ' open' : ''}`}
          aria-expanded={isOpen}
          data-testid="project-status-fold-waiting"
          {...{ [FOLD_KEY_ATTR]: key }}
          title={statusFoldTooltip('waiting', isOpen)}
          onClick={(e) => { e.stopPropagation(); onToggle(key); }}
        >
          <span className="project-status-count-icon" aria-hidden="true">{SECTION_ICONS.waiting}</span>
          {tasks.waiting.length} Waiting / snoozed
          <NavigationChevron collapsed={!isOpen} />
        </button>
      </div>
      {isOpen && (
        <div className="project-status-fold-rows" {...{ [FOLD_KEY_ATTR]: key }}>
          <SectionRows sectionKey="waiting" tasks={tasks.waiting} total={tasks.waiting.length} handlers={rowHandlers} inProject />
        </div>
      )}
    </div>
  );
}
