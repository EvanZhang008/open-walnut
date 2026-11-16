import type { ContextMenuItem } from '@/utils/context-menu';
import type { RegisteredApp } from '@/apps/registry';
import { canOpenAppWindow } from '@/popout/openPopout';

export interface SidebarAppMenuActions {
  openWindow: (app: RegisteredApp) => void;
  keepOnSidebar: (app: RegisteredApp) => void;
  closeOpen: (app: RegisteredApp) => void;
  move: (list: RegisteredApp[], key: string, direction: 'up' | 'down') => void;
  resetOrder: () => void;
  unpin: (app: RegisteredApp) => void;
  hide: (app: RegisteredApp) => void;
  manage: () => void;
}

export interface SidebarAppMenuInput {
  /** The Sidebar's own rows, in the order shown. */
  sidebar: RegisteredApp[];
  /** The Open group (experiment apps_stay_open): apps opened from anywhere, kept until closed. */
  open: RegisteredApp[];
  /** A phone has no windows to open. */
  phone: boolean;
}

/**
 * Right-click on an app icon. The rail is the one surface where "this is in the
 * wrong place" is the obvious thought; the Apps page has the same on/off switch
 * (and reordering lives only here). Ordering acts on the
 * SIDEBAR list, so "up"/"down" mean what the user sees, and the item is dropped
 * at the ends rather than offered as a no-op.
 *
 * Home and Settings carry lockVisibility (they are how you get back to
 * everything else), so unpin/hide never appear for them — the same rule
 * resolveApps already enforces, spelled out here so the menu can't offer an
 * action that would silently do nothing.
 *
 * Every app with a page of its own opens first in a window of its own (popout/openPopout.ts
 * `openAppWindow`), whichever group its row is in.
 */
export function buildSidebarAppMenu(
  app: RegisteredApp,
  { sidebar, open, phone }: SidebarAppMenuInput,
  actions: SidebarAppMenuActions,
): ContextMenuItem[] {
  const head: ContextMenuItem[] = [{ key: 'title', section: true, label: app.title }];
  if (!phone && canOpenAppWindow(app)) {
    head.push(
      {
        key: 'open-window', label: 'Open in new window',
        title: 'Opens this app alone in a window of its own',
        onSelect: () => actions.openWindow(app),
      },
      { divider: true },
    );
  }
  const index = sidebar.findIndex((item) => item.key === app.key);
  if (index === -1 && open.some((item) => item.key === app.key)) {
    return [
      ...head,
      {
        key: 'keep', label: 'Keep on sidebar',
        title: 'Gives the app its own sidebar row, which stays after you close it',
        onSelect: () => actions.keepOnSidebar(app),
      },
      { key: 'close', label: 'Close', onSelect: () => actions.closeOpen(app) },
      { divider: true },
      { key: 'manage', label: 'Manage apps…', onSelect: actions.manage },
    ];
  }
  return [
    ...head,
    {
      key: 'up', label: 'Move up', when: index > 0,
      onSelect: () => actions.move(sidebar, app.key, 'up'),
    },
    {
      key: 'down', label: 'Move down', when: index >= 0 && index < sidebar.length - 1,
      onSelect: () => actions.move(sidebar, app.key, 'down'),
    },
    { key: 'reset-order', label: 'Reset sidebar order', onSelect: actions.resetOrder },
    { divider: true },
    {
      key: 'unpin', label: 'Unpin from sidebar', when: !app.lockVisibility,
      title: 'Keeps the app on the Apps page and in the Command Palette',
      onSelect: () => actions.unpin(app),
    },
    {
      key: 'hide', label: 'Hide app', when: !app.lockVisibility, danger: true,
      onSelect: () => actions.hide(app),
    },
    { divider: true },
    { key: 'manage', label: 'Manage apps…', onSelect: actions.manage },
  ];
}
