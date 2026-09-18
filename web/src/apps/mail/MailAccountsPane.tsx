/**
 * The left pane: the smart mailboxes, every account with its folders, and the controls that change
 * the set. The two lists themselves live next door (`MailSmartRows`, `MailAccountFolders`); this file
 * is the shell, the preferences, and the one rule that is easy to get wrong.
 *
 * That rule is REFLOW SUSPENSION. Rows move on their own here: a folder that receives mail during a
 * session is lifted out of the collapsed tail, and the clock decides when (a poll is every two minutes
 * and one account has 64 folders). The collapse row and the Drafts row right above it are the most
 * aimed-at targets in this pane, so an insertion landing between `pointerdown` and `click` makes a
 * person open a folder they did not choose. While the pointer or the focus is inside the pane, row
 * insertions, removals and moves are HELD: the numbers keep moving (they are what tell you something
 * arrived), only the geometry stands still, and the held shape lands on `pointerleave`, on the next
 * selection change, or after an idle gap. No flash, no "new mail" marker: the badges already said it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import type { MailAccountDto, MailDraftDto, MailProviderSummary, MailboxDto } from '@/api/mail';
import { ContextMenu } from '@/components/common/ContextMenu';
import {
  getMailSnapshot,
  isSmartSelection,
  pairKey,
  selectionKey,
  subscribeMail,
  type MailSelection,
} from './mail-store';
import { requestMailRefresh } from './mail-actions';
import { sendMailDigest } from './mail-task-actions';
import { openMailComposer } from './compose/compose-actions';
import { CANNOT_SEND_TITLE, canSendFrom } from './compose/send-status';
import {
  draftsRowCount,
  draftsTotalCount,
  smartUnread,
  sendableAccountFor,
  type SmartRole,
} from './mail-smart';
import {
  readSidebarPrefs,
  writeSmartExpanded,
  writeTailExpanded,
  type SidebarPrefs,
  type SmartPrefId,
} from './mail-sidebar-prefs';
import { MailSmartRows } from './MailSmartRows';
import { MailAccountFolders } from './MailAccountFolders';
import { ComposeIcon, RefreshIcon } from './mail-icons';

interface Props {
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  drafts: Record<string, MailDraftDto[]>;
  providers: MailProviderSummary[];
  selected: MailSelection | null;
  refreshing: boolean;
  refreshNote: string | null;
  onAddAccount: () => void;
  /** A narrow viewport drills back to the list once a mailbox is picked. */
  onPicked: () => void;
}

/** How long a still pointer inside the pane counts as aiming at something. */
const IDLE_MS = 2_500;

/**
 * Where a menu opened from a BUTTON belongs.
 *
 * The cursor when there was one, and the button's own bottom-left corner when there was not. A click
 * synthesized by the keyboard (Enter or Space on a focused button) carries `clientX`/`clientY` of
 * zero, and a menu anchored on that lands in the corner of the window, nowhere near the control that
 * opened it.
 */
function menuPointFor(event: ReactMouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.clientX > 0 || event.clientY > 0) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

