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
import type { MailSnapshot } from './mail-store';
import { AttachmentIcon, BackIcon } from './mail-icons';

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

  const clear = () => { setDraft(''); clearMailSearch(); };

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

      {search.error && <p className="mail-inline-error">{search.error}</p>}
      {!search.active && snapshot.listError && <p className="mail-inline-error">{snapshot.listError}</p>}

      <div className="mail-rows">
        {!snapshot.selected && !search.active ? (
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
        <span className="mail-row-from">{senderLabel(message.from)}</span>
        <span className="mail-row-time">{formatMailTime(message.sentAt)}</span>
      </span>
      <span className="mail-row-subject">
        {message.subject || '(no subject)'}
        {message.attachments.length > 0 && (
          <span className="mail-row-clip" aria-label="has attachments"><AttachmentIcon /></span>
        )}
      </span>
      <span className="mail-row-snippet">{message.snippet}</span>
      {showMailbox && <span className="mail-row-mailbox">{message.mailboxId}</span>}
    </button>
  );
}
