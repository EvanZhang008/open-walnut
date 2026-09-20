/**
 * useMailRowContextMenu: the message row's right-click menu, wired to the actions that already exist.
 *
 * Shaped after `useFolderContextMenu`: the hook returns `{ open, node }` and the node is rendered as a
 * SIBLING of the rows rather than inside one. A row is a `<button>`, and React events bubble through a
 * portal into the OWNING tree, so a press inside the menu would reach the row's own handlers.
 *
 * Two rules live here rather than in the items:
 *
 * - THE ROW IS RE-READ FROM THE SNAPSHOT ON EVERY RENDER, by its pair. `useContextMenu` stores the
 *   payload the right-click carried, and a menu is open across syncs and across live events: built from
 *   that frozen copy, the read toggle keeps offering `Mark as read` for a row another device has already
 *   read, and the task row keeps saying `Make a task` for a message that now has one.
 * - A REPLY READS THE BODY FIRST, and no body means NO DRAFT. A reply draft is written to the server the
 *   moment the composer opens, so opening one without the original saves a letter whose quote is the
 *   attribution line and nothing else. `loadMessageBodyForQuote` fetches it without marking anything
 *   read; when it cannot, it names the row in the pane's note and this does not open a composer. An
 *   HTML-ONLY body is not a body-less message: `bodyQuoteText` derives the text from the markup, which
 *   is what the snippet on the row is made of too.
 */
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { copyTextRobust } from '@/utils/clipboard';
import type { MailMessageDto } from '@/api/mail';
import { loadMessageBodyForQuote, openMailMessage, runMailSearch } from './mail-actions';
import { setMailMessageRead } from './mail-read-flag';
import { makeTaskFromMessage } from './mail-task-actions';
import { openMailForwardComposer, openMailReplyComposer } from './compose/compose-actions';
import { getMailSnapshot, pairKey, setMailRowNote, type MailSnapshot } from './mail-store';
import { mailRowLink, messageMenuItems } from './mail-context-items';
import { bodyQuoteText } from './mail-quote-text';

/** The row a right-click landed on. The PAIR, because that is a message's identity. */
export interface MailRowMenuTarget {
  accountId: string;
  messageId: string;
}

export interface MailRowMenuHandle {
  /** `onContextMenu={(e) => menu.open(e, { accountId, messageId })}` on the row. */
  open: (event: ReactMouseEvent, target: MailRowMenuTarget) => boolean;
  /** Render as a SIBLING of the rows (see the note above). */
  node: ReactNode;
  /** The pair whose menu is open, for the row's own `data-ctx-open` mark. Null when closed. */
  openPair: string | null;
}

/** What the list this menu belongs to is: the same three answers every row in one pane shares. */
export interface MailRowMenuView {
  snapshot: MailSnapshot;
  /** A sent or drafts scope. */
  outbound: boolean;
  /** The provider's Drafts folder or the merged Drafts row. */
  draftsView: boolean;
  /** This list mixes accounts, so the menu's title says which one the row belongs to. */
  merged: boolean;
}

