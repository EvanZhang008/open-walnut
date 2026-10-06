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
 *  · The Project SETTING row shows the folder's project and opens
 *    {@link ProjectPickerFlyout}, a PORTALLED flyout, never inline rows. The
 *    project registry can hold 30+ entries and a menu whose height grows after
 *    it opened is exactly how the old picker overflowed the viewport. The picker
 *    keeps its own copy of the target + the cursor point (`useCursorFlyout`)
 *    because the context menu has already closed by the time it opens.
 *
 *  · The returned `node` must be rendered as a SIBLING of the folder row, not
 *    inside it. Both overlays portal to <body> for stacking, but React synthetic
 *    events still bubble through the component tree — inside a chip that is a
 *    dnd-kit sortable activator, a pointerdown in the menu would arm a drag of
 *    the whole folder.
 */
import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { ProjectPickerFlyout } from './TaskKebabMenu';
import { useCursorFlyout } from './CursorFlyout';
import { buildFolderMenuItems, type FolderMenuActions, type FolderMenuTarget } from './folder-menu-items';

export type { FolderMenuActions, FolderMenuTarget };

export interface FolderContextMenuHandle {
  /** `onContextMenu={(e) => menu.open(e, target)}` on the folder row. */
  open: (event: ReactMouseEvent, target: FolderMenuTarget) => boolean;
  /** The row's "···" button: the same menu, anchored under the button, because a
   *  keyboard press carries no pointer position. */
  openFrom: (event: ReactMouseEvent<HTMLElement>, target: FolderMenuTarget) => void;
  /** Render as a SIBLING of the row (see the note above). */
  node: ReactNode;
}

export function useFolderContextMenu(actions: FolderMenuActions): FolderContextMenuHandle {
  // `ignorePressSelection`: WebKit (the Mac app) selects the word under a right-press, and a selection the
  // press made itself must not hand the gesture to the native menu (it did: the folder name never opened this).
  const menu = useContextMenu<FolderMenuTarget>({ ignorePressSelection: true });
  // The picker keeps its own copy of the target + the cursor point (in state, so it stays
  // referentially stable for `useMenuPlacement`) because the menu has closed by the time it opens.
  const picker = useCursorFlyout<FolderMenuTarget>();
  const { onMoveToProject } = actions;

  const open = menu.state;
  const node = (
    <>
      {open && (
        <ContextMenu
          point={open.point}
          items={buildFolderMenuItems(open.payload, actions, (target) => picker.open(target, open.point))}
          onClose={menu.close}
          ariaLabel={`Folder actions for ${open.payload.label || 'folder'}`}
          testId="folder-ctx-menu"
        />
      )}
      {picker.state && (
        <ProjectPickerFlyout
          open
          anchorRef={picker.noTrigger}
          anchorPoint={picker.state.point}
          align="left"
          current={picker.state.payload.project ?? null}
          onPick={(name) => {
            // Re-picking the folder's own project is a dismiss, not a move.
            const { payload } = picker.state!;
            if (name !== payload.project) onMoveToProject?.(payload.groupId, name);
          }}
          onClose={picker.close}
        />
      )}
    </>
  );

  const openFrom = (event: ReactMouseEvent<HTMLElement>, target: FolderMenuTarget) => {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    menu.open({
      target: button,
      currentTarget: button,
      clientX: rect.left,
      clientY: rect.bottom,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    } as unknown as MouseEvent, target);
  };

  return { open: menu.open, openFrom, node };
}
