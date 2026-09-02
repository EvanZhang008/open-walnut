/**
 * useFolderContextMenu — ONE definition of a folder row's right-click actions,
 * shared by every surface that draws a folder: the pinned tier's `GroupChip`,
 * the main list's folder header row, and the empty-folder row. Per the overlay
 * hard rules ("action rows are defined once"), each surface passes only the
 * handlers it can honour and the rest of the rows drop out via `when` — three
 * parallel copies of this list would drift the moment an action is added.
 *
 * Two things it is careful about:
 *
 *  · "Move to project…" opens {@link ProjectPickerFlyout}, a PORTALLED flyout,
 *    never inline rows. The project registry can hold 30+ entries and a menu
 *    whose height grows after it opened is exactly how the old picker overflowed
 *    the viewport. The picker keeps its own copy of the target + the cursor point
 *    (in state, so it stays referentially stable for `useMenuPlacement`) because
 *    the context menu has already closed by the time it opens.
 *
 *  · The returned `node` must be rendered as a SIBLING of the folder row, not
 *    inside it. Both overlays portal to <body> for stacking, but React synthetic
 *    events still bubble through the component tree — inside a chip that is a
 *    dnd-kit sortable activator, a pointerdown in the menu would arm a drag of
 *    the whole folder.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { ProjectPickerFlyout } from './TaskKebabMenu';

/** The folder a right-click landed on. */
export interface FolderMenuTarget {
  groupId: string;
  label: string;
  /** Owning project ('' = Inbox). undefined = not known yet → "Move to project…"
   *  renders DISABLED (never missing — see the row's note below). */
  project?: string;
  /** Current collapse state — only used to word the Collapse/Expand row. */
  collapsed?: boolean;
}

/** Handlers a surface supports; an omitted one drops its row from the menu. */
export interface FolderMenuActions {
  onRename?: (groupId: string, label: string) => void;
  onToggleCollapse?: (groupId: string) => void;
  onMoveToProject?: (groupId: string, project: string) => void;
  /** Tier chips only — hide the folder out of the Focus area. */
  onHide?: (groupId: string) => void;
  onDelete?: (groupId: string) => void;
}

export interface FolderContextMenuHandle {
  /** `onContextMenu={(e) => menu.open(e, target)}` on the folder row. */
  open: (event: ReactMouseEvent, target: FolderMenuTarget) => boolean;
  /** Render as a SIBLING of the row (see the note above). */
  node: ReactNode;
}

export function useFolderContextMenu(actions: FolderMenuActions): FolderContextMenuHandle {
  const menu = useContextMenu<FolderMenuTarget>();
  const [picker, setPicker] = useState<{ target: FolderMenuTarget; point: { x: number; y: number } } | null>(null);
  // ProjectPickerFlyout is normally anchored to a trigger button; here the anchor
  // is the cursor point, so the element ref stays empty by design (same trick
  // ContextMenu uses).
  const noTrigger = useRef<HTMLElement | null>(null);
  const { onRename, onToggleCollapse, onMoveToProject, onHide, onDelete } = actions;

  // The picker outlives the menu that opened it, so it owns its own dismissal.
  // Scroll closes outright: a cursor anchor is a frozen viewport point.
  useEffect(() => {
    if (!picker) return;
    const insidePicker = (target: EventTarget | null) =>
      !!(target as HTMLElement | null)?.closest?.('.task-kebab-project-flyout');
    const onDown = (e: MouseEvent) => { if (!insidePicker(e.target)) setPicker(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPicker(null); } };
    const onScroll = (e: Event) => { if (!insidePicker(e.target)) setPicker(null); };
    const onResize = () => setPicker(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [picker]);

  // Plain function, not useCallback: it is invoked inline in the render below, so
  // memoizing it saves nothing and only hides the dependency list.
  const buildItems = (target: FolderMenuTarget, point: { x: number; y: number }): ContextMenuItem[] => [
    {
      key: 'rename',
      label: 'Rename folder',
      when: !!onRename,
      onSelect: () => onRename?.(target.groupId, target.label),
    },
    {
      key: 'collapse',
      label: target.collapsed ? 'Expand folder' : 'Collapse folder',
      when: !!onToggleCollapse,
      onSelect: () => onToggleCollapse?.(target.groupId),
    },
    { divider: true },
    {
      // A row that VANISHES is indistinguishable from "this surface doesn't
      // support moving", so an unknown project shows the row DISABLED with the
      // reason instead: the folder registry fetch simply hasn't landed yet.
      key: 'move-project',
      label: 'Move to project…',
      when: !!onMoveToProject,
      disabled: target.project === undefined,
      title: target.project === undefined ? 'Folder project still loading' : undefined,
      onSelect: () => { if (target.project !== undefined) setPicker({ target, point }); },
    },
    {
      key: 'hide',
      label: 'Hide from Focus',
      when: !!onHide,
      onSelect: () => onHide?.(target.groupId),
    },
    { divider: true },
    {
      key: 'delete',
      label: 'Delete folder',
      danger: true,
      when: !!onDelete,
      onSelect: () => onDelete?.(target.groupId),
    },
  ];

  const node = (
    <>
      {menu.state && (
        <ContextMenu
          point={menu.state.point}
          items={buildItems(menu.state.payload, menu.state.point)}
          onClose={menu.close}
          ariaLabel={`Folder actions for ${menu.state.payload.label || 'folder'}`}
          testId="folder-ctx-menu"
        />
      )}
      {picker && (
        <ProjectPickerFlyout
          open
          anchorRef={noTrigger}
          anchorPoint={picker.point}
          align="left"
          current={picker.target.project ?? null}
          onPick={(name) => {
            // Re-picking the folder's own project is a dismiss, not a move.
            if (name !== picker.target.project) onMoveToProject?.(picker.target.groupId, name);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );

  return { open: menu.open, node };
}
