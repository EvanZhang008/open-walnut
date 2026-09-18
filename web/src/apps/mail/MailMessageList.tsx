/**
 * The middle pane: one page of the selected mailbox, or the search results that replaced it.
 *
 * Search is a MODE rather than a filter over the loaded page: the plugin answers it from the
 * provider when the provider can search and from the local FTS cache otherwise, and the two
 * cover different things (the cache can match a word deep inside a body it has fetched, the
 * provider knows about mail the cache never saw). Which one answered is on screen, because
 * "no results" means something different in each case.
 */
import { useEffect, useState } from 'react';
import type { MailAccountDto, MailMessageDto } from '@/api/mail';
import { formatCount, formatMailTime, isUnread, rowRecipientLabel, senderLabel } from './mail-format';
import {
  clearMailSearch,
  fetchSelectedFolder,
  loadOlderMailMessages,
  openMailMessage,
  requestMailRefresh,
  runMailSearch,
  setMailUnreadOnly,
} from './mail-actions';
import {
  DRAFTS_MAILBOX,
  SMART_DRAFTS,
  SMART_ROLE,
  isSmartSelection,
  selectionKey,
  serverDraftsMailbox,
  type MailSnapshot,
  type SmartMailboxId,
} from './mail-store';
import {
  SMART_LABEL,
  accountsNotSyncing,
  degradedLine,
  draftsRowCount,
  draftsTotalCount,
  smartPairs,
  smartTotal,
  smartUnread,
  type SmartRole,
} from './mail-smart';
import { readUnreadOnly } from './mail-unread-filter';
import { MailDraftsList } from './compose/MailDraftsList';
import { GroupHeader, MailSmartDraftsSections } from './MailSmartDraftsSections';
import { AttachmentIcon, BackIcon, SearchIcon } from './mail-icons';

interface Props {
  snapshot: MailSnapshot;
  narrow: boolean;
  onShowMailboxes: () => void;
}

export function MailMessageList({ snapshot, narrow, onShowMailboxes }: Props) {
  const [draft, setDraft] = useState('');
  const accountId = snapshot.selected?.accountId ?? '';
  const mailboxId = snapshot.selected?.mailboxId ?? '';
  const [unreadOnly, setUnreadOnly] = useState(() => readUnreadOnly(accountId, mailboxId));
  // Switching mailbox drops the search MODE in the store, so leaving the words in the box would
  // show a query next to results that are not its results. The unread filter is REMEMBERED per
  // mailbox instead of dropped, and this is also the first paint's answer: the console picks its
  // mailbox after the accounts land, so the initial state above ran with nothing selected.
  useEffect(() => {
    setDraft('');
    setUnreadOnly(readUnreadOnly(accountId, mailboxId));
  }, [accountId, mailboxId]);
  const search = snapshot.search;
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
  // The server already answered with the unread set, so this only holds back the row that was read
  // in this session and has not been left yet (see `keepWhileFiltering`), and gives the toggle an
  // instant answer while the new page is in flight.
  const visible = filtering ? rows.filter((one) => keepWhileFiltering(one, snapshot)) : rows;
  // Built from the rows ON SCREEN, so the header counts what is under it in both modes.
  const section = search.active
    ? null
    : sectionOf(snapshot, { draftsView, smart, filtering }, visible);
  // The account a row belongs to, printed on the row itself. Only worth saying with more than one
  // account, and only in the two lists that mix them.
  const accountLabels = (smart || search.active) && snapshot.accounts.length > 1
    ? snapshot.accounts
    : null;
  const toggleFilter = (next: boolean) => { setUnreadOnly(next); void setMailUnreadOnly(next); };
  // How many rows ON SCREEN are unread. The header's chip is the MAILBOX's number, which is the one the
  // sidebar badge shows, and at real density the two are not the same: the provider counted 7 unread in
  // folders whose cached window holds 18 unread. Three numbers on one screen and no explanation is the
  // report this slice had to answer, so when they disagree the difference is said in a sentence.
  const unreadOnScreen = visible.filter((one) => isUnread(one.flags)).length;
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
              {formatCount(section.unread)} unread{unreadOnly ? ' · showing' : ''}
            </button>
          )}
        </p>
      )}

      {(degraded || unreadGap) && (
        <p className="mail-list-note" data-testid="mail-list-note">
          {degraded && <span data-testid="mail-degraded-line">{degraded}</span>}
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
              />
            )}
          />
        ) : draftsView ? (
          <DraftsSections
            snapshot={snapshot}
            serverName={serverDrafts ? serverDrafts.name : null}
            serverRows={serverDrafts ? rows : []}
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
          />
        ))}
      </div>

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
    </section>
  );
}

