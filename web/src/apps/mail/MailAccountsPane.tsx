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
import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { MailAccountDto, MailDraftDto, MailProviderSummary, MailboxDto } from '@/api/mail';
import { ContextMenu } from '@/components/common/ContextMenu';
import {
  ANSWER_MS,
  clearMailPaneNote,
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
  folderFetchAnswerOf,
  folderFetchSentence,
  type FolderFetchAnswer,
} from './mail-folder-context-items';
import {
  readSidebarPrefs,
  writeSmartExpanded,
  writeTailExpanded,
  type SidebarPrefs,
  type SmartPrefId,
} from './mail-sidebar-prefs';
import { syncLineFor } from './mail-sync-line';
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
 * How often the footer's relative time is recomputed. Zero requests: it is arithmetic on a number the
 * mailbox rows already carry.
 */
export const SYNC_TICK_MS = 30_000;

/**
 * A clock this pane can read, ticking every 30 s.
 *
 * PANE-LOCAL, deliberately not a counter in the mail store: a store field wakes every subscriber that
 * calls `useSyncExternalStore`, which is the three panes plus the sidebar badge, so a footer nobody is
 * looking at would re-render the whole console twice a minute. Here it re-renders exactly the component
 * that prints the sentence, and only while the pane is mounted.
 */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

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

/**
 * One sentence per folder this pane has fetched by hand, newest last.
 *
 * A LIST, not a string. Two fetches started a few seconds apart are two answers, and a single slot
 * showed whichever landed last while the other row still carried a dot nobody could read. Capped,
 * because this is a note and not a log.
 *
 * Deliberately NOT `refreshNote`: `clearRefreshNoteFor` wipes that on ANY account's sync-completed,
 * and a successful fetch is immediately followed by exactly that event, so the sentence would blink
 * out as it appeared (and an unrelated account's sync would take it down too).
 */
const FETCH_NOTES = 3;

interface FetchNote {
  key: string;
  accountId: string;
  mailboxId: string;
  state: FolderFetchAnswer;
  detail?: string;
}

/**
 * How long a SETTLED fetch sentence stays up, and it is the row note's constant, not one of its own.
 *
 * The two answer channels used to disagree (a row's answer lived 12s, a folder's 30s) about how long
 * an answer to the same gesture lasts. The same split applies in both: an answer retires itself, an
 * outcome somebody may have to act on (`failed`, `replica`, `stopped`, `unknown-mailbox`) stays until
 * it is dismissed or the selection changes.
 */
const FETCH_NOTE_MS = ANSWER_MS;

/** Which answers wait to be dismissed rather than retiring on the clock. */
function stickyAnswer(state: FolderFetchAnswer): boolean {
  return state !== 'fetched' && state !== 'fetching';
}

