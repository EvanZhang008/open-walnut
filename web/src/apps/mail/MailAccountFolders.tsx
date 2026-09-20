/**
 * One account's section: its head, its state, and its folder rows with the long tail collapsed.
 *
 * An account that cannot be reached is shown WITH its state rather than hidden or silently empty: a
 * mailbox that has stopped updating and never says so is the failure this pane exists to prevent.
 * `auth-required` also says what fixes it, because polling has stopped for that account until a human
 * acts and no amount of waiting or clicking refresh will change that.
 *
 * The collapse is the reason this file exists. One account here has 64 folders, 58 of them ordinary
 * labels, so the roles a person actually navigates by (Sent, Archive) were buried below the fold. What
 * stays out is decided by `importantFolders`: the roles always, in the SERVER's order (this list is the
 * account's own), plus at most three labels that received mail this session, are selected, or were opened
 * lately. The rest stand behind one row that says how many they are AND how many of them hold unread mail,
 * because a clean sentence over a pile of unread mail is the dishonest version of this feature. Both of
 * that row's numbers count FOLDERS and the second one says so (`6 with unread`); the mail count names its
 * unit in the hover text.
 *
 * `rows` is HELD by the pane while somebody is aiming at it (a promotion must not move the row under the
 * pointer); `live` is the current mailbox rows, so every badge is this frame's number.
 */