/**
 * The accounts one merged list actually covers.
 *
 * Drafts is answered by the account list, not by folders: the Drafts row is Walnut's own and every
 * account has one whether or not its provider keeps such a folder.
 */
function coveredBy(snapshot: MailSnapshot, role: SmartRole): MailAccountDto[] {
  if (role === 'drafts') return snapshot.accounts;
  const pairs = smartPairs(snapshot.mailboxes, snapshot.accounts, role);
  return snapshot.accounts.filter((one) => pairs.some((pair) => pair.accountId === one.accountId));
}

/**
 * A folder with nothing on screen, told apart from the other two things that look exactly like it.
 *
 * "No mail in this folder yet" used to be the answer to all three, and for a real Gmail account it
 * was the wrong one twice: the header said `SENT MAIL · 1,962 · 2 unread` (the mailbox list knows the
 * folder's true size) directly above a message list claiming the folder was empty. Nothing on screen
 * hinted that Walnut simply had not fetched it yet, so the only reading available was "Walnut lost my
 * sent mail".
 *
 * The three cases, and what makes them different:
 *
 * - NEVER FETCHED. `lastSyncAt` is absent, so no poll of this container has ever completed. It is
 *   fetched on the spot (see `fetchSelectedFolder`), and while that runs this says so.
 * - FETCHED AND KEPT NOTHING. The folder has messages on the server and none of them are inside the
 *   cache's window. The number is on screen, so the sentence has to account for it or it reads as a
 *   contradiction.
 * - ACTUALLY EMPTY. The only case the old sentence was right about.
 */
function EmptyFolder({ snapshot, section, smart }: {
  snapshot: MailSnapshot;
  section: Section | null;
  smart: SmartRole | null;
}) {
  const selection = snapshot.selected;
  if (smart) return <SmartEmpty snapshot={snapshot} role={smart} />;
  const mailbox = selection
    ? (snapshot.mailboxes[selection.accountId] ?? []).find((one) => one.mailboxId === selection.mailboxId)
    : undefined;
  const fetch = selection && snapshot.folderFetch?.key === selectionKey(selection)
    ? snapshot.folderFetch
    : null;
  const total = section?.count ?? mailbox?.total ?? 0;

  if (fetch?.state === 'fetching' || fetch?.state === 'running') {
    return (
      <p className="mail-pane-empty" data-testid="mail-folder-fetching">
        Fetching this folder…
      </p>
    );
  }
  if (fetch?.state === 'failed') {
    return (
      <p className="mail-pane-empty mail-folder-unfetched" data-testid="mail-folder-fetch-failed">
        <span>Walnut could not fetch this folder.</span>
        {/* The provider's own sentence, on its OWN line rather than run on after that full stop. A
            plugin writes this text and nothing here can promise it starts with a capital: joined
            inline it read as "could not fetch this folder. this server will not open Aged", which
            looks like the console broke its own sentence in half. */}
        {fetch.detail && <span className="mail-folder-detail">{fetch.detail}</span>}
        <button
          type="button"
          className="mail-text-btn"
          data-testid="mail-folder-fetch"
          onClick={() => { void fetchSelectedFolder(); }}
        >
          Try again
        </button>
      </p>
    );
  }
  // The button is here for the second visit: the automatic fetch runs once per folder per tab, so a
  // page reloaded after that would otherwise be a dead end with no way to ask.
  if (mailbox && mailbox.lastSyncAt === undefined) {
    return (
      <p className="mail-pane-empty mail-folder-unfetched" data-testid="mail-folder-unfetched">
        <span>Walnut has not fetched this folder yet.</span>
        <button
          type="button"
          className="mail-text-btn"
          data-testid="mail-folder-fetch"
          onClick={() => { void fetchSelectedFolder(); }}
        >
          Fetch it now
        </button>
      </p>
    );
  }
  if (total > 0) {
    return (
      <p className="mail-pane-empty" data-testid="mail-folder-outside-window">
        {/* States what is OBSERVED (fetched, holding none of them) and then the rule that explains
            it, rather than asserting that every one of those messages is old. Walnut can see the
            first two things; the third is an inference, and it is the cache's rule that is worth
            telling somebody anyway. */}
        {`Walnut fetched this folder and kept none of its ${formatCount(total)} messages:`
          + ' the mail cache only keeps recent mail.'}
      </p>
    );
  }
  return <p className="mail-pane-empty" data-testid="mail-list-empty">No mail in this folder yet.</p>;
}

