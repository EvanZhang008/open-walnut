/**
 * The folder right-click menu's rows, with no React component in the import graph so the gating
 * (which handlers a surface passes, project known or still loading) is testable as a plain function.
 * The hook that draws them is `useFolderContextMenu` in FolderContextMenu.tsx.
 */
import type { ContextMenuItem } from '@/utils/context-menu';

/** The folder a right-click landed on. */
export interface FolderMenuTarget {
  groupId: string;
  label: string;
  /** Owning project ('' = Inbox). undefined = not known yet → the Project row
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

/** The setting rows a folder shares with the task menu, built from its open tasks (`useBulkTaskSettings`). */
export interface FolderSettingRows {
  pinned: ContextMenuItem[];
  fields: ContextMenuItem[];
}

/**
 * The row list for one right-clicked folder — module scope and exported so the gating
 * (which handlers a surface passes, project known or still loading) is testable as a plain
 * function. `openProjectPicker` is the one side effect a row can have. The settings group reads
 * like the task menu's: Pinned, Project, then each plugin field (Sprint).
 */
export function buildFolderMenuItems(
  target: FolderMenuTarget,
  actions: FolderMenuActions,
  openProjectPicker: (target: FolderMenuTarget) => void,
  settings: FolderSettingRows = { pinned: [], fields: [] },
): ContextMenuItem[] {
  const { onRename, onToggleCollapse, onMoveToProject, onHide, onDelete } = actions;
  return [
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
    ...settings.pinned,
    {
      // A row that VANISHES is indistinguishable from "this surface doesn't
      // support moving", so an unknown project shows the row DISABLED with the
      // reason instead: the folder registry fetch simply hasn't landed yet.
      key: 'move-project',
      label: 'Project',
      value: target.project === undefined ? '…' : (target.project || 'Inbox'),
      when: !!onMoveToProject,
      disabled: target.project === undefined,
      title: target.project === undefined ? 'Folder project still loading' : undefined,
      onSelect: () => { if (target.project !== undefined) openProjectPicker(target); },
    },
    ...settings.fields,
    { divider: true },
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
}