import {
  useEffect, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import type { MailAccountDto, MailboxDto } from '@/api/mail';
import { formatCount } from './mail-format';
import { selectMailbox } from './mail-actions';
import {
  DRAFTS_MAILBOX, pairKey, serverDraftsMailbox, type MailFolderFetch, type MailSelection,
} from './mail-store';
import {
  folderLabel, folderTitle, hiddenTail, importantFolders, tailClause, tailLabel, tailTitle,
} from './mail-smart';
import { folderFetchAnswerOf, folderFetchSentence } from './mail-folder-context-items';
import { readUnreadOnly, subscribeUnreadOnly, unreadOnlyVersion } from './mail-unread-filter';
import { useMailFolderContextMenu } from './MailFolderContextMenu';
import { DraftsIcon, MailboxRoleIcon, TwistIcon } from './mail-icons';

interface Props {
  account: MailAccountDto;
  /** Membership and order for this account, held while the pane is being aimed at. */
  rows: MailboxDto[];
  /** This frame's mailbox rows, keyed by `pairKey`, which is where every badge number comes from. */
  live: Record<string, MailboxDto>;
  /** What this account's Drafts row opens onto, from the pane, so the row and its header agree. */
  draftsCount: number;
  selected: MailSelection | null;
  /** What arrived this session, keyed by `pairKey`. Held with `rows`. */
  arrivals: Record<string, number>;
  recent: string[];
  expanded: boolean;
  /** More than one account is listed, so a row's menu says which account its folder belongs to. */
  manyAccounts: boolean;
  /** Every folder this console has an on-demand fetch to report, keyed by `pairKey`. */
  folderFetch: Record<string, MailFolderFetch>;
  onToggleTail: (accountId: string, on: boolean) => void;
  /** The pane's watcher for a fetch this pane's own menu started (see `onFetchAsked`). */
  onFetchAsked: (accountId: string, mailboxId: string, answer: Promise<void>) => void;
  onPicked: () => void;
}

const STATE_LABEL: Record<string, string> = {
  'auth-required': 'Sign-in needed',
  disabled: 'Paused',
};


/**
 * The folder rows with the Drafts row put back where the provider's own Drafts folder was.
 *
 * A splice rather than an append: the server lists an account's folders inbox first and then by
 * name (Inbox, Archive, Drafts, Junk, Sent), so appending the merged row would move Drafts past
 * Sent and reorder a list the person already knows. An account whose provider keeps no drafts
 * folder gets the row last, which is where it has always been.
 */
function withDraftsRow(rows: ReactNode[], at: number, draftsRow: ReactNode): ReactNode[] {
  return [...rows.slice(0, at), draftsRow, ...rows.slice(at)];
}

/** A tail long enough that scrolling back to its toggle is a journey (measured: 58 rows is 1,860px). */
const SECOND_TOGGLE_AT = 12;

/**
 * The roles whose unread nobody acts on, so their badge is drawn quiet rather than as an alert.
 *
 * Archive, Junk and Trash. Never the badge's VALUE: it is the mailbox row's exact unread, the same number
 * the list header reads, and suppressing it would make the sidebar and the header disagree.
 */
const QUIET_ROLES = new Set<MailboxDto['role']>(['archive', 'spam', 'trash']);

export function MailAccountFolders({
  account, rows, live, draftsCount, selected, arrivals, recent, expanded, manyAccounts, folderFetch,
  onToggleTail, onFetchAsked, onPicked,
}: Props) {
  const [filter, setFilter] = useState('');
  // The rows' right-click menu. One hook next door, which is `useContextMenu` plus the item lists:
  // placement, the backdrop, Escape and the keep-the-native-menu rules are the shared primitive's.
  const menu = useMailFolderContextMenu();
  // A filter is a way through one long list, not a preference: leaving the tail forgets it.
  useEffect(() => { if (!expanded) setFilter(''); }, [expanded]);

  const accountId = account.accountId;
  const selectedMailboxId = selected?.accountId === accountId ? selected.mailboxId : null;
  const folders = importantFolders({ [accountId]: rows }, accountId, {
    arrivals,
    selectedMailboxId,
    recent,
    expanded,
  });
  // The provider's own Drafts folder leaves the list: the ONE Drafts row below reaches it, in the
  // place that folder held, so the order a person knows their mailbox by is kept.
  const roleRows = folders.shown.filter((mailbox) => mailbox.role !== 'drafts');
  const draftsAt = serverDraftsMailbox(folders.shown)
    ? folders.shown.findIndex((one) => one.role === 'drafts')
    : roleRows.length;
  const needle = filter.trim().toLocaleLowerCase();
  // The filter reaches the ORDINARY LABELS only, which is what it was for. Applied to the whole section
  // it deleted the account's Inbox, Sent, Junk and Trash on the second keystroke and took the selected
  // row's highlight off the screen with them, while the person was still reading that inbox: filtering is
  // a way to find one label among 58, never a way to hide the mailbox you are in.
  const filtering = needle.length > 0;
  const tail = filtering
    ? folders.hidden.filter((one) => one.name.toLocaleLowerCase().includes(needle))
    : folders.hidden;
  const nothingMatched = filtering && tail.length === 0;
  const stateLabel = account.state === 'active' ? null : STATE_LABEL[account.state] ?? account.state;

  const accountName = account.displayName || account.address;
  const hasTail = folders.hidden.length > 0;
  // Subscribed ONCE for the whole account rather than per row: the filter is written per folder (by this
  // pane's own menu and by the list's chip), and a row that is filtered to unread only has to say so or a
  // folder holding mail is indistinguishable from an empty one on the way back to it.
  useSyncExternalStore(subscribeUnreadOnly, unreadOnlyVersion);

  const row = (mailbox: MailboxDto, promoted: boolean) => {
    const active = selectedMailboxId === mailbox.mailboxId;
    const shown = live[pairKey(accountId, mailbox.mailboxId)] ?? mailbox;
    return (
      /* The gesture is on the `<li>`, which is the whole LINE: a folder row's badge is inside its
         button, but the rows next door keep sibling buttons on the same line (the smart twist, the
         collapse row), and a menu that covers most of a line and hands the rest back to the browser
         is the complaint this slice exists to fix. */
      <li
        key={mailbox.mailboxId}
        /* The ring `mail.css` draws for an open menu. On the line, because the line is what carries the
           gesture; the rule picks the row inside it. */
        {...(menu.openKey === pairKey(accountId, mailbox.mailboxId) ? { 'data-ctx-open': 'true' } : {})}
        onContextMenu={(event) => menu.open(event, {
          kind: 'folder',
          folder: {
            accountId,
            mailboxId: mailbox.mailboxId,
            label: folderLabel(shown),
            accountName,
            manyAccounts,
            hasTail,
            tailExpanded: expanded,
            onToggleTail,
            onFetchAsked,
          },
        })}
      >
        <FolderRow
          accountId={accountId}
          mailbox={shown}
          fetch={folderFetch[pairKey(accountId, mailbox.mailboxId)] ?? null}
          promoted={promoted}
          /* The mark belongs to a row that was LIFTED for new mail, and to nothing else: a role row that
             received mail is where mail always lands and its badge already moved, while the other two
             reasons to lift a row (it is selected, it was opened lately) are visible as themselves. It
             goes when the row is opened, which is what makes it about mail nobody has looked at. */
          arrived={promoted && !active && (arrivals[pairKey(accountId, mailbox.mailboxId)] ?? 0) > 0}
          unreadOnly={readUnreadOnly(accountId, mailbox.mailboxId)}
          active={active}
          onPicked={onPicked}
        />
      </li>
    );
  };

  return (
    <section className="mail-account" data-account-id={accountId}>
      <header className="mail-account-head">
        <span className="mail-account-name">{account.displayName || account.address}</span>
        {account.address && account.displayName !== account.address && (
          <span className="mail-account-address">{account.address}</span>
        )}
        {stateLabel && (
          <span className="mail-account-state" data-testid="mail-account-state" data-state={account.state}>
            {stateLabel}
          </span>
        )}
      </header>

      {account.state === 'auth-required' && (
        <p className="mail-account-hint" title={account.health?.detail ?? undefined}>
          Fix credentials: update the password where this provider keeps it, then press
          Refresh. Walnut has stopped polling this account until then.
        </p>
      )}

      {/* `rows`, not the filtered ones: an account whose only folder is Drafts has been listed, and
          the merged row below is showing it. */}
      {rows.length === 0 && (
        <p className="mail-account-hint">No folders yet. The first sync lists them.</p>
      )}

      <ul className="mail-mailboxes">
        {withDraftsRow(
          roleRows.map((mailbox) => row(mailbox, false)),
          draftsAt,
          /* ONE Drafts row for both kinds. Walnut's own drafts live in the plugin's database with
             their approval state, which a provider's Drafts folder knows nothing about; the folder
             holds what another device wrote. The row opens a list with a section for each. */
          <li
            key="walnut-drafts"
            /* The Drafts menu, not the folder one: this row is Walnut's own and its reserved id is
               not a folder any provider has, so it never offers a fetch. */
            {...(menu.openKey === pairKey(accountId, DRAFTS_MAILBOX) ? { 'data-ctx-open': 'true' } : {})}
            onContextMenu={(event) => menu.open(event, {
              kind: 'drafts',
              drafts: { accountId, accountName, manyAccounts },
            })}
          >
            <DraftsRow
              accountId={accountId}
              count={draftsCount}
              active={selectedMailboxId === DRAFTS_MAILBOX}
              onPicked={onPicked}
            />
          </li>,
        )}
        {/* Collapsed only, and directly above the collapse row rather than in alphabetical places: the
            role rows keep the order this person has memorised. */}
        {folders.promoted.map((mailbox) => row(mailbox, true))}
        {/* The way back, at the TOP of a long expanded tail: its last row is 1,860px below this line, so
            the one control that closes the tail would otherwise be off screen for most of the list. The
            canonical toggle is the last li of the list (see below); this is the repeat.

            Gated on the rows ACTUALLY RENDERED, never on how many are hidden. Gated on the hidden count it
            repeated while the filter was narrowing 58 folders down to one, so the pane drew `Show fewer
            folders`, the filter box, one folder, `Show fewer folders`: two controls with the same label,
            the same title and the same `aria-expanded` a row apart, which reads as a rendering bug and
            gives a screen reader one name twice. A short list already has its own toggle on screen. */}
        {expanded && tail.length >= SECOND_TOGGLE_AT && (
          <TailRow
            accountId={accountId}
            hidden={folders.hidden}
            live={live}
            expanded={expanded}
            head
            onToggle={onToggleTail}
          />
        )}
        {expanded && folders.hidden.length > 0 && (
          <li>
            <input
              type="search"
              className="mail-tail-filter"
              data-testid="mail-tail-filter"
              placeholder="Filter folders"
              aria-label="Filter folders"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </li>
        )}
        {expanded && tail.map((mailbox) => row(mailbox, false))}
        {nothingMatched && (
          <li className="mail-tail-empty" data-testid="mail-tail-empty">No folder matches that.</li>
        )}
        {/* The collapse row itself, ALWAYS the last li of this list, collapsed or expanded: that position
            is what the spec and the checklist name, and it is the one a person scrolling to the end of an
            expanded tail arrives at. It also stays up while the filter is running, since it is the way
            back out of a filtered tail. */}
        {folders.hidden.length > 0 && (
          <TailRow
            accountId={accountId}
            hidden={folders.hidden}
            live={live}
            expanded={expanded}
            onToggle={onToggleTail}
          />
        )}
      </ul>
      {/* A SIBLING of the list, never inside a row: the menu portals to <body>, but its React events
          still travel this tree and every row's `<li>` holds the gesture that opened it. */}
      {menu.node}
    </section>
  );
}

function FolderRow({
  accountId, mailbox, fetch, promoted, arrived, unreadOnly, active, onPicked,
}: {
  accountId: string;
  mailbox: MailboxDto;
  /** This folder's on-demand fetch, or null. Per FOLDER, so two at once each show their own. */
  fetch: MailFolderFetch | null;
  promoted: boolean;
  /** This folder received mail during this session and has not been opened since. */
  arrived: boolean;
  /** This folder's list is filtered to unread only (the menu item, or the header chip). */
  unreadOnly: boolean;
  active: boolean;
  onPicked: () => void;
}) {
  const label = folderLabel(mailbox);
  const role = folderTitle(mailbox);
  // A fetch this row asked for reports ON THIS ROW: a dot while it runs, and the provider's own answer
  // in the hover text when it came back with one. The pane writes the same answer as a sentence, which
  // is the half that survives the row scrolling out of view.
  const fetchWords = fetch
    ? folderFetchSentence(folderFetchAnswerOf(fetch.state, fetch.reason), label, fetch.detail)
    : [];
  // EVERY fetch state, not just the failed one. The in-progress dot was the only mark with no words at
  // all: `aria-label` and nothing else, while the pane's sentence retired on its own, so a folder row
  // was left carrying a blue dot nobody could ask about.
  // The filter is said in the hover text as well as drawn (see `data-unread-only` below): the row is a
  // small target and the tag on it is three words long.
  const title = [role, ...fetchWords, unreadOnly ? 'Showing unread only in this folder.' : '']
    .filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={`mail-mailbox${active ? ' active' : ''}`}
      data-mailbox-id={mailbox.mailboxId}
      data-account-id={accountId}
      data-unread={mailbox.unread}
      data-total={mailbox.total}
      data-promoted={promoted ? 'true' : undefined}
      data-unread-only={unreadOnly ? '1' : undefined}
      data-arrived={arrived ? 'true' : undefined}
      /* WebKit does not put a `button` in its tab order by default, and the Mac app is WKWebView: without
         an explicit `tabindex` the whole pane is keyboard-unreachable there. Zero, so the order stays the
         visual one in both engines (see the same line on every row of this pane). */
      tabIndex={0}
      /* The ROLE this folder plays, on hover, where the provider's own name does not already say it (a
         folder called something else that the provider maps to Archive). The name on screen is the
         provider's, which is the only name it has. A finished fetch adds its answer after it. */
      title={title || undefined}
      data-fetch-state={fetch?.state}
      data-fetch-reason={fetch?.reason}
      aria-current={active ? 'true' : undefined}
      onClick={() => {
        selectMailbox(accountId, mailbox.mailboxId);
        onPicked();
      }}
    >
      <MailboxRoleIcon role={mailbox.role} />
      <span className="mail-mailbox-name">{label}</span>
      {/* One small dot, the row's own, so two fetches running at once are two marks and not one
          sentence about whichever answered last. The words are in the hover text and in the pane. */}
      {fetch && (
        <span
          className="mail-mailbox-fetch"
          data-testid="mail-mailbox-fetch-dot"
          data-state={fetch.state}
          aria-label={fetchWords.join(' ')}
          // The same words the row carries, on the mark itself: the dot is the smaller target and it is
          // what somebody points at when they want to know what it means.
          title={fetchWords.join(' ')}
          role="img"
        />
      )}
      {/* A folder LIFTED out of the tail arrives looking like any other row, and the collapse row's own
          hover text claims that anything which just received mail is above the line: without this the
          claim cannot be checked on screen. The badge is the folder's unread, which is a different fact. */}
      {arrived && (
        <span className="mail-mailbox-new" data-testid="mail-mailbox-new" aria-label="new mail">New</span>
      )}
      {/* The EXACT number, from this mailbox row, which is the same row the list header's own two
          numbers come from. It used to cap at "99+", and a folder saying "Inbox 99+" next to a header
          saying "5 unread" is two numbers a human cannot reconcile by looking. The badge grows instead
          and the folder name gives up the width (see mail.css).

          MUTED on the three roles nobody triages. At real density this pane showed ten badges, of which
          an Archive row's 177 and another account's Trash 2,609 and Junk 37 were the loudest, and the
          eight on All Inboxes (the one number the group exists to answer) was the fourth smallest. The
          number is still exact and still on screen, because unread that only Walnut can see is the thing
          this pane must never hide; it just stops being the brightest thing in the column. */}
      {mailbox.unread > 0 && (
        <span
          className={`mail-unread-badge${QUIET_ROLES.has(mailbox.role) ? ' quiet' : ''}`}
          data-testid="mail-mailbox-unread"
          data-quiet={QUIET_ROLES.has(mailbox.role) ? 'true' : undefined}
        >
          {formatCount(mailbox.unread)}
        </span>
      )}
    </button>
  );
}

