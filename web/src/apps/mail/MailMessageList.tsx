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
import type { MailMessageDto } from '@/api/mail';
import { formatMailTime, isUnread, senderLabel } from './mail-format';
import {
  clearMailSearch,
  loadOlderMailMessages,
  openMailMessage,
  runMailSearch,
} from './mail-actions';
import { DRAFTS_MAILBOX, serverDraftsMailbox, type MailSnapshot } from './mail-store';
import { readUnreadOnly, writeUnreadOnly } from './mail-unread-filter';
import { MailDraftsList } from './compose/MailDraftsList';
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
  // Walnut's own drafts, not a provider folder: a virtual mailbox id selects them (see the store).
  const draftsView = !search.active && snapshot.selected?.mailboxId === DRAFTS_MAILBOX;
  // The provider's drafts folder, whose page is what `snapshot.messages` holds while the merged
  // Drafts row is open. Absent means the row has only this console's own drafts.
  const serverDrafts = draftsView && snapshot.selected
    ? serverDraftsMailbox(snapshot.mailboxes[snapshot.selected.accountId])
    : null;

  const clear = () => { setDraft(''); clearMailSearch(); };
  const section = search.active ? null : sectionOf(snapshot, draftsView, rows, !!serverDrafts);
  const filtering = unreadOnly && !search.active && !draftsView;
  const visible = filtering ? rows.filter((one) => keepWhileFiltering(one, snapshot)) : rows;
  const showAll = () => { setUnreadOnly(false); writeUnreadOnly(accountId, mailboxId, false); };

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
          {/* `8 of 43` while the filter is on, because this count exists to be checkable by
              looking: a bare 43 over eight visible rows is the one number a reader would call a
              bug. */}
          <span className="mail-list-section-count">
            {filtering ? `${visible.length} of ${section.count}` : section.count}
          </span>
          {/* The unread count is a CONTROL, not a label: it was the only place the number appeared
              and there was no way to act on it. Kept on screen while the filter is on even at zero
              unread, or turning the last one read would take the way out with it. */}
          {!draftsView && (section.unread > 0 || unreadOnly) && (
            <button
              type="button"
              className={`mail-unread-chip${unreadOnly ? ' on' : ''}`}
              data-testid="mail-unread-filter"
              data-on={unreadOnly}
              aria-pressed={unreadOnly}
              title={unreadOnly ? 'Show every message again' : 'Show only unread messages'}
              onClick={() => {
                const next = !unreadOnly;
                setUnreadOnly(next);
                writeUnreadOnly(accountId, mailboxId, next);
              }}
            >
              {section.unread} unread{unreadOnly ? ' · showing' : ''}
            </button>
          )}
        </p>
      )}

      {search.error && <p className="mail-inline-error">{search.error}</p>}
      {!search.active && snapshot.listError && <p className="mail-inline-error">{snapshot.listError}</p>}

      <div className="mail-rows">
        {draftsView ? (
          <DraftsSections
            snapshot={snapshot}
            serverName={serverDrafts ? serverDrafts.name : null}
            serverRows={serverDrafts ? rows : []}
          />
        ) : !snapshot.selected && !search.active ? (
          <p className="mail-pane-empty" data-testid="mail-no-mailbox">
            Pick a mailbox on the left to read it.
          </p>
        ) : rows.length === 0 ? (
          <p className="mail-pane-empty" data-testid="mail-list-empty">
            {busy ? 'Loading…'
              : search.active ? 'Nothing matched. Cached search only sees mail Walnut has already fetched.'
                : 'No mail in this folder yet.'}
          </p>
        ) : visible.length === 0 ? (
          <p className="mail-pane-empty mail-unread-empty" data-testid="mail-unread-empty">
            <span>No unread messages</span>
            <button
              type="button"
              className="mail-text-btn"
              data-testid="mail-unread-show-all"
              onClick={showAll}
            >
              Show all
            </button>
          </p>
        ) : visible.map((message) => (
          <MailRow
            key={`${message.accountId} ${message.messageId}`}
            message={message}
            showMailbox={search.active}
            selected={snapshot.open?.messageId === message.messageId}
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
 * Whether a row stays on screen while "only unread" is on.
 *
 * Unread, or the message the person is READING. Marking a mail read is what opening it does, and a
 * row that disappears from under the pointer in the same click is the confident wrong answer: it
 * takes the reply and the make-a-task buttons with it and leaves no way back. It goes when they
 * select another row, which is the moment they are done with it.
 */
function keepWhileFiltering(message: MailMessageDto, snapshot: MailSnapshot): boolean {
  return isUnread(message.flags) || snapshot.open?.messageId === message.messageId;
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
          showMailbox={false}
          selected={snapshot.open?.messageId === message.messageId}
        />
      ))}
    </>
  );
}

function GroupHeader({ group, name, count }: { group: string; name: string; count: number }) {
  return (
    <p className="mail-rows-group" data-testid="mail-drafts-group" data-group={group}>
      <span className="mail-rows-group-name">{name}</span>
      <span className="mail-rows-group-count">{count}</span>
    </p>
  );
}

interface Section { name: string; count: number; unread: number }

/**
 * The folder header: which mailbox this column is, how many rows are loaded, and how many of them
 * are unread.
 *
 * The count is the ROWS ON SCREEN rather than the provider's total, because that is the number a
 * human can check by looking, and "Load older" is what says there are more. Null when nothing is
 * selected: there is no folder to name yet.
 */
function sectionOf(
  snapshot: MailSnapshot,
  draftsView: boolean,
  rows: MailMessageDto[],
  hasServerDrafts: boolean,
): Section | null {
  const selected = snapshot.selected;
  if (!selected) return null;
  if (draftsView) {
    // Both halves, so the header still counts the rows below it: with a server section the local
    // count alone would repeat "Written here" one line further up and describe a third of the list.
    const drafts = snapshot.drafts[selected.accountId] ?? [];
    return { name: 'Drafts', count: drafts.length + (hasServerDrafts ? rows.length : 0), unread: 0 };
  }
  const mailbox = (snapshot.mailboxes[selected.accountId] ?? [])
    .find((one) => one.mailboxId === selected.mailboxId);
  return {
    name: mailbox?.name || selected.mailboxId,
    count: rows.length,
    unread: rows.filter((one) => isUnread(one.flags)).length,
  };
}

function MailRow({ message, selected, showMailbox }: {
  message: MailMessageDto;
  selected: boolean;
  showMailbox: boolean;
}) {
  const unread = isUnread(message.flags);
  return (
    <button
      type="button"
      className={`mail-row${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      data-testid="mail-row"
      data-message-id={message.messageId}
      data-unread={unread}
      onClick={() => { void openMailMessage(message.accountId, message.messageId); }}
    >
      <span className="mail-row-top">
        {unread && <span className="mail-row-dot" aria-hidden="true" />}
        <span className="mail-row-from">{senderLabel(message.from)}</span>
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
      {showMailbox && <span className="mail-row-mailbox">{message.mailboxId}</span>}
    </button>
  );
}
