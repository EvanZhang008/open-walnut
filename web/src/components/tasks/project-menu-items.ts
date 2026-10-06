/**
 * The project right-click menu's rows, with no React component in the import graph so the gating
 * matrix (named vs Inbox, favorite, collapsed, busy, which handlers a surface passes) is testable
 * as a plain function. The hook that draws them is `useProjectContextMenu` in ProjectContextMenu.tsx.
 */
import type { ContextMenuItem } from '@/utils/context-menu';
import type { SortBy } from './ViewDropdown';

/** The task orders a project can have, in menu order. The Projects heading offers the
 *  same list to set every project at once. */
export const PROJECT_SORT_OPTIONS: ReadonlyArray<readonly [SortBy, string]> = [
  ['updated', 'Last updated'], ['priority', 'Priority'], ['date', 'Created'], ['manual', 'Manual order'],
];

/** The project a right-click landed on. */
export interface ProjectMenuTarget {
  /** '' = Inbox. */
  project: string;
  /** Current collapse state — only used to word the Collapse/Expand row. */
  collapsed?: boolean;
  /** Current favorite state — only used to word the Favorite/Unfavorite row. */
  favorite?: boolean;
  /** How this project's tasks are ordered now; checks one of the Sort rows. */
  sort?: SortBy;
}

/** Handlers a surface supports; an omitted one drops its row from the menu. */
export interface ProjectMenuActions {
  onToggleCollapse?: (project: string) => void;
  /** Open this project's inline "add task" row. */
  onNewTask?: (project: string) => void;
  /** Create an empty folder in this project (name prompted by the host). */
  onNewFolder?: (project: string) => void;
  /** Open a draft session column seeded with this project. Named projects only —
   *  a launch seeds the project's default folder, which Inbox cannot have. */
  onNewSession?: (project: string) => void;
  /** Drop a divider line at the top of this project's run. Pinned tiers only: a
   *  line's position is defined by the tier's view mode, so the main list (which
   *  has no such mode) passes nothing and the row drops out. */
  onNewSeparator?: (project: string) => void;
  onToggleFavorite?: (project: string) => void;
  onViewDetails?: (project: string) => void;
  onMoveUp?: (project: string) => void;
  onMoveDown?: (project: string) => void;
  /** Order this project's tasks, this project only. The main list only: a tier's
   *  project run keeps the tier's pinned order, so the tier label passes nothing. */
  onSetSort?: (project: string, sort: SortBy) => void;
  /** Narrow the home board to this one project (spec 6.8: replaces the Project chip). */
  onFilterToProject?: (project: string) => void;
  /** Forwarded to useProjectActions: rename/delete finished on the server. */
  onChanged?: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
}

/** What the dialog- and picker-backed rows need, which no surface passes in: the
 *  dialogs come from {@link useProjectActions} inside the hook below, the picker
 *  from its own flyout state. Separate from ProjectMenuActions so the surfaces'
 *  contract stays exactly what a surface owns. */
export interface ProjectMenuDialogs {
  /** A rename/delete request is in flight — both dialog rows go dead. */
  busy: boolean;
  rename: (project: string) => void;
  remove: (project: string) => void;
  /** Open the Sort setting's option list for this project (the row closed the menu). */
  pickSort: (project: string, current: SortBy) => void;
  /** Open the project list for the Project row; a pick moves this project into that one. */
  pickProject?: (project: string) => void;
}

/** The setting rows a project shares with the task menu, built from its open tasks (`useBulkTaskSettings`). */
export interface ProjectSettingRows {
  pinned: ContextMenuItem[];
  fields: ContextMenuItem[];
}

/** The order a project with no choice of its own uses. */
const DEFAULT_SORT: SortBy = 'updated';

/**
 * The row list for one right-clicked project — module scope and exported so the
 * gating matrix (named vs Inbox, favorite, collapsed, busy, which handlers a
 * surface passes) is testable as a plain function, with no DOM and no renderer.
 * Called inline from the render below, so nothing is memoized: there is one call
 * per open menu.
 */