function useFolderFetchNotes(selection: string): {
  notes: FetchNote[];
  watch: (accountId: string, mailboxId: string, answer: Promise<void>) => void;
  dismiss: () => void;
} {
  const [notes, setNotes] = useState<FetchNote[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { for (const one of timers.current) clearTimeout(one); }, []);
  // An answer about a folder is about the screen it was asked from: opening another folder is the
  // person moving on, and a sentence that outlives that is a log.
  useEffect(() => { setNotes([]); }, [selection]);
  const watch = useCallback((accountId: string, mailboxId: string, answer: Promise<void>) => {
    const key = pairKey(accountId, mailboxId);
    const started: FetchNote = { key, accountId, mailboxId, state: 'fetching' };
    setNotes((prev) => [...prev.filter((one) => one.key !== key), started].slice(-FETCH_NOTES));
    // The store keeps an entry WHILE a fetch runs and removes it when the rows land, so success is a
    // transition: read the map once the call settles, and an absent key is the one that worked.
    void answer.then(() => {
      const entry = getMailSnapshot().folderFetch[key] ?? null;
      const state = entry ? folderFetchAnswerOf(entry.state, entry.reason) : 'fetched';
      setNotes((prev) => prev.map((one) => (one.key === key ? {
        ...one,
        state,
        ...(entry?.detail ? { detail: entry.detail } : {}),
      } : one)));
      if (stickyAnswer(state)) return;
      timers.current.push(setTimeout(() => {
        setNotes((prev) => prev.filter((one) => one.key !== key));
      }, FETCH_NOTE_MS));
    });
  }, []);
  const dismiss = useCallback(() => { setNotes([]); }, []);
  return { notes, watch, dismiss };
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

  // The fetch sentences, and the name each one needs. Names come from the LIVE mailbox rows, so a
  // sentence says what the row above it says.
  const fetchNotes = useFolderFetchNotes(selectedKey);
  const paneNote = snapshot.paneNote;
  const folderNameOf = (accountId: string, mailboxId: string): string => (
    live[pairKey(accountId, mailboxId)]?.name ?? mailboxId
  );
  const manyAccounts = accounts.length > 1;

  /**
   * The footer's sentence, recomputed on a pane-local 30 s clock.
   *
   * Reads the LIVE mailbox rows rather than `held.mailboxes`: the hold this pane enforces is about row
   * GEOMETRY, and its own rule is that the numbers keep moving while only the rows stand still. This
   * line is not a row, so freezing it would only make it wrong.
   */
  const now = useNow(SYNC_TICK_MS);
  const syncLine = useMemo(() => syncLineFor({
    selected, accounts, mailboxes, folderFetch: snapshot.folderFetch, unreadChecking: snapshot.unreadChecking,
    refreshing, now,
  }), [selected, accounts, mailboxes, snapshot.folderFetch, snapshot.unreadChecking, refreshing, now]);

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
          folderFetch={snapshot.folderFetch}
          onToggle={toggleSmart}
          onFetchAsked={fetchNotes.watch}
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
            manyAccounts={manyAccounts}
            folderFetch={snapshot.folderFetch}
            onToggleTail={toggleTail}
            onFetchAsked={fetchNotes.watch}
            onPicked={onPicked}
          />
        ))}
      </div>

      {/* The pane's ANSWER STRIP. One line per folder, each naming its folder: the row's dot says WHICH
          row, this says what happened. `failed` is the only answer with a second sentence, which is the
          provider's own words and is never run on after Walnut's full stop.
          IN THE FLOW at the foot, and the space comes out of the scroller above it, so no folder row
          moves (this pane's own rule) and none is covered either: floated, three of these hid a whole
          second account behind opaque cards for 30 seconds. Dismissable, and cleared when the selection
          changes, because an answer about a folder belongs to the screen it was asked from. */}
      {(fetchNotes.notes.length > 0 || paneNote) && (
        <div className="mail-pane-strip" data-testid="mail-pane-toast">
          <div className="mail-pane-strip-lines">
            {fetchNotes.notes.map((note) => {
              const lines = folderFetchSentence(
                note.state, folderNameOf(note.accountId, note.mailboxId), note.detail,
              );
              return (
                <p
                  key={note.key}
                  className="mail-refresh-note"
                  data-testid="mail-folder-fetch-note"
                  data-account-id={note.accountId}
                  data-mailbox-id={note.mailboxId}
                  data-state={note.state}
                  title={lines.join(' ')}
                >
                  <span>{lines[0]}</span>
                  {lines[1] && <>{' '}<span className="mail-folder-detail">{lines[1]}</span></>}
                </p>
              );
            })}
            {paneNote && (
              <p
                className="mail-refresh-note"
                data-testid="mail-pane-note"
                title={paneNote.text}
              >
                {paneNote.text}
              </p>
            )}
          </div>
          <button
            type="button"
            className="mail-pane-strip-close"
            data-testid="mail-pane-strip-close"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => { fetchNotes.dismiss(); clearMailPaneNote(); }}
          >
            ×
          </button>
        </div>
      )}

      {/* WHEN THIS CONSOLE LAST HEARD FROM THE MAIL, in one line at the foot of the pane.
          IN THE FLOW between the answer strip and `+ Add account`, for the same reason the strip is:
          the space comes out of the scroller above (`flex: 1`), so no folder row moves and none is
          covered. It is a BUTTON because the sentence and the verb are the same thing here: the answer
          to "is this up to date?" is followed by "then check it now", and the pane's own Refresh icon
          is 200px away at the top. A second click while the first is on the wire is a no-op, and the
          line says `Checking…` for the duration, so it is never a control that looks idle while busy. */}
      {syncLine && (
        <button
          type="button"
          className="mail-sync-line"
          data-testid="mail-sync-line"
          data-state={syncLine.state}
          {...(syncLine.at === undefined ? {} : { 'data-at': String(syncLine.at) })}
          title={syncLine.title}
          /* The visible words are a time, so the accessible name has to carry the VERB too, or a
             screen reader reaches a button called "Checked 2 min ago" with nothing saying what it
             does. Deliberately NOT `aria-live`: this text changes by itself every minute, and a live
             region would announce a relative time over whatever the person was reading. */
          aria-label={`${syncLine.text}. Check every account for new mail.`}
          onClick={() => { if (!refreshing) void requestMailRefresh(); }}
        >
          {syncLine.text}
        </button>
      )}

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
