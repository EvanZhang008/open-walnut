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
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { useProjectActions } from '@/hooks/useProjectActions';
import type { SortBy } from './ViewDropdown';
import {
  buildProjectMenuItems, PROJECT_SORT_OPTIONS,
  type ProjectMenuActions, type ProjectMenuTarget,
} from './project-menu-items';

import { OptionPickerFlyout, useCursorFlyout } from './CursorFlyout';
import { ProjectPickerFlyout } from './TaskKebabMenu';
import { useBulkTaskSettings } from './BulkTaskSettings';

export {
  buildProjectMenuItems, PROJECT_SORT_OPTIONS,
  type ProjectMenuActions, type ProjectMenuDialogs, type ProjectMenuTarget, type ProjectSettingRows,
} from './project-menu-items';

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

export function useProjectContextMenu(actions: ProjectMenuActions): ProjectContextMenuHandle {
  const menu = useContextMenu<ProjectMenuTarget>({ ignorePressSelection: true });
  const { busy, rename, mergeInto, remove } = useProjectActions({ onChanged: actions.onChanged });
  // The pickers outlive the menu that opened them (running a row closes the menu).
  const sortPicker = useCursorFlyout<{ project: string; current: SortBy }>();
  const projectPicker = useCursorFlyout<string>();
  const settings = useBulkTaskSettings();

  const open = menu.state;
  const node = (
    <>
      {open && (
        <ContextMenu
          point={open.point}
          items={buildProjectMenuItems(open.payload, actions, {
            busy,
            rename: (project) => { void rename(project); },
            remove: (project) => { void remove(project); },
            pickSort: (project, current) => sortPicker.open({ project, current }, open.point),
            pickProject: (project) => projectPicker.open(project, open.point),
          }, settings.rows({ kind: 'project', project: open.payload.project }, open.point))}
          onClose={menu.close}
          returnFocus={open.origin}
          ariaLabel={`Project actions for ${open.payload.project || 'Inbox'}`}
          testId="project-ctx-menu"
        />
      )}
      {sortPicker.state && (
        <OptionPickerFlyout
          anchorPoint={sortPicker.state.point}
          anchorRef={sortPicker.noTrigger}
          options={PROJECT_SORT_OPTIONS.map(([value, label]) => ({ value, label }))}
          current={sortPicker.state.payload.current}
          ariaLabel={`Sort tasks of ${sortPicker.state.payload.project || 'Inbox'}`}
          onPick={(sort) => actions.onSetSort?.(sortPicker.state!.payload.project, sort)}
          onClose={sortPicker.close}
        />
      )}
      {projectPicker.state && (
        <ProjectPickerFlyout
          open
          anchorRef={projectPicker.noTrigger}
          anchorPoint={projectPicker.state.point}
          align="left"
          current={projectPicker.state.payload}
          onPick={(name) => {
            const from = projectPicker.state!.payload;
            // Inbox is not a project to merge into, and re-picking this project is a dismiss.
            if (name && name.toLowerCase() !== from.toLowerCase()) void mergeInto(from, name);
          }}
          onClose={projectPicker.close}
        />
      )}
      {settings.node}
    </>
  );

  return { open: (event, target) => {
    if (event.type !== 'click') return menu.open(event, target);
    const rect = event.currentTarget.getBoundingClientRect();
    return menu.open({
      ...event, clientX: rect.right, clientY: rect.bottom,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    }, target);
  }, node, busy };
}