interface Aim {
  /** True while somebody is pointing at or tabbing through the pane and has not gone idle. */
  busy: boolean;
  handlers: {
    onPointerEnter: () => void;
    onPointerMove: () => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
    onPointerCancel: () => void;
    onClick: () => void;
    onFocus: () => void;
    onBlur: (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => void;
  };
}

/**
 * Whether this pane is being aimed at, and the handlers that decide it.
 *
 * A press is its own state and outranks the idle timer: between `pointerdown` and `click` nothing may
 * move, however long the button is held. Focus counts too, because Tab through 29 rows is the same
 * problem for anyone not using a mouse.
 */
function useAim(): Aim {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMove = useRef(0);

  const arm = () => {
    setIdle(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return {
    busy: ((pointer || focus) && !idle) || pressing,
    handlers: {
      onPointerEnter: () => { setPointer(true); arm(); },
      // Throttled: a move only matters as proof the pointer is still hunting.
      onPointerMove: () => {
        const now = Date.now();
        if (now - lastMove.current < 250) return;
        lastMove.current = now;
        arm();
      },
      onPointerLeave: () => { setPointer(false); setPressing(false); },
      onPointerDown: () => { setPressing(true); arm(); },
      onPointerCancel: () => setPressing(false),
      onClick: () => setPressing(false),
      onFocus: () => { setFocus(true); arm(); },
      onBlur: (event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setFocus(false);
      },
    },
  };
}

/**
 * The row shape to render: the current one, or the last one that landed while nobody was aiming.
 *
 * Both halves are store objects with stable identities, so the effect only runs when one of them
 * really changed, and `setHeld` returns the previous object when nothing did: holding a freshly built
 * object here instead would re-render forever.
 */
function useHeldRows(
  mailboxes: Record<string, MailboxDto[]>,
  arrivals: Record<string, number>,
  busy: boolean,
  release: number,
): { mailboxes: Record<string, MailboxDto[]>; arrivals: Record<string, number> } {
  const [held, setHeld] = useState({ mailboxes, arrivals });
  const landed = useRef(release);
  useEffect(() => {
    // A PERSON'S pick is a release: they just told the pane what they wanted, so the row they are
    // looking at has to be one that is really there. Counted picks, not the selection key, because the
    // console also picks a row by itself as the folder lists land (`applySelection(auto)`): that key
    // change released the hold mid-hover and let a row move under a resting pointer, which is the very
    // thing the hold exists to stop (it showed up as this spec passing alone and failing in a batch,
    // where the automatic pick lands later).
    if (busy && release === landed.current) return;
    landed.current = release;
    setHeld((prev) => (
      prev.mailboxes === mailboxes && prev.arrivals === arrivals ? prev : { mailboxes, arrivals }
    ));
  }, [mailboxes, arrivals, busy, release]);
  return held;
}

export function MailAccountsPane({
  accounts, mailboxes, drafts, providers, selected, refreshing, refreshNote, onAddAccount, onPicked,
}: Props) {
  const aim = useAim();
  // `arrivals` is session churn nothing else in the console renders, so it is read from the store here
  // rather than threaded through the app shell.
  const snapshot = useSyncExternalStore(subscribeMail, getMailSnapshot);
  const arrivals = snapshot.arrivals;
  const identities = snapshot.identities;
  const held = useHeldRows(mailboxes, arrivals, aim.busy, snapshot.picks);

  const accountIds = accounts.map((one) => one.accountId);
  const idsKey = accountIds.join(' ');
  // One read of one key. Re-read when the account set changes, which is also when the stored blob is
  // pruned of the accounts that no longer exist.
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => readSidebarPrefs([]));
  useEffect(() => { setPrefs(readSidebarPrefs(idsKey ? idsKey.split(' ') : [])); }, [idsKey]);
  // The "opened lately" list is written by the selection (see `noteRecentFolder`), so the pane has to read
  // it again when the selection changes. Read only at mount it was one selection behind, which nothing
  // showed while a new-mail arrival was also holding the row out; once opening a folder spends that arrival
  // (see `arrivalsAfterOpen`), a label lifted out for new mail vanished from the pane the moment the person
  // opened it and moved on. Same object when the list has not changed, so this cannot loop.
  const selectedKey = selected ? selectionKey(selected) : '';
  useEffect(() => {
    setPrefs((prev) => {
      const recent = readSidebarPrefs(idsKey ? idsKey.split(' ') : []).recent;
      return JSON.stringify(recent) === JSON.stringify(prev.recent) ? prev : { ...prev, recent };
    });
  }, [selectedKey, idsKey]);

  // Memory first, storage second: a browser that refuses to keep the preference still expands the row.
  const toggleSmart = (id: SmartPrefId, on: boolean) => {
    setPrefs((prev) => {
      const smart = { ...prev.smart };
      if (on) smart[id] = 1; else delete smart[id];
      return { ...prev, smart };
    });
    try { writeSmartExpanded(accountIds, id, on); } catch { /* the row is already open */ }
  };
  const toggleTail = (accountId: string, on: boolean) => {
    setPrefs((prev) => {
      const tail = { ...prev.tail };
      if (on) tail[accountId] = 1; else delete tail[accountId];
      return { ...prev, tail };
    });
    try { writeTailExpanded(accountIds, accountId, on); } catch { /* the tail is already open */ }
  };

  const live = useMemo(() => {
    const map: Record<string, MailboxDto> = {};
    for (const [accountId, rows] of Object.entries(mailboxes)) {
      for (const row of rows) map[pairKey(accountId, row.mailboxId)] = row;
    }
    return map;
  }, [mailboxes]);
  const unread = useMemo<Record<SmartRole, number>>(() => ({
    inbox: smartUnread(mailboxes, 'inbox'),
    sent: smartUnread(mailboxes, 'sent'),
    drafts: smartUnread(mailboxes, 'drafts'),
  }), [mailboxes]);
  // ONE derivation of the Drafts badge, for the per-account rows and the All Drafts row: the drafts
  // written in this console, which is the first section of the view each of them opens and therefore a
  // number a person can check by counting rows (see `draftsRowCount`).
  const draftsCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const account of accounts) {
      map[account.accountId] = draftsRowCount(drafts[account.accountId]);
    }
    return map;
  }, [accounts, drafts]);
  const draftsTotal = useMemo(() => draftsTotalCount(drafts, accounts), [drafts, accounts]);

  // The compose entry point belongs to the SELECTED account, and whether it may send is that ACCOUNT's
  // own capability when the server sent one, the provider's otherwise. A SMART selection has no account,
  // and reading its reserved id as an identity turned the pane's primary button grey in what is now the
  // default view, under a sentence about an account that does not exist: it resolves to a real account
  // that can send, and the button says which one.
  const landedAccounts = accounts.filter((one) => held.mailboxes[one.accountId] !== undefined);
  const smart = isSmartSelection(selected);
  // `identities` is what this session has just read from or sent as, so New message from a merged list
  // writes as the account whose mail is on screen instead of as whichever account is listed first.
  const composeAccount = smart
    ? sendableAccountFor(accounts, providers, identities)
    : selected?.accountId;
  const canCompose = canSendFrom(providers, composeAccount ?? undefined, accounts);
  const identity = accounts.find((one) => one.accountId === composeAccount);
  const composeTitle = !composeAccount || !canCompose
    ? CANNOT_SEND_TITLE
    : (smart && identity
      ? `Write a new message as ${identity.displayName || identity.address}`
      : 'Write a new message');

  // A portalled menu, so one more pane action costs no width in a head that already holds two
  // controls. See web/src/AGENTS.md: placement, portalling and dismissal are the shared component's,
  // never hand-rolled here.
  //
  // The point is held here rather than taken from `useContextMenu`, which reads it straight off the
  // event: keyboard activation of a button reports the pointer at 0,0, so the menu opened in the
  // top-left corner of the window for anyone who reached the control with Enter or Space. See
  // `menuPointFor`. In state, not a ref, because `useMenuPlacement` takes the point as a dependency
  // and needs it to be referentially stable across renders.
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);

  return (
    <aside className="mail-accounts-pane" data-testid="mail-accounts-pane" {...aim.handlers}>
      {/* No pane title: the folders are directly below and name themselves, and the 232px head has
          three controls to fit. The primary action gets the room instead. */}
      <div className="mail-pane-head">
        <button
          type="button"
          className="mail-compose-new"
          data-testid="mail-compose-new"
          title={composeTitle}
          disabled={!composeAccount || !canCompose}
          onClick={() => { if (composeAccount) void openMailComposer(composeAccount); }}
        >
          <ComposeIcon />
          New message
        </button>
        <button
          type="button"
          className="mail-icon-btn"
          data-testid="mail-refresh"
          title="Check every account for new mail"
          aria-label="Refresh"
          disabled={refreshing}
          onClick={() => { void requestMailRefresh(); }}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="mail-icon-btn"
          data-testid="mail-pane-menu"
          title="More mail actions"
          aria-label="More mail actions"
          aria-haspopup="menu"
          onClick={(event) => { setMenuPoint(menuPointFor(event)); }}
        >
          <span className="mail-overflow-glyph" aria-hidden="true">···</span>
        </button>
      </div>

      {menuPoint && (
        <ContextMenu
          point={menuPoint}
          ariaLabel="Mail actions"
          testId="mail-pane-menu-popup"
          onClose={() => setMenuPoint(null)}
          items={[
            {
              key: 'digest',
              label: 'Send digest now',
              title: 'One letter listing what is unread, sent now as well as at its usual time',
              onSelect: () => { void sendMailDigest(); },
            },
          ]}
        />
      )}

      {refreshNote && (
        <p className="mail-refresh-note" data-testid="mail-refresh-note">{refreshNote}</p>
      )}

      <div className="mail-accounts-scroll">
        <MailSmartRows
          /* Only accounts whose folder list has LANDED. A smart row stands for a set of folders, and
             during the first paint that set is not known yet: drawn from the account list alone, the
             group appears for a moment with one account's mail behind it and then rearranges. An
             account whose folder read failed is left out for the same reason. */
          accounts={landedAccounts}
          mailboxes={held.mailboxes}
          live={live}
          unread={unread}
          draftsCounts={draftsCounts}
          draftsTotal={draftsTotal}
          selected={selected}
          expanded={prefs.smart}
          onToggle={toggleSmart}
          onPicked={onPicked}
        />
        {accounts.map((account) => (
          <MailAccountFolders
            key={account.accountId}
            account={account}
            rows={held.mailboxes[account.accountId] ?? []}
            live={live}
            draftsCount={draftsCounts[account.accountId] ?? 0}
            selected={selected}
            arrivals={held.arrivals}
            recent={prefs.recent[account.accountId] ?? []}
            expanded={prefs.tail[account.accountId] === 1}
            onToggleTail={toggleTail}
            onPicked={onPicked}
          />
        ))}
      </div>

      <button
        type="button"
        className="mail-add-account"
        data-testid="mail-add-account"
        onClick={onAddAccount}
      >
        + Add account
      </button>
    </aside>
  );
}
