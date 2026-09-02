/**
 * useProjectContextMenu — ONE definition of a project row's right-click actions,
 * shared by every surface that draws a project: the main list's project header
 * and the pinned tier's project label. Sibling of `useFolderContextMenu`, same
 * contract ("action rows are defined once", web/src/AGENTS.md): each surface
 * passes only the handlers it can honour and the rest of the rows drop out via
 * `when`, so two parallel copies can never drift.
 *
 * Three things it is careful about:
 *
 *  · Inbox ('') is the ABSENCE of a project — no registry row, so nothing to
 *    rename, favorite, detail or delete. Those rows are gated on the name being
 *    non-empty, which leaves Inbox a short (and correct) menu: collapse, new
 *    task, new folder, and (on a tier) a separator, none of which need one.
 *
 *  · Rename and Delete come from {@link useProjectActions}, the same hook the
 *    kebab menu uses. The dialog copy and the local-claim vs provider-claim
 *    delete semantics live in exactly one place.
 *
 *  · The returned `node` must be rendered as a SIBLING of the project row, not
 *    inside it. `ContextMenu` does stop pointerdown, so this is belt AND braces —
 *    but both project rows are drag handles (the main list header is a dnd-kit
 *    activator, the tier label is an HTML5 `draggable`), React events bubble
 *    through portals along the COMPONENT tree, and a press that reached either
 *    handle would arm a project reorder from inside the menu.
 */
import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useProjectActions } from '@/hooks/useProjectActions';

/** The project a right-click landed on. */
export interface ProjectMenuTarget {
  /** '' = Inbox. */
  project: string;
  /** Current collapse state — only used to word the Collapse/Expand row. */
  collapsed?: boolean;
  /** Current favorite state — only used to word the Favorite/Unfavorite row. */
  favorite?: boolean;
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
  /** Forwarded to useProjectActions: rename/delete finished on the server. */
  onChanged?: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
}

export interface ProjectContextMenuHandle {
  /** `onContextMenu={(e) => menu.open(e, target)}` on the project row. */
  open: (event: ReactMouseEvent, target: ProjectMenuTarget) => boolean;
  /** Render as a SIBLING of the row (see the note above). */
  node: ReactNode;
  /** A rename/delete request from this menu is in flight. The menu already
   *  disables its own two rows; exposed so a host that draws its own trigger can
   *  show the same state (the kebab does exactly this with its '…' glyph). */
  busy: boolean;
}

/** What the two dialog-backed rows need, which no surface passes in: they come
 *  from {@link useProjectActions} inside the hook below. Separate from
 *  ProjectMenuActions so the surfaces' contract stays exactly what a surface owns. */
export interface ProjectMenuDialogs {
  /** A rename/delete request is in flight — both dialog rows go dead. */
  busy: boolean;
  rename: (project: string) => void;
  remove: (project: string) => void;
}

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
): ContextMenuItem[] {
  const { onToggleCollapse, onNewTask, onNewFolder, onNewSession, onNewSeparator, onToggleFavorite, onViewDetails } = actions;
  const { busy, rename, remove } = dialogs;
  // Every row below that acts on the REGISTRY needs a real project name.
  const named = !!target.project;
  return [
    {
      key: 'collapse',
      label: target.collapsed ? 'Expand project' : 'Collapse project',
      when: !!onToggleCollapse,
      onSelect: () => onToggleCollapse?.(target.project),
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

export function useProjectContextMenu(actions: ProjectMenuActions): ProjectContextMenuHandle {
  const menu = useContextMenu<ProjectMenuTarget>();
  const { busy, rename, remove } = useProjectActions({ onChanged: actions.onChanged });

  const node = menu.state && (
    <ContextMenu
      point={menu.state.point}
      items={buildProjectMenuItems(menu.state.payload, actions, {
        busy,
        rename: (project) => { void rename(project); },
        remove: (project) => { void remove(project); },
      })}
      onClose={menu.close}
      ariaLabel={`Project actions for ${menu.state.payload.project || 'Inbox'}`}
      testId="project-ctx-menu"
    />
  );

  return { open: menu.open, node, busy };
}