export function useMailRowContextMenu(view: MailRowMenuView): MailRowMenuHandle {
  // `ignorePressSelection`: a row's subject and snippet are selectable on purpose (G15), and WebKit
  // selects the word under the pointer as the right-press's own default action, so without this the
  // menu could never open on a row's text in the Mac app. A selection the human made is still theirs.
  const menu = useContextMenu<MailRowMenuTarget>({ ignorePressSelection: true });
  const navigate = useNavigate();
  const { snapshot } = view;
  const target = menu.state?.payload ?? null;
  // Live, by pair. A row that has left the snapshot altogether (the folder was reloaded and dropped
  // it) has nothing left to act on, so the menu renders nothing rather than acting on a stale copy.
  const message = target ? liveRow(snapshot, target) : null;
  // The pair the reader is holding, or null. Live, because the reader can be closed while a menu is open.
  const openPair = snapshot.open ? pairKey(snapshot.open.accountId, snapshot.open.messageId) : null;
  // No `overrideLinks`: the row is a button, not an anchor that exists for routing, so the browser's
  // own menu stays on a real link, an image and a live selection (`keepNativeContextMenu`).

  const quoteText = async (row: MailMessageDto): Promise<string | null> => {
    const open = snapshot.open;
    const held = open && open.accountId === row.accountId && open.messageId === row.messageId
      ? bodyQuoteText(open.body)
      : null;
    if (held) return held;
    return loadMessageBodyForQuote(row.accountId, row.messageId);
  };

  const reply = (row: MailMessageDto, all: boolean) => {
    void (async () => {
      const text = await quoteText(row);
      if (readFailed(row, text)) return;
      const account = snapshot.accounts.find((one) => one.accountId === row.accountId);
      await openMailReplyComposer({
        accountId: row.accountId,
        accountAddress: account?.address ?? '',
        message: row,
        ...(text ? { bodyText: text } : {}),
        all,
      });
    })();
  };

  const forward = (row: MailMessageDto) => {
    void (async () => {
      const text = await quoteText(row);
      if (readFailed(row, text)) return;
      await openMailForwardComposer({
        accountId: row.accountId,
        message: row,
        ...(text ? { bodyText: text } : {}),
      });
    })();
  };

  const copyLink = (row: MailMessageDto) => {
    const link = mailRowLink(row.accountId, row.messageId, window.location.origin);
    const pair = pairKey(row.accountId, row.messageId);
    void copyTextRobust(link).then((how) => {
      // The link itself rides in the failed sentence: the clipboard is the only thing that broke, and
      // a link on screen can still be selected by hand.
      if (how === 'failed') setMailRowNote(`Walnut could not copy the link. ${link}`, pair);
      else setMailRowNote('Link copied.', pair);
    });
  };

  const node = menu.state && message ? (
    <ContextMenu
      point={menu.state.point}
      items={messageMenuItems({
        message,
        providers: snapshot.providers,
        accounts: snapshot.accounts,
        outbound: view.outbound,
        draftsView: view.draftsView,
        merged: view.merged,
        // Live, not frozen at the right-click: the reader can be closed while a menu is open, and the
        // sentence about closing it has to go with it.
        readerOpen: snapshot.open !== null,
        // Compared as PAIRS (`pairKey`), never one id at a time: comparing a message id on its own is
        // the shape that let a read flip land on another account's row, and a ratchet keeps it out of
        // this directory (spec 9.2).
        readerHasRow: openPair !== null && openPair === pairKey(message.accountId, message.messageId),
        actions: {
          onSetRead: (row, read) => { void setMailMessageRead(row, read); },
          onOpen: (row) => { void openMailMessage(row.accountId, row.messageId); },
          onReply: reply,
          onForward: forward,
          onMakeTask: (row) => { void makeTaskFromMessage(row.accountId, row.messageId); },
          onOpenTask: (taskId) => { navigate(`/tasks/${taskId}`); },
          onSearchSender: (address) => { void runMailSearch(address); },
          onCopyLink: copyLink,
        },
      })}
      onClose={menu.close}
      ariaLabel="Message actions"
      testId="mail-row-ctx-menu"
      // ONE width for every row of one list: the heading names the message, so a content-sized box
      // moved its own edge by up to 105px between two right-clicks in the same triage pass.
      className="wn-context-menu-titled"
      // Escape puts the keyboard back on the row it started from, not on <body>.
      returnFocus={menu.state.origin}
    />
  ) : null;

  return {
    open: menu.open,
    node,
    openPair: target ? pairKey(target.accountId, target.messageId) : null,
  };
}

/**
 * Did the body read FAIL, as opposed to answering with a message that has no plain-text part?
 *
 * The two arrive as the same `null`, and they need opposite answers. A failure must not open a
 * composer at all (the draft is written the moment it opens, so the wrong thing would be stored), and
 * `loadMessageBodyForQuote` has already named the row in the pane's note. A message that really holds no
 * words (no text half, and markup that extracted to nothing) is not a failure: the composer opens with
 * the attribution line, which is what the reader's own Reply does there too.
 *
 * The note is the signal because it is the only one the read leaves behind: its success path CLEARS
 * the note, and its failure path sets one for this pair.
 */
function readFailed(row: MailMessageDto, text: string | null): boolean {
  if (text !== null) return false;
  const note = getMailSnapshot().rowNote;
  return !!note && note.pair === pairKey(row.accountId, row.messageId);
}

/** The row the snapshot holds for that pair, from the page or from the search results. */
function liveRow(snapshot: MailSnapshot, target: MailRowMenuTarget): MailMessageDto | null {
  const matches = (one: MailMessageDto) =>
    one.accountId === target.accountId && one.messageId === target.messageId;
  return snapshot.messages.find(matches) ?? snapshot.search.messages.find(matches) ?? null;
}