/** What a merged list calls the folders it stands for. Drafts never reaches here (see draftsView). */
const SMART_NOUN: Record<SmartRole, { many: string; each: string }> = {
  inbox: { many: 'these inboxes', each: 'every inbox' },
  sent: { many: 'these folders', each: 'every folder' },
  drafts: { many: 'these folders', each: 'every folder' },
};

/**
 * The merged list with nothing on screen: an empty set of folders, or a set Walnut has not finished
 * fetching, which on a fresh install is most of them.
 *
 * A smart selection is NOT a folder, so there is nothing for `/mailboxes/fetch` to name here: one of
 * its mailboxes missing `lastSyncAt` is a statement about the sweep, and the sweep is what the button
 * asks for. Fetching one folder of the set would also leave the sentence true, which is the kind of
 * button that looks broken.
 */
function SmartEmpty({ snapshot, role }: { snapshot: MailSnapshot; role: SmartRole }) {
  const noun = SMART_NOUN[role];
  const pairs = smartPairs(snapshot.mailboxes, snapshot.accounts, role);
  const unfetched = pairs.some((pair) => {
    const row = (snapshot.mailboxes[pair.accountId] ?? []).find((one) => one.mailboxId === pair.mailboxId);
    return !row || row.lastSyncAt === undefined;
  });
  if (!unfetched) {
    return (
      <p className="mail-pane-empty" data-testid="mail-smart-empty">
        {`No mail in ${noun.many} yet.`}
      </p>
    );
  }
  return (
    <p className="mail-pane-empty mail-folder-unfetched" data-testid="mail-smart-unfetched">
      <span>{`Walnut has not fetched ${noun.each} yet.`}</span>
      <button
        type="button"
        className="mail-text-btn"
        data-testid="mail-smart-refresh"
        onClick={() => { void requestMailRefresh(); }}
      >
        Check for new mail
      </button>
    </p>
  );
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
function keepWhileFiltering(message: MailMessageDto, snapshot: MailSnapshot): boolean {
  return isUnread(message.flags) || isOpenRow(snapshot, message);
}

/**
 * Whether this row is the message the reader is holding.
 *
 * The PAIR, never the id alone. A message's identity is (accountId, messageId), and the merged list
 * is the first place both halves are on screen at once: two providers hand out ids from their own
 * numbering, so the same id in two accounts is two different mails. Keyed on the id alone, opening
 * one of them highlighted both, and the filter kept both on screen.
 */
function isOpenRow(snapshot: MailSnapshot, message: MailMessageDto): boolean {
  const open = snapshot.open;
  return !!open && open.accountId === message.accountId && open.messageId === message.messageId;
}

/**
 * The merged Drafts row's list: what was written HERE, then what the provider is holding.
 *
 * One row in the folder list, two sections here, because they are genuinely two things: the first
 * are this console's drafts with their approval state and are editable, the second are whatever
 * another device left in the server's Drafts folder and open in the reader like any other message.
 * With no drafts folder on the provider there is one section and nothing on screen says "server".
 */
function DraftsSections({ snapshot, serverName, serverRows }: {
  snapshot: MailSnapshot;
  serverName: string | null;
  serverRows: MailMessageDto[];
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
        />
      ))}
    </>
  );
}

