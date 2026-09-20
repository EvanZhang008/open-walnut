/**
 * useMailFolderContextMenu: ONE right-click menu for the three kinds of row the left pane draws, a
 * provider folder, the virtual Drafts row, and a smart row.
 *
 * One hook with a `kind` branch rather than three, because the rows share everything that is easy to
 * get wrong: the gesture is the same, the dismissal is the shared primitive's, and the target is
 * always a pair read off the ROW rather than off the selection. What differs is only the item list,
 * which lives next door as pure data (`mail-folder-context-items.ts`).
 *
 * Two things it is careful about:
 *
 *  · `node` is rendered as a SIBLING of the row, never inside it. Both halves portal to <body> for
 *    stacking, but React synthetic events still travel the component tree, and the rows here are
 *    `<button>`s inside a `<li>` whose own `onContextMenu` opened this menu: a pointerdown inside
 *    the menu would otherwise reach that handler again.
 *  · The items are rebuilt on every render from the live store and the live preferences, so the
 *    unread switch's label is this frame's answer for this pair. A list frozen at open time is how a
 *    menu ends up promising the opposite of what it does.
 *
 * No `overrideLinks`: the native menu's own rules (a live selection, a link, an image, an editable
 * field) come from `keepNativeContextMenu` and are not restated here.
 */
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { DRAFTS_MAILBOX, SMART_ACCOUNT, pairKey } from './mail-store';
import {
  draftsMenuItems,
  folderMenuItems,
  smartMenuItems,
  type DraftsMenuTarget,
  type FolderMenuTarget,
  type SmartMenuTarget,
} from './mail-folder-context-items';

/**
 * Which row was right-clicked.
 *
 * A smart row's account child is a `folder` payload with that child's own pair, EXCEPT under All
 * Drafts, where the child pair is the reserved `__walnut_drafts__` and the row is a Drafts row: it
 * gets the `drafts` payload. That branch is why this is one hook (see `MailSmartRows`).
 */
export type MailFolderMenuPayload =
  | { kind: 'folder'; folder: FolderMenuTarget }
  | { kind: 'drafts'; drafts: DraftsMenuTarget }
  | { kind: 'smart'; smart: SmartMenuTarget };

export interface MailFolderMenuHandle {
  /** `onContextMenu={(event) => menu.open(event, payload)}` on the row's `<li>` or line. */
  open: (event: ReactMouseEvent, payload: MailFolderMenuPayload) => boolean;
  /** Render as a SIBLING of the rows (see the note above). */
  node: ReactNode;
  /**
   * The row whose menu is open, for its own `data-ctx-open` mark. Null when closed.
   *
   * The message rows have had this from the start; the sidebar rows had not, so `mail.css`'s
   * `.mail-mailbox[data-ctx-open]` ring was dead code and a folder menu (which lands over the rows
   * below the cursor, with hover frozen by the backdrop) had nothing on screen tying it to its row.
   */
  openKey: string | null;
}

/** The key a payload marks its row with: always the row's own pair, never the selection's. */
export function folderMenuKey(payload: MailFolderMenuPayload): string {
  if (payload.kind === 'folder') return pairKey(payload.folder.accountId, payload.folder.mailboxId);
  if (payload.kind === 'drafts') return pairKey(payload.drafts.accountId, DRAFTS_MAILBOX);
  return pairKey(SMART_ACCOUNT, payload.smart.id);
}

function itemsFor(payload: MailFolderMenuPayload): ContextMenuItem[] {
  if (payload.kind === 'folder') return folderMenuItems(payload.folder);
  if (payload.kind === 'drafts') return draftsMenuItems(payload.drafts);
  return smartMenuItems(payload.smart);
}

const ARIA: Record<MailFolderMenuPayload['kind'], string> = {
  folder: 'Folder actions',
  drafts: 'Drafts actions',
  smart: 'Smart mailbox actions',
};

/** The Drafts row lives in the folder list, so it shares that list's test id. */
const TEST_ID: Record<MailFolderMenuPayload['kind'], string> = {
  folder: 'mail-folder-ctx-menu',
  drafts: 'mail-folder-ctx-menu',
  smart: 'mail-smart-ctx-menu',
};

export function useMailFolderContextMenu(): MailFolderMenuHandle {
  // Same reason as the row menu: WebKit selects the word under a right-press, so a press landing on a
  // folder's own label used to hand the gesture to the browser while one 8px off it opened this menu.
  const menu = useContextMenu<MailFolderMenuPayload>({ ignorePressSelection: true });
  const payload = menu.state?.payload ?? null;
  const node = menu.state && payload ? (
    <ContextMenu
      point={menu.state.point}
      items={itemsFor(payload)}
      onClose={menu.close}
      ariaLabel={ARIA[payload.kind]}
      testId={TEST_ID[payload.kind]}
      // The same fixed measure the row menu uses: these rows carry a folder's own name in their heading,
      // so a content-sized box changed width from one folder to the next.
      className="wn-context-menu-titled"
      // Escape hands the keyboard back to the row, not to <body>. The gesture is on the `<li>`, so the
      // focusable row is inside it (see `returnFocus`).
      returnFocus={menu.state.origin?.querySelector('button') ?? menu.state.origin}
    />
  ) : null;
  return { open: menu.open, node, openKey: payload ? folderMenuKey(payload) : null };
}