/**
 * One account's Drafts row.
 *
 * The badge is the FIRST SECTION of the view it opens: the drafts written in this console, which a person
 * can verify by counting rows. It used to add the provider's Drafts folder as the mailbox row declares it,
 * and that folder's size counts mail outside the cache's retention window, so a row badged 23 opened onto
 * a section of four and the merged row summed two of those into 51 above the words "No drafts." The
 * provider's folders are still listed under their own headings, and the view's header still counts every
 * row under it (see `sectionOf`), which is the number that describes the whole view.
 */
function DraftsRow({ accountId, count, active, onPicked }: {
  accountId: string;
  count: number;
  active: boolean;
  onPicked: () => void;
}) {
  const waiting = count;
  return (
    <button
      type="button"
      className={`mail-mailbox${active ? ' active' : ''}`}
      data-testid="mail-drafts-row"
      data-mailbox-id={DRAFTS_MAILBOX}
      data-account-id={accountId}
      data-count={waiting}
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={() => {
        selectMailbox(accountId, DRAFTS_MAILBOX);
        onPicked();
      }}
    >
      <DraftsIcon />
      <span className="mail-mailbox-name">Drafts</span>
      {/* Exact and grouped, like the mailbox badges above: the two sit in the same column of the
          same list, and one of them capping while the other does not is a difference with no
          meaning behind it. */}
      {waiting > 0 && (
        <span className="mail-unread-badge" data-testid="mail-drafts-count">
          {formatCount(waiting)}
        </span>
      )}
    </button>
  );
}

