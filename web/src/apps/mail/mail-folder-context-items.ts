/**
 * The LEFT pane's right-click menus, as data: a folder row, a Drafts row, a smart row.
 *
 * Pure on purpose, and separate from the component that draws them, because every rule worth
 * arguing about here is a rule about WORDS and about which rows exist at all: the label states what
 * it will do to THAT pair, and an action the console cannot perform on this row is not drawn. Both
 * are pinned without a browser (`tests/web/mail-folder-context-items.test.ts`).
 *
 * Three rules this file encodes, each one a thing that shipped wrong somewhere before:
 *
 *  · NO DEAD CONTROLS. `Fetch this folder now` is omitted for every reserved id (the virtual Drafts
 *    row and the three smart rows), because `/mailboxes/fetch` takes a real (accountId, mailboxId)
 *    and answers a reserved one with `unknown-mailbox`: a control that is drawn and then always
 *    fails is worse than one that was never there.
 *  · The unread switch reads THAT pair's own preference (`readUnreadOnly(accountId, mailboxId)`),
 *    never the selection's and never a fixed word. Right-clicking a folder you are not in is the
 *    normal case here, so a label built from the selection describes the wrong folder.
 *  · The sentences for a fetch live HERE, not in the store. `mail-actions` deliberately keeps the
 *    plugin's own reason word (`replica` / `stopped` / `unknown-mailbox` / `failed`) and no prose,
 *    so the three that are ANSWERS rather than failures can be worded as answers.
 */
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import {
  fetchMailboxNow,
  requestMailRefresh,
  selectMailbox,
  selectSmartMailbox,
  setMailUnreadOnly,
} from './mail-actions';
import { openMailComposer } from './compose/compose-actions';
import { readUnreadOnly } from './mail-unread-filter';
import {
  DRAFTS_MAILBOX,
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  SMART_SENT,
  type SmartMailboxId,
} from './mail-store';
import type { SmartPrefId } from './mail-sidebar-prefs';

/** One provider folder, which is what a folder row and a smart row's child row both are. */
export interface FolderMenuTarget {
  accountId: string;
  mailboxId: string;
  /** The folder's display name (`folderLabel`), which is the only name it has. */
  label: string;
  /** This account's display name, said out loud only when more than one account is listed. */
  accountName: string;
  manyAccounts: boolean;
  /** This account keeps folders behind its collapse row, so the tail switch has something to do. */
  hasTail: boolean;
  tailExpanded: boolean;
  onToggleTail?: (accountId: string, on: boolean) => void;
  /**
   * The pane's watcher, handed the fetch's own promise.
   *
   * The store records a fetch WHILE it runs and removes the entry when the rows land, so "it worked"
   * is a transition and not a state. The pane needs that transition to write one sentence naming the
   * folder, and the promise is the only honest signal for it: reading the map after it settles tells
   * an absent key (fetched) apart from a `running` or `failed` one.
   */
  onFetchAsked?: (accountId: string, mailboxId: string, answer: Promise<void>) => void;
}

/** The virtual Drafts row: this console's own drafts plus whatever the provider's folder holds. */
export interface DraftsMenuTarget {
  accountId: string;
  /** This account's display name, said out loud only when more than one account is listed. */
  accountName?: string;
  manyAccounts?: boolean;
}

/** One smart row (All Inboxes / All Sent / All Drafts). */
export interface SmartMenuTarget {
  id: SmartMailboxId;
  pref: SmartPrefId;
  /** The row's own words on screen (`All Inboxes`), which is what its heading has to say. */
  label: string;
  /** Whether this row's account children are showing, which words the third item. */
  open: boolean;
  onToggle: (pref: SmartPrefId, on: boolean) => void;
}

/** Every id the fetch route cannot be asked for. */
const RESERVED_IDS = new Set<string>([DRAFTS_MAILBOX, SMART_INBOX, SMART_SENT, SMART_DRAFTS]);

/** Whether this pair is a real provider folder, and therefore fetchable. */
export function fetchableFolder(accountId: string, mailboxId: string): boolean {
  if (!accountId || !mailboxId) return false;
  return accountId !== SMART_ACCOUNT && !RESERVED_IDS.has(mailboxId);
}

/** The `info` heading: which folder this menu is about, and whose it is when that is a question. */
function folderHeading(target: FolderMenuTarget): string {
  const label = target.label || target.mailboxId;
  return target.manyAccounts && target.accountName ? `${label} · ${target.accountName}` : label;
}

/**
 * A folder row's menu.
 *
 * Order is argued in the spec and worth restating: `Open this folder` first because a right-click
 * deliberately does NOT open the row, so the menu owes it as an item; the fetch second because it is
 * the one action here that is useful WITHOUT moving the selection; the account-wide tail switch last,
 * behind a divider, because it is a view preference about the whole account rather than this folder.
 */
