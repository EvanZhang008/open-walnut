/**
 * The middle pane: one page of the selected mailbox, or the search results that replaced it.
 *
 * Search is a MODE rather than a filter over the loaded page: the plugin answers it from the
 * provider when the provider can search and from the local FTS cache otherwise, and the two
 * cover different things (the cache can match a word deep inside a body it has fetched, the
 * provider knows about mail the cache never saw). Which one answered is on screen, because
 * "no results" means something different in each case.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MailMessageDto } from '@/api/mail';
import { formatCount, isUnread } from './mail-format';
import {
  clearMailSearch,
  loadOlderMailMessages,
  runMailSearch,
  setMailUnreadOnly,
} from './mail-actions';
import {
  clearMailRowNote,
  DRAFTS_MAILBOX,
  SMART_DRAFTS,
  SMART_ROLE,
  isSmartSelection,
  pairKey,
  serverDraftsMailbox,
  type MailSnapshot,
  type SmartMailboxId,
} from './mail-store';
import { accountsNotSyncing, degradedLine } from './mail-smart';
import {
  heldRowsSentence, isStickyRow, readUnreadOnly, subscribeUnreadOnly, unreadChipLabel,
} from './mail-unread-filter';
import { sectionOf } from './mail-list-section';
import { coveredBy, EmptyFolder } from './MailListEmptyStates';
import { isOpenRow, MailRow } from './MailMessageRow';
import { useMailRowContextMenu, type MailRowMenuHandle } from './MailRowContextMenu';
import { MailDraftsList } from './compose/MailDraftsList';
import { GroupHeader, MailSmartDraftsSections } from './MailSmartDraftsSections';
import { BackIcon, SearchIcon } from './mail-icons';

interface Props {
  snapshot: MailSnapshot;
  narrow: boolean;
  onShowMailboxes: () => void;
}

export function MailMessageList({ snapshot, narrow, onShowMailboxes }: Props) {
  const [draft, setDraft] = useState('');
  const accountId = snapshot.selected?.accountId ?? '';
  const mailboxId = snapshot.selected?.mailboxId ?? '';
  // SUBSCRIBED, never a copy: the sidebar's folder menu writes this same preference for this same
  // pair, and a local `useState` resynced only on a selection change left the chip in the off state
  // over a list the menu had already filtered (and with it the pane's filtered-empty state, so a
  // folder with no unread mail printed the cache sentence about messages it was only hiding).
  const unreadOnly = useSyncExternalStore(
    subscribeUnreadOnly,
    () => readUnreadOnly(accountId, mailboxId),
  );
  // Switching mailbox drops the search MODE in the store, so leaving the words in the box would
  // show a query next to results that are not its results. The unread filter is REMEMBERED per
  // mailbox instead of dropped.
  useEffect(() => { setDraft(''); }, [accountId, mailboxId]);
  const search = snapshot.search;
  // A search STARTED SOMEWHERE ELSE writes its words into the box. `Find mail from this sender` filtered
  // the list, wrote "29 results" and left the field empty, so the filter was invisible: nothing on
  // screen said what the list was showing, and it could not be edited or extended. Keyed on the store's
  // query changing rather than on `active`, so typing here is never overwritten mid-word.
  const seenQuery = useRef(search.query);
  useEffect(() => {
    if (search.query === seenQuery.current) return;
    seenQuery.current = search.query;
    setDraft(search.query);
  }, [search.query]);
  const rows = search.active ? search.messages : snapshot.messages;
  const busy = search.active ? search.loading : snapshot.listLoading;
  // The role a merged selection stands for, and the only reason this pane behaves differently: it
  // has no single mailbox row, so its numbers are sums and its empty state speaks about a set.
  const smart = !search.active && isSmartSelection(snapshot.selected)
    ? SMART_ROLE[snapshot.selected!.mailboxId as SmartMailboxId]
    : null;
  // Walnut's own drafts, not a provider folder: a virtual mailbox id selects them (see the store).
  // The merged row is the same view over every account, so it takes the same branch.
  const draftsView = !search.active
    && (mailboxId === DRAFTS_MAILBOX || mailboxId === SMART_DRAFTS);
  // The provider's drafts folder, whose page is what `snapshot.messages` holds while the merged
  // Drafts row is open. Absent means the row has only this console's own drafts. Under All Drafts
  // the page holds every account's drafts folder at once, so the sections split it by account.
  const serverDrafts = draftsView && !smart && snapshot.selected
    ? serverDraftsMailbox(snapshot.mailboxes[snapshot.selected.accountId])
    : null;

  // A list of mail this person SENT is scanned for who it went to, never for who sent it: every row in it
  // has the same sender, so the sender column printed the account's own display name fifty times (and, in
  // a merged list, printed it a second time as the account mark on the same line). The scope decides, not
  // the message: the merged Sent and Drafts lists, this account's own Sent folder, and the drafts views.
  const scopeRole = smart ?? (snapshot.selected
    ? (snapshot.mailboxes[snapshot.selected.accountId] ?? [])
      .find((one) => one.mailboxId === snapshot.selected!.mailboxId)?.role
    : undefined);
  const outbound = !search.active
    && (draftsView || scopeRole === 'sent' || scopeRole === 'drafts');

  const clear = () => { setDraft(''); clearMailSearch(); };
  const filtering = unreadOnly && !search.active && !draftsView;
  // The message the reader was holding when a COMPOSER took its pane. `handOver` clears `open`, so
  // replying from one row would take a different row (the one being read) off an unread-filtered
  // list in the same click. Remembered here rather than flipped into `pendingSeen`: nothing was
  // marked read, and a lie in that map is subtracted from the badge.
  const lastOpen = useRef<string | null>(null);
  const openPair = snapshot.open ? pairKey(snapshot.open.accountId, snapshot.open.messageId) : null;
  if (openPair) lastOpen.current = openPair;
  else if (!snapshot.composer) lastOpen.current = null;
  const heldOpen = snapshot.composer ? lastOpen.current : null;
  // The server already answered with the unread set, so this only holds back the rows this console
  // has just acted on and has not left yet (see `keepWhileFiltering`), and gives the toggle an
  // instant answer while the new page is in flight.
  const visible = filtering ? rows.filter((one) => keepWhileFiltering(one, snapshot, heldOpen)) : rows;
  // Built from the rows ON SCREEN, so the header counts what is under it in both modes.
  const section = search.active
    ? null
    : sectionOf(snapshot, { draftsView, smart, filtering }, visible);
  // The account a row belongs to, printed on the row itself. Only worth saying with more than one
  // account, and only in the two lists that mix them.
  const accountLabels = (smart || search.active) && snapshot.accounts.length > 1
    ? snapshot.accounts
    : null;
  // No local echo: the write announces itself (`mail-unread-filter`) and this component is a
  // subscriber like the folder menu is, so both controls change in the same commit.
  const toggleFilter = (next: boolean) => { void setMailUnreadOnly(accountId, mailboxId, next); };
  // ONE menu for the pane, and the rows only hand it the pair they carry: every item then acts on
  // THAT row's account, which is the whole question a merged list asks.
  const menu = useMailRowContextMenu({
    snapshot,
    outbound,
    draftsView,
    merged: accountLabels !== null,
  });
  // How many rows ON SCREEN are unread. The header's chip is the MAILBOX's number, which is the one the
  // sidebar badge shows, and at real density the two are not the same: the provider counted 7 unread in
  // folders whose cached window holds 18 unread. Three numbers on one screen and no explanation is the
  // report this slice had to answer, so when they disagree the difference is said in a sentence.
  const unreadOnScreen = visible.filter((one) => isUnread(one.flags)).length;
  // The rows a filtered list is HOLDING: read, and on screen anyway because this pass just dealt with
  // them. Said in a sentence, because otherwise the chip's number and the rows under it contradict each
  // other with nothing on screen to explain it.
  const heldNote = filtering ? heldRowsSentence(visible.length - unreadOnScreen) : '';
  // Only where the disagreement is worth two lines. NOT in a sent or drafts scope: unread is not what such
  // a list is read for, and All Sent spent two lines on "These folders report 8 unread and 1 of the messages
  // loaded here are unread" above its first row (one live provider reports unread on its Sent folder, so
  // suppressing this at zero alone did not answer it). NOT at zero either: the chip that states the mailbox
  // rows' number is suppressed there, so there is no second number on screen to reconcile.
  const unreadGap = !!section && !draftsView && !outbound && !search.active && !filtering
    && section.unread > 0 && section.unread !== unreadOnScreen;
  // One account of a merged list has stopped polling: its cached mail is still listed (it is real), and
  // the row's warning dot marks it, but a dot is not a sentence.
  const stopped = smart ? accountsNotSyncing(coveredBy(snapshot, smart)).length : 0;
  const degraded = smart ? degradedLine(stopped) : null;

  return (
    <section className="mail-list-pane" data-testid="mail-message-list">
      <div className="mail-pane-head">
        {narrow && (
          <button
            type="button"
            className="mail-icon-btn"
            data-testid="mail-show-mailboxes"
            onClick={onShowMailboxes}
            aria-label="Mailboxes"
          >
            <BackIcon />
          </button>
        )}
        <form
          className="mail-search"
          onSubmit={(event) => { event.preventDefault(); void runMailSearch(draft); }}
        >
          <span className="mail-search-glyph" aria-hidden="true"><SearchIcon size={13} /></span>
          <input
            className="mail-search-input"
            data-testid="mail-search-input"
            type="search"
            value={draft}
            placeholder="Search mail"
            aria-label="Search mail"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && search.active) { event.preventDefault(); clear(); } }}
          />
        </form>
        {search.active && (
          <button type="button" className="mail-text-btn" data-testid="mail-search-clear" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {search.active && (
        <p className="mail-search-meta" data-testid="mail-search-meta">
          {search.loading ? 'Searching…' : (
            <>
              {rows.length === 1 ? '1 result' : `${rows.length} results`}
              {search.source && (
                <span className="mail-source-tag" data-source={search.source}>
                  {search.source === 'cache' ? 'from cache' : 'from provider'}
                </span>
              )}
            </>
          )}
        </p>
      )}

      {/* Which folder these rows are, and how many of them there are. The middle pane used to open
          with an unlabelled column of messages, so a mailbox with three mails and one that had not
          finished loading looked the same. */}
      {section && (
        <p className="mail-list-section" data-testid="mail-list-section">
          <span className="mail-list-section-name">{section.name}</span>
          {/* How big the FOLDER is, from the same mailbox row the badge on the left is drawn from. It
              used to be the rows on screen, so a 103-message inbox read "INBOX 50" under a folder row
              badged 53 and a person had three numbers and no way to line them up. When it is the
              loaded count (first paint, or a provider declaring fewer messages than we hold) the title
              says so instead of letting a page count pass for the folder's size. */}
          <span
            className="mail-list-section-count"
            data-loaded={section.countLoaded}
            title={section.countLoaded ? 'of the messages loaded so far' : section.countTitle}
          >
            {formatCount(section.count)}
          </span>
          {/* The word the title used to hide. `total` is the size of the folders, `loaded` is the length
              of this list, and which one the number means decides whether Load older can reach it. */}
          <span className="mail-list-section-scope" data-testid="mail-list-count-word">
            {section.countWord}
          </span>
          {/* The unread count is a CONTROL, not a label: it was the only place the number appeared
              and there was no way to act on it. It is the MAILBOX's number, so it counts unread mail
              deeper than the loaded page, which is the whole reason the filter reaches the server.
              Kept on screen while the filter is on even at zero unread, or turning the last one read
              would take the way out with it. */}
          {!draftsView && (section.unread > 0 || unreadOnly) && (
            <button
              type="button"
              className={`mail-unread-chip${unreadOnly ? ' on' : ''}`}
              data-testid="mail-unread-filter"
              data-on={unreadOnly}
              data-loaded={section.unreadLoaded}
              aria-pressed={unreadOnly}
              title={chipTitle(unreadOnly, section.unreadLoaded)}
              onClick={() => toggleFilter(!unreadOnly)}
            >
              {unreadChipLabel(formatCount(section.unread), unreadOnly)}
            </button>
          )}
        </p>
      )}

      {/* The pane's own state lines, which are NOT answers to a gesture: they belong to the list and
          stay in the flow. */}
      {(degraded || unreadGap || heldNote) && (
        <p className="mail-list-note" data-testid="mail-list-state-note">
          {degraded && <span data-testid="mail-degraded-line">{degraded}</span>}
          {heldNote && <span data-testid="mail-held-rows-line">{heldNote}</span>}
          {unreadGap && section && (
            <span data-testid="mail-unread-gap">
              {`${smart ? 'These folders report' : 'This folder reports'} ${formatCount(section.unread)}`
                + ` unread and ${formatCount(unreadOnScreen)} of the messages loaded here are unread.`}
            </span>
          )}
        </p>
      )}

      {search.error && <p className="mail-inline-error">{search.error}</p>}
      {!search.active && snapshot.listError && <p className="mail-inline-error">{snapshot.listError}</p>}

      <div className="mail-rows">
        {draftsView && smart ? (
          <MailSmartDraftsSections
            snapshot={snapshot}
            serverRows={rows}
            renderRow={(message) => (
              <MailRow
                key={`${message.accountId} ${message.messageId}`}
                message={message}
                accounts={null}
                outbound
                selected={isOpenRow(snapshot, message)}
                menu={menu}
                flagFailed={snapshot.flagFailed}
              />
            )}
          />
        ) : draftsView ? (
          <DraftsSections
            snapshot={snapshot}
            serverName={serverDrafts ? serverDrafts.name : null}
            serverRows={serverDrafts ? rows : []}
            menu={menu}
          />
        ) : !snapshot.selected && !search.active ? (
          <p className="mail-pane-empty" data-testid="mail-no-mailbox">
            Pick a mailbox on the left to read it.
          </p>
        ) : busy && rows.length === 0 ? (
          <p className="mail-pane-empty" data-testid="mail-list-empty">Loading…</p>
        ) : filtering && visible.length === 0 ? (
          <p className="mail-pane-empty mail-unread-empty" data-testid="mail-unread-empty">
            <span>No unread messages</span>
            <button
              type="button"
              className="mail-text-btn"
              data-testid="mail-unread-show-all"
              onClick={() => toggleFilter(false)}
            >
              Show all
            </button>
          </p>
        ) : visible.length === 0 && search.active ? (
          <p className="mail-pane-empty" data-testid="mail-list-empty">
            Nothing matched. Cached search only sees mail Walnut has already fetched.
          </p>
        ) : visible.length === 0 ? (
          <EmptyFolder snapshot={snapshot} section={section} smart={smart} />
        ) : visible.map((message) => (
          <MailRow
            key={`${message.accountId} ${message.messageId}`}
            message={message}
            accounts={accountLabels}
            outbound={outbound}
            selected={isOpenRow(snapshot, message)}
            menu={menu}
            flagFailed={snapshot.flagFailed}
          />
        ))}
      </div>
      {/* A SIBLING of the rows, never inside one: the menu portals to <body> for stacking, but React
          events still bubble through the owning tree, so a press inside it would reach the row's own
          click handler and open the message this menu exists to leave closed. */}
      {menu.node}

      {!search.active && snapshot.nextBefore !== null && rows.length > 0 && (
        <button
          type="button"
          className="mail-load-older"
          data-testid="mail-load-older"
          disabled={snapshot.olderLoading}
          onClick={() => { void loadOlderMailMessages(); }}
        >
          {snapshot.olderLoading ? 'Loading…' : 'Load older'}
        </button>
      )}

      {/* The answer to ONE row action, as a strip the LIST gives up rather than a card painted over it.
          It was a floated card at the foot of the pane, which kept the rows from moving (the thing a
          triage pass cannot survive) but covered the last row of a full list: 50 rows loaded, an opaque
          card over one row's snippet, clickable and unreadable. In the flow at the foot, the space comes
          out of the scroller above, so no row moves and no row is hidden.
          A success retires itself; a refusal waits (see `setMailRowNote`), so it gets a dismiss. */}
      {snapshot.rowNote && (
        <p className="mail-row-strip" data-testid="mail-row-toast" role="status">
          <span data-testid="mail-row-note">{snapshot.rowNote.text}</span>
          {/* The sentence names ONE row, and at 50 rows that row can be 620px up the column: this is the
              way back to it, so the pair is never a scan of the whole list. Drawn only when the row it
              names is actually in this list. */}
          {snapshot.rowNote.pair && rowInList(visible, snapshot.rowNote.pair) && (
            <button
              type="button"
              className="mail-row-strip-jump"
              data-testid="mail-row-note-jump"
              onClick={() => { showMailRow(snapshot.rowNote!.pair!); }}
            >
              Show the row
            </button>
          )}
          {snapshot.rowNote.sticky && (
            <button
              type="button"
              className="mail-pane-strip-close"
              data-testid="mail-row-note-close"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => { clearMailRowNote(); }}
            >
              ×
            </button>
          )}
        </p>
      )}
    </section>
  );
}