interface Section {
  name: string;
  count: number;
  unread: number;
  /** Whether `count` is the mailbox's size or only what has been loaded. Said on screen, in a title. */
  countLoaded: boolean;
  /** The same question for `unread`, which can only be page-derived before any mailbox list lands. */
  unreadLoaded: boolean;
  /** What `count` counts, for its title. A merged list is not "this folder". */
  countTitle: string;
  /**
   * The one word that says, ON SCREEN, what the count is.
   *
   * `ALL INBOXES 62,972` is the sum of both inboxes as the provider declares them, while the cache this
   * list pages holds a 180 day window of about four thousand: Load older ended at a few percent of the
   * number in the header, and the only thing that said so was a title attribute, which never renders.
   */
  countWord: string;
}

/**
 * The folder header: which mailbox this column is, how big it is, and how much unread mail it holds.
 *
 * BOTH numbers are the MAILBOX ROW's, which is the same row the folder badge on the left is drawn
 * from, so the three figures a person sees for one folder cannot disagree. They used to be page
 * arithmetic, and the result was the report this header exists to answer: a folder row reading
 * "Inbox 99+" beside a header reading "INBOX 50" and "5 unread", none of which described the same
 * thing.
 *
 * The fallback to the loaded rows is for the FIRST PAINT, before any mailbox list has landed, and it
 * says so in a title rather than passing a page count off as the folder's size. The count falls back
 * one step further: a provider that declares fewer messages than this console is already holding has
 * told us something that cannot be true, and the honest number is then the one that can be counted on
 * screen. The unread figure has no such check on purpose, because it is what the badge shows and the
 * two have to stay the same number.
 *
 * Null when nothing is selected: there is no folder to name yet.
 */
function sectionOf(
  snapshot: MailSnapshot,
  view: { draftsView: boolean; smart: SmartRole | null; filtering: boolean },
  rows: MailMessageDto[],
): Section | null {
  const selected = snapshot.selected;
  if (!selected) return null;
  const { draftsView, smart, filtering } = view;
  if (draftsView) {
    // Both halves, so the header counts the rows below it: with a server section the local count alone
    // would repeat "Written here" one line further up and describe a third of the list.
    //
    // The server half is the PAGE THIS VIEW HOLDS, not the folder size the mailbox row declares. That
    // size counts drafts outside the cache's retention window, which no section here can list: it is how
    // a header read 51 over a view whose sections added up to 8. The sidebar badge is the first section
    // (see `draftsRowCount`), this is every row under the header, and both are countable on screen.
    const written = smart
      ? draftsTotalCount(snapshot.drafts, snapshot.accounts)
      : draftsRowCount(snapshot.drafts[selected.accountId]);
    const onServer = smart
      ? snapshot.accounts.some((one) => !!serverDraftsMailbox(snapshot.mailboxes[one.accountId]))
      : !!serverDraftsMailbox(snapshot.mailboxes[selected.accountId]);
    return {
      name: smart ? SMART_LABEL.drafts : 'Drafts',
      count: written + rows.length,
      unread: 0,
      // A provider folder in the view means the second half is a page, so the word says `loaded`: the
      // folder can hold drafts older than the window this cache keeps, and calling that `total` claims a
      // number Load older can never reach.
      countLoaded: onServer,
      unreadLoaded: false,
      countTitle: 'drafts written here and in the Drafts folder',
      countWord: onServer ? 'loaded' : 'total',
    };
  }
  if (smart) {
    // The SUM of the same mailbox rows the sidebar badge adds up, so the two cannot disagree. The one
    // exception is while the filter is on: the rows on screen are then the answer to a different
    // question (what the cache holds unread) and the provider's own figure can be smaller, so the chip
    // counts what is under it and its title says where that number came from.
    const onScreen = rows.filter((one) => isUnread(one.flags)).length;
    return {
      name: SMART_LABEL[smart],
      count: smartTotal(snapshot.mailboxes, smart),
      countLoaded: false,
      unread: filtering ? onScreen : smartUnread(snapshot.mailboxes, smart),
      unreadLoaded: filtering,
      countTitle: 'messages in these folders',
      countWord: 'total',
    };
  }
  const mailbox = (snapshot.mailboxes[selected.accountId] ?? [])
    .find((one) => one.mailboxId === selected.mailboxId);
  const total = mailbox ? countOf(mailbox.total) : 0;
  const describesThePage = !!mailbox && total >= rows.length;
  return {
    name: mailbox?.name || selected.mailboxId,
    count: describesThePage ? total : rows.length,
    countLoaded: !describesThePage,
    unread: mailbox ? countOf(mailbox.unread) : rows.filter((one) => isUnread(one.flags)).length,
    unreadLoaded: !mailbox,
    countTitle: 'messages in this folder',
    countWord: describesThePage ? 'total' : 'loaded',
  };
}