export function buildProjectMenuItems(
  target: ProjectMenuTarget,
  actions: ProjectMenuActions,
  dialogs: ProjectMenuDialogs,
  settings: ProjectSettingRows = { pinned: [], fields: [] },
): ContextMenuItem[] {
  const { onToggleCollapse, onNewTask, onNewFolder, onNewSession, onNewSeparator, onToggleFavorite, onViewDetails } = actions;
  const { busy, rename, remove, pickSort, pickProject } = dialogs;
  // Every row below that acts on the REGISTRY needs a real project name.
  const named = !!target.project;
  return [
    {
      key: 'collapse',
      label: target.collapsed ? 'Expand project' : 'Collapse project',
      when: !!onToggleCollapse,
      onSelect: () => onToggleCollapse?.(target.project),
    },
    { key: 'move-up', label: 'Move up', when: !!actions.onMoveUp, onSelect: () => actions.onMoveUp?.(target.project) },
    { key: 'move-down', label: 'Move down', when: !!actions.onMoveDown, onSelect: () => actions.onMoveDown?.(target.project) },
    {
      key: 'filter-to-project',
      label: 'Filter to this project',
      when: !!actions.onFilterToProject,
      onSelect: () => actions.onFilterToProject?.(target.project),
    },
    { divider: true },
    {
      key: 'new-task',
      label: 'New task',
      when: !!onNewTask,
      onSelect: () => onNewTask?.(target.project),
    },
    {
      key: 'new-folder',
      label: 'New folder',
      when: !!onNewFolder,
      onSelect: () => onNewFolder?.(target.project),
    },
    {
      key: 'new-session',
      label: 'New task with session',
      when: !!onNewSession && named,
      onSelect: () => onNewSession?.(target.project),
    },
    {
      // Last in the "add something" group and worded like the "+" menu's own
      // item, so the row's two controls offer the same verbs in the same order.
      key: 'new-separator',
      label: 'Add separator',
      when: !!onNewSeparator,
      onSelect: () => onNewSeparator?.(target.project),
    },
    { divider: true },
    // The task menu's settings group, in its order: Pinned, Project, then each plugin field.
    ...settings.pinned,
    {
      // Inbox is the absence of a project: there is nothing to move into another one.
      key: 'move-project',
      label: 'Project',
      value: target.project,
      title: 'Move this project into another one',
      when: !!pickProject && named,
      disabled: busy,
      onSelect: () => pickProject?.(target.project),
    },
    ...settings.fields,
    {
      // A SETTING row, not four radio rows: the current order reads on the row itself and the
      // four options sit in a flyout, so the menu stays short and matches the task menu's rows.
      key: 'sort',
      label: 'Sort',
      value: PROJECT_SORT_OPTIONS.find(([value]) => value === (target.sort ?? DEFAULT_SORT))?.[1],
      title: "The order of this project's tasks",
      when: !!actions.onSetSort,
      onSelect: () => pickSort(target.project, target.sort ?? DEFAULT_SORT),
    },
    { divider: true },
    {
      key: 'rename',
      label: 'Rename project',
      when: named,
      // Both dialog-backed rows go dead while a request is in flight. The
      // confirm/prompt modal closes the instant its button is pressed, well
      // before the request resolves, so without this a second right-click could
      // fire a second Delete during the network phase (on a provider-claimed
      // project that is the ?remote=1 cascade).
      disabled: busy,
      onSelect: () => rename(target.project),
    },
    {
      key: 'favorite',
      label: target.favorite ? 'Unfavorite project' : 'Favorite project',
      when: !!onToggleFavorite && named,
      onSelect: () => onToggleFavorite?.(target.project),
    },
    {
      key: 'details',
      label: 'View project details',
      when: !!onViewDetails && named,
      onSelect: () => onViewDetails?.(target.project),
    },
    { divider: true },
    {
      key: 'delete',
      label: 'Delete project',
      danger: true,
      when: named,
      disabled: busy,
      onSelect: () => remove(target.project),
    },
  ];
}