export function folderMenuItems(target: FolderMenuTarget): ContextMenuItem[] {
  const { accountId, mailboxId } = target;
  const heading = folderHeading(target);
  // THIS pair's own preference. The selection is usually a different folder.
  const unreadOnly = readUnreadOnly(accountId, mailboxId);
  return [
    { key: 'who', info: true, label: heading, title: heading },
    {
      key: 'open',
      label: 'Open this folder',
      onSelect: () => { selectMailbox(accountId, mailboxId); },
    },
    {
      key: 'fetch',
      label: 'Fetch this folder now',
      when: fetchableFolder(accountId, mailboxId),
      onSelect: () => {
        const answer = fetchMailboxNow(accountId, mailboxId);
        target.onFetchAsked?.(accountId, mailboxId, answer);
      },
    },
    {
      key: 'unread',
      label: unreadOnly ? 'Show everything in this folder' : 'Show only unread in this folder',
      onSelect: () => { void setMailUnreadOnly(accountId, mailboxId, !unreadOnly); },
    },
    { divider: true },
    {
      key: 'tail',
      label: target.tailExpanded
        ? 'Show fewer folders in this account'
        : 'Show all folders in this account',
      when: target.hasTail && !!target.onToggleTail,
      onSelect: () => { target.onToggleTail?.(accountId, !target.tailExpanded); },
    },
  ];
}

/**
 * The Drafts row's menu: a heading and exactly two items, and never a fetch.
 *
 * The heading is here because the MENU COVERS THE ROW IT IS ABOUT. The backdrop freezes hover and the
 * box lands over the rows below the cursor, so with no heading and no mark on the row nothing on screen
 * named the row being acted on; every account has a Drafts row, so "Open Drafts" does not answer it
 * either. The row's own `data-ctx-open` ring is the other half of that fix.
 */
export function draftsMenuItems(target: DraftsMenuTarget): ContextMenuItem[] {
  const { accountId } = target;
  const heading = target.manyAccounts && target.accountName
    ? `Drafts · ${target.accountName}`
    : 'Drafts';
  return [
    { key: 'who', info: true, label: heading, title: heading },
    {
      key: 'open',
      label: 'Open Drafts',
      onSelect: () => { selectMailbox(accountId, DRAFTS_MAILBOX); },
    },
    {
      key: 'new',
      label: 'New message',
      onSelect: () => { void openMailComposer(accountId); },
    },
  ];
}

/**
 * A smart row's menu.
 *
 * No fetch: a merged list is not a folder, and fetching one of the folders behind it would leave the
 * "not fetched yet" state of every other one standing, which is the button that looks broken.
 * `Check for new mail` is the ordinary sweep, and its own note owner is set inside
 * `requestMailRefresh` (null for a sweep over every account, so the first sync event retires it).
 */
export function smartMenuItems(target: SmartMenuTarget): ContextMenuItem[] {
  // Named for the same reason the folder menu is: the menu covers the rows under the cursor and the
  // backdrop freezes hover, so "Open this list" on its own does not say WHICH of the three lists.
  const heading = target.label || 'This list';
  return [
    { key: 'who', info: true, label: heading, title: heading },
    { key: 'open', label: 'Open this list', onSelect: () => { selectSmartMailbox(target.id); } },
    { key: 'check', label: 'Check for new mail', onSelect: () => { void requestMailRefresh(); } },
    {
      key: 'accounts',
      label: target.open ? 'Hide accounts in this list' : 'Show accounts in this list',
      onSelect: () => { target.onToggle(target.pref, !target.open); },
    },
  ];
}

/**
 * What one folder fetch is doing or has answered, as the console says it.
 *
 * `fetching` and `running` are states; the other five are ANSWERS. The reason words come straight
 * from the plugin (`MailboxFetchResult`), so this is the only place they turn into prose.
 */
export type FolderFetchAnswer =
  | 'fetching'
  | 'running'
  | 'fetched'
  | 'unknown-mailbox'
  | 'stopped'
  | 'replica'
  | 'failed';

/**
 * One or two sentences naming the folder, for the pane line and the row's hover text.
 *
 * TWO sentences only for `failed`, where the second is the provider's own text: a plugin writes that
 * string and nothing here can promise it starts with a capital or ends with a stop, so it is never
 * run on after Walnut's full stop (the same rule the message list already follows).
 *
 * `unknown-mailbox`, `stopped` and `replica` must NOT read as "Walnut could not fetch": they are
 * real answers, and telling somebody the app broke sends them to restart it when the thing to look
 * at is the mail provider (a folder the server stopped listing) or this install (a replica reads
 * only). `failed` is the one worth pressing again, so it is the one that says Walnut could not.
 */
export function folderFetchSentence(
  answer: FolderFetchAnswer,
  folderName: string,
  detail?: string,
): string[] {
  const folder = folderName || 'that folder';
  switch (answer) {
    case 'fetching':
      return [`Fetching ${folder}…`];
    case 'running':
      return [`Still fetching ${folder}.`];
    case 'fetched':
      return [`Fetched ${folder}.`];
    case 'unknown-mailbox':
    case 'stopped':
      return [`${folder} is no longer on the server.`];
    case 'replica':
      return ['This copy of Walnut only reads mail.'];
    default:
      return detail
        ? [`Walnut could not fetch ${folder}.`, detail]
        : [`Walnut could not fetch ${folder}.`];
  }
}

/** The map entry's state plus its reason word, as one answer. An absent entry is not this call. */
export function folderFetchAnswerOf(
  state: 'fetching' | 'running' | 'failed',
  reason?: 'replica' | 'stopped' | 'unknown-mailbox' | 'failed',
): FolderFetchAnswer {
  if (state !== 'failed') return state;
  return reason ?? 'failed';
}