/**
 * The one row the long tail stands behind.
 *
 * It carries NO badge on purpose: a badge in this column is a folder's own unread, and this row is not a
 * folder. What is hiding down there is said in words on the same line instead, so a tidy sidebar can
 * never be the reason nobody noticed two hundred unread mails.
 */
function TailRow({ accountId, hidden, live, expanded, head, onToggle }: {
  accountId: string;
  hidden: MailboxDto[];
  live: Record<string, MailboxDto>;
  expanded: boolean;
  /** The repeat above a long expanded tail, which only ever closes it. */
  head?: boolean;
  onToggle: (accountId: string, on: boolean) => void;
}) {
  const behind = hiddenTail(accountId, hidden, live);
  // Both clauses count FOLDERS and the second SAYS SO, and both strings are built in `mail-smart` so they
  // can be pinned without a browser. `6 unread` fitted the row and was read as six unread messages while
  // the row stood over 202 of them, so the preposition is not decoration: it is the difference between a
  // number and a wrong number. Width at the 204px default pane is bought back in CSS (the row's own
  // padding and glyph column), measured in the spec's `.mail-tail-text` assertion rather than assumed.
  // The unread MAIL count is in the hover text and in `data-hidden-unread`.
  const clause = tailClause(behind.folders, expanded);
  const label = tailLabel(hidden.length, expanded);
  // The clause is a SEPARATE flex item with a real GAP, and the label also keeps the space after its
  // comma. Both, deliberately: a space at the end of an inline box is dropped in layout (which is how the
  // row rendered "58 more folders,6 unread" at every width where it fitted), and a layout-only gap leaves
  // the row's own `textContent` reading "58 more folders,6 unread" to anything that reads it as a string.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight' && !expanded) { event.preventDefault(); onToggle(accountId, true); }
    if (event.key === 'ArrowLeft' && expanded) { event.preventDefault(); onToggle(accountId, false); }
  };
  // The mail count NAMES ITS UNIT here, which is the one place both facts fit: the row says how many
  // folders, the hover says how much mail is in them, and neither number contradicts the other.
  const title = tailTitle(expanded, behind);
  return (
    <li>
      <button
        type="button"
        /* The head repeat gets its own class: `.mail-tail-toggle` is how every spec and the CSS reach the
           ONE canonical control, which is the last li of the list, and two matches there is a strict-mode
           failure. */
        className={`mail-tail-row ${head ? 'mail-tail-head' : 'mail-tail-toggle'}`}
        data-testid={head ? 'mail-tail-toggle-head' : 'mail-tail-toggle'}
        data-account-id={accountId}
        data-hidden={hidden.length}
        data-hidden-unread={behind.unread}
        data-hidden-unread-folders={behind.folders}
        tabIndex={0}
        aria-expanded={expanded}
        title={title}
        onKeyDown={onKeyDown}
        onClick={() => onToggle(accountId, !expanded)}
      >
        <span className="mail-tail-twist" aria-hidden="true"><TwistIcon /></span>
        <span className="mail-tail-text">
          <span className="mail-tail-label">{clause ? `${label}, ` : label}</span>
          {clause && <span className="mail-tail-unread">{clause}</span>}
        </span>
      </button>
    </li>
  );
}