/** A provider-declared count, made safe to compare: no fractions, no negatives, no NaN. */
function countOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * One row. `accounts` non-null means this list mixes accounts, so the row says which one it is.
 *
 * That slot used to print the raw `mailboxId`, which on one provider here is a 90 character string:
 * a merged list would have been a column of noise, and the mailbox is not the question anyway (the
 * row is already under a header naming the role). It REPLACES the old slot rather than adding a line.
 */
function MailRow({ message, selected, accounts, outbound }: {
  message: MailMessageDto;
  selected: boolean;
  accounts: MailAccountDto[] | null;
  /** A sent or drafts scope: the first column is the RECIPIENT, which is what such a list is scanned for. */
  outbound?: boolean;
}) {
  const unread = isUnread(message.flags);
  const account = accounts?.find((one) => one.accountId === message.accountId);
  const who = account ? account.displayName || account.address : '';
  // A MARK, not the name: measured on the same 50 rows at 1280x800, the name chip took 110px (more than
  // the 102px left to the sender) and was itself cut on 19 of them, mid domain for an account whose
  // display name is its address. One letter cannot truncate, costs the sender column nothing, and the
  // full identity is on the row's own title, in the reader head and in the composer head (spec 6.9).
  const mark = who.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toLocaleUpperCase() || '?';
  const recipient = outbound ? rowRecipientLabel(message.to) : '';
  return (
    <button
      type="button"
      className={`mail-row${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      data-testid="mail-row"
      data-message-id={message.messageId}
      data-account-id={message.accountId}
      data-unread={unread}
      onClick={() => { void openMailMessage(message.accountId, message.messageId); }}
    >
      <span className="mail-row-top">
        {unread && <span className="mail-row-dot" aria-hidden="true" />}
        <span className="mail-row-from" data-field={outbound ? 'to' : 'from'}>
          {/* `To` only in front of somebody. A live sent folder does hold rows whose cached envelope never
              carried recipients (they live in the provider's payload, not in a column), and the stand-in
              has to say that WE do not know rather than that the mail had nobody: `No recipient` was a
              claim about the message, `Unknown recipient` is a claim about the cache, which is the true one
              and the same word `senderLabel` already uses for a missing sender. */}
          {outbound && recipient && <span className="mail-row-to">To </span>}
          {outbound ? recipient || 'Unknown recipient' : senderLabel(message.from)}
        </span>
        {account && (
          <span
            className="mail-row-account"
            data-testid="mail-row-account"
            data-account-id={account.accountId}
            /* A stable tone per account, so two accounts whose names start with the same letter are
               still two different marks. Index in the account list, not a hash: it is the order the
               sidebar draws them in, so the mark and the pane agree. */
            data-tone={String((accounts ?? []).findIndex((one) => one.accountId === account.accountId) % 4)}
            title={who === account.address ? who : `${who} (${account.address})`}
            aria-label={`Account ${who}`}
          >
            {mark}
          </span>
        )}
        <span className="mail-row-time">{formatMailTime(message.sentAt)}</span>
      </span>
      <span className="mail-row-subject">
        {/* Its own span, so the ellipsis has a block to happen in: the row's subject line is a flex
            container, and a bare text node there is an anonymous item that clips without one. */}
        <span className="mail-row-subject-text">{message.subject || '(no subject)'}</span>
        {message.attachments.length > 0 && (
          <span className="mail-row-clip" aria-label="has attachments"><AttachmentIcon /></span>
        )}
      </span>
      <span className="mail-row-snippet">{message.snippet}</span>
    </button>
  );
}
