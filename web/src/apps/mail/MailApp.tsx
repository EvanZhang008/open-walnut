import { useCallback, useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { AppComponentProps } from '../registry';
import { AddAccountDialog } from './AddAccountDialog';
import { MailAccountsPane } from './MailAccountsPane';
import { MailMessageList } from './MailMessageList';
import { MailReader } from './MailReader';
import { refreshMailAll } from './mail-actions';
import { useMailConsole } from './useMailConsole';
import './mail.css';

/**
 * The Mail console: accounts and their mailboxes, the selected mailbox's messages, and a reader.
 *
 * It talks to `/api/plugins/mail/*` and nothing else. There is deliberately no `/api/mail`
 * alias: mail has no existing client that needs one, so the plugin path is the only path.
 *
 * The screen is a core app rather than a plugin bundle for reasons that outlive this slice: a
 * mail reader needs host components a plugin bundle cannot import (sanitized HTML, menu
 * placement, task-ref pills), and the loader has no dev-time esbuild for a plugin's web entry,
 * so every UI change would need a committed bundle. It is gated with `requiresPlugin`, so the
 * row disappears when the plugin is off.
 *
 * Layout: three panes side by side, one pane at a time below 900px (the panes stay mounted, so
 * a drill down and back does not refetch or lose the reader's opted-in images).
 */

/** Below this the three panes cannot all be readable, so the console drills instead. */
const NARROW_QUERY = '(max-width: 899px)';

/**
 * A way out of a dead end.
 *
 * A screen that only states what went wrong leaves the human with the reload button as their one
 * idea, and both states this appears in (the cache still opening, a read that failed) are usually
 * over by the time it is read.
 */
function RetryButton({ busy }: { busy: boolean }) {
  return (
    <button
      type="button"
      className="mail-add-account"
      data-testid="mail-retry"
      disabled={busy}
      onClick={() => { void refreshMailAll(); }}
    >
      {busy ? 'Trying…' : 'Try again'}
    </button>
  );
}

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function MailApp(_props: AppComponentProps) {
  const mail = useMailConsole();
  const narrow = useNarrowViewport();
  const [adding, setAdding] = useState(false);
  const [showMailboxes, setShowMailboxes] = useState(false);

  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  // Which pane a narrow viewport shows. The reader wins, then an explicit request for the
  // mailbox list, then the list itself; with nothing selected there is only the account list.
  const pane = !narrow
    ? 'all'
    : mail.open ? 'reader'
      : (showMailboxes || !mail.selected) ? 'accounts'
        : 'list';

  const dialog = adding ? (
    <AddAccountDialog
      providers={mail.providers}
      onClose={closeAdd}
      onAdded={() => { setAdding(false); setShowMailboxes(false); }}
    />
  ) : null;

  if (mail.loading && !mail.loaded && !mail.stand) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <LoadingSpinner />
      </div>
    );
  }

  if (mail.stand) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <div className="empty-state" data-testid="mail-app-stand-in">
          <p>{mail.stand.title}</p>
          <p>{mail.stand.detail}</p>
          {mail.stand.retryable && <RetryButton busy={mail.loading} />}
        </div>
      </div>
    );
  }

  if (mail.error && !mail.loaded) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <div className="empty-state" data-testid="mail-app-error">
          <p>Mail is not answering right now: {mail.error}</p>
          <RetryButton busy={mail.loading} />
        </div>
      </div>
    );
  }

  if (mail.accounts.length === 0) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <div className="empty-state" data-testid="mail-app-empty">
          <p>No mail accounts yet</p>
          <p>
            {mail.providers.length === 0
              ? 'Install a provider plugin (IMAP, for example) and it will add accounts here.'
              : 'A provider plugin adds accounts here. Ready to use: '
                + mail.providers.map((provider) => provider.label).join(', ')}
          </p>
          {mail.providers.length > 0 && (
            <button type="button" className="mail-add-account" data-testid="mail-add-account" onClick={openAdd}>
              + Add account
            </button>
          )}
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div className="mail-app mail-app-panes" data-testid="mail-app">
      <div className="mail-console" data-narrow-pane={pane}>
        <MailAccountsPane
          accounts={mail.accounts}
          mailboxes={mail.mailboxes}
          selected={mail.selected}
          refreshing={mail.refreshing}
          refreshNote={mail.refreshNote}
          onAddAccount={openAdd}
          onPicked={() => setShowMailboxes(false)}
        />
        <MailMessageList
          snapshot={mail}
          narrow={narrow}
          onShowMailboxes={() => setShowMailboxes(true)}
        />
        <MailReader open={mail.open} narrow={narrow} />
      </div>
      {dialog}
    </div>
  );
}

function MailHeader() {
  return (
    <div className="page-header">
      <h1 className="page-title">Mail</h1>
      <p className="page-subtitle">Accounts come from mail provider plugins</p>
    </div>
  );
}
