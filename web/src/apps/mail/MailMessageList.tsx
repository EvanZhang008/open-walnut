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
import { DRAFTS_MAILBOX, type MailSnapshot } from './mail-store';
import { MailDraftsList } from './compose/MailDraftsList';
import { AttachmentIcon, BackIcon, SearchIcon } from './mail-icons';

interface Props {
  snapshot: MailSnapshot;
  narrow: boolean;
  onShowMailboxes: () => void;
}

export function MailMessageList({ snapshot, narrow, onShowMailboxes }: Props) {
  const [draft, setDraft] = useState('');
  const selectedKey = snapshot.selected
    ? `${snapshot.selected.accountId}/${snapshot.selected.mailboxId}`
    : '';
  // Switching mailbox drops the search MODE in the store, so leaving the words in the box would
  // show a query next to results that are not its results.
  useEffect(() => { setDraft(''); }, [selectedKey]);
  const search = snapshot.search;
  const rows = search.active ? search.messages : snapshot.messages;
  const busy = search.active ? search.loading : snapshot.listLoading;
  // Walnut's own drafts, not a provider folder: a virtual mailbox id selects them (see the store).
  const draftsView = !search.active && snapshot.selected?.mailboxId === DRAFTS_MAILBOX;

  const clear = () => { setDraft(''); clearMailSearch(); };
  const section = search.active ? null : sectionOf(snapshot, draftsView, rows);

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
          <span className="mail-list-section-count">{section.count}</span>
          {section.unread > 0 && (
            <span className="mail-list-section-unread">{section.unread} unread</span>
          )}
        </p>
      )}

      {search.error && <p className="mail-inline-error">{search.error}</p>}
      {!search.active && snapshot.listError && <p className="mail-inline-error">{snapshot.listError}</p>}

      <div className="mail-rows">
        {draftsView ? (
          <MailDraftsList
            drafts={snapshot.drafts[snapshot.selected!.accountId] ?? []}
            openDraftId={snapshot.composer?.draftId ?? null}
            loading={snapshot.draftsLoading}
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
        ) : rows.map((message) => (
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

interface Section { name: string; count: number; unread: number }

/**
 * The folder header: which mailbox this column is, how many rows are loaded, and how many of them
 * are unread.
 *
 * The count is the ROWS ON SCREEN rather than the provider's total, because that is the number a
 * human can check by looking, and "Load older" is what says there are more. Null when nothing is
 * selected: there is no folder to name yet.
 */
function sectionOf(snapshot: MailSnapshot, draftsView: boolean, rows: MailMessageDto[]): Section | null {
  const selected = snapshot.selected;
  if (!selected) return null;
  if (draftsView) {
    const drafts = snapshot.drafts[selected.accountId] ?? [];
    return { name: 'Drafts', count: drafts.length, unread: 0 };
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