/** Is the row that note names one of the rows on screen? */
function rowInList(rows: MailMessageDto[], pair: string): boolean {
  return rows.some((one) => pairKey(one.accountId, one.messageId) === pair);
}

/**
 * Bring the row a sentence names back under the eye, and mark it while the eye arrives.
 *
 * A DOM query rather than a ref map: the answer strip is written by the actions layer for a pair, and the
 * row it names can live in the page list, in a merged list or in a search result. The mark is cleared on a
 * timer and by the next call, so two answers in a row do not leave two lit rows.
 */
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function showMailRow(pair: string): void {
  const [accountId, messageId] = JSON.parse(pair) as [string, string];
  // Quotes and backslashes escaped for an ATTRIBUTE value, not `CSS.escape` (which escapes identifiers):
  // a provider message id is an opaque string and one quote in it would end the selector early.
  const quoted = (value: string) => value.replace(/["\\]/g, (one) => `\\${one}`);
  const selector = `.mail-row[data-account-id="${quoted(accountId)}"]`
    + `[data-message-id="${quoted(messageId)}"]`;
  const row = document.querySelector(selector);
  if (!row) return;
  document.querySelectorAll('.mail-row.flash-target').forEach((one) => one.classList.remove('flash-target'));
  if (flashTimer) clearTimeout(flashTimer);
  row.scrollIntoView({ block: 'nearest' });
  row.classList.add('flash-target');
  flashTimer = setTimeout(() => {
    flashTimer = null;
    row.classList.remove('flash-target');
  }, 2_000);
}

/**
 * The chip's hover text: what the click does, and where its number came from when that is in doubt.
 *
 * Only the first paint can put a page-derived number here, and it lasts a moment, but a filter's own
 * label quietly meaning something else for that moment is exactly the kind of thing this header was
 * fixed for.
 */
function chipTitle(unreadOnly: boolean, unreadLoaded: boolean): string {
  const action = unreadOnly ? 'Show every message again' : 'Show only unread messages';
  return unreadLoaded ? `${action}. Counted from the messages loaded so far.` : action;
}

/**
 * Whether a row stays on screen while "only unread" is on.
 *
 * Unread, or the message the person is READING. Marking a mail read is what opening it does, and a
 * row that disappears from under the pointer in the same click is the confident wrong answer: it
 * takes the reply and the make-a-task buttons with it and leaves no way back. It goes when they
 * select another row, which is the moment they are done with it.
 */
function keepWhileFiltering(
  message: MailMessageDto,
  snapshot: MailSnapshot,
  heldOpen: string | null,
): boolean {
  if (isUnread(message.flags) || isStickyRow(snapshot, message)) return true;
  return heldOpen === pairKey(message.accountId, message.messageId);
}

/**
 * The merged Drafts row's list: what was written HERE, then what the provider is holding.
 *
 * One row in the folder list, two sections here, because they are genuinely two things: the first
 * are this console's drafts with their approval state and are editable, the second are whatever
 * another device left in the server's Drafts folder and open in the reader like any other message.
 * With no drafts folder on the provider there is one section and nothing on screen says "server".
 */
function DraftsSections({ snapshot, serverName, serverRows, menu }: {
  snapshot: MailSnapshot;
  serverName: string | null;
  serverRows: MailMessageDto[];
  menu: MailRowMenuHandle;
}) {
  const drafts = snapshot.drafts[snapshot.selected!.accountId] ?? [];
  const local = (
    <MailDraftsList
      drafts={drafts}
      openDraftId={snapshot.composer?.draftId ?? null}
      loading={snapshot.draftsLoading}
    />
  );
  if (!serverName) return local;
  return (
    <>
      <GroupHeader group="written-here" name="Written here" count={drafts.length} />
      {local}
      <GroupHeader group="on-the-server" name="On the server" count={serverRows.length} />
      {serverRows.length === 0 ? (
        <p className="mail-pane-empty" data-testid="mail-server-drafts-empty">
          {snapshot.listLoading ? 'Loading…' : `Nothing in the ${serverName} folder on the server.`}
        </p>
      ) : serverRows.map((message) => (
        <MailRow
          key={`${message.accountId} ${message.messageId}`}
          message={message}
          accounts={null}
          outbound
          selected={isOpenRow(snapshot, message)}
          menu={menu}
          flagFailed={snapshot.flagFailed}
        />
      ))}
    </>
  );
}

