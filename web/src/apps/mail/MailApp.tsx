import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, LoadingState, UnavailableState, type EmptyStateAction } from '@/components/common/EmptyState';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { AppComponentProps } from '../registry';
import { AddAccountDialog } from './AddAccountDialog';
import { MailAccountsPane } from './MailAccountsPane';
import { MailMessageList } from './MailMessageList';
import { MailAskDrawer } from './MailAskDrawer';
import { MailGroupsLearnHost } from './MailGroupsLearnHost';
import { MailPaneSplitter } from './MailPaneSplitter';
import { MailReader } from './MailReader';
import { blankAccountsRoom, useRowStaysPut } from './mail-reader-room';
import { ComposerPanel } from './compose/ComposerPanel';
import { CANNOT_SEND_TITLE, canSendFrom } from './compose/send-status';
import { openMailDeepLink, refreshMailAll } from './mail-actions';
import { paneStyle, readPaneWidths, writePaneWidths, type MailPaneId, type PaneWidths } from './mail-pane-widths';
import { useMailConsole } from './useMailConsole';
import './mail.css';
import './mail-compose.css';

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
 * Layout: three panes side by side, one pane at a time below 1100px (the panes stay mounted, so
 * a drill down and back does not refetch or lose the reader's opted-in images). With nothing open
 * the reader is a narrow hint and the list takes its room (mail-reader-room.ts).
 */

/**
 * Below this the three panes cannot all be readable, so the console drills instead.
 *
 * 1100 rather than 900: the window holds the app's own 240px sidebar as well, so at 900 the reader
 * was left with under 100px of column, and a mail reader that narrow is not a smaller version of
 * the design, it is a different one. Three panes need about 1100px before the reader has a measure.
 */
const NARROW_QUERY = '(max-width: 1099px)';

/**
 * A way out of a dead end.
 *
 * A screen that only states what went wrong leaves the human with the reload button as their one
 * idea, and both states this appears in (the cache still opening, a read that failed) are usually
 * over by the time it is read.
 */
/** Ask every mail route again; a press while the last ask still runs does nothing. */
function retryAction(busy: boolean): EmptyStateAction {
  return {
    label: busy ? 'Trying…' : 'Try again',
    testId: 'mail-retry',
    disabled: busy,
    onClick: () => { void refreshMailAll(); },
  };
}

/**
 * `?account=&message=`, which is what a task's backlink and a digest letter point at.
 *
 * Applied ONCE per pair rather than on every render: `openMailDeepLink` selects a mailbox, which
 * loads a page, which re-renders this component, and a naive effect would then open the same message
 * again forever. The pair is remembered in a ref (not in state) so noticing it costs no render, and
 * the query is deliberately left in the URL: it is what the human copied, and rewriting it would
 * break the back button on the way in.
 */
function useMailDeepLink(search: string, ready: boolean): void {
  const applied = useRef('');
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(search);
    const accountId = params.get('account');
    const messageId = params.get('message');
    if (!accountId || !messageId) return;
    const key = JSON.stringify([accountId, messageId, params.get('readOnly')]);
    if (applied.current === key) return;
    applied.current = key;
    void openMailDeepLink(accountId, messageId, { markRead: params.get('readOnly') !== '1' });
  }, [search, ready]);
}

const PANE_CLASS: Record<MailPaneId, string> = { accounts: 'mail-accounts-pane', list: 'mail-list-pane' };

/** The two left columns' dragged widths: live while dragging, persisted when a drag settles. */
function usePaneWidths() {
  const [widths, setWidths] = useState<PaneWidths>(readPaneWidths);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const saved = useRef(widths);
  const measure = useCallback((id: MailPaneId) => {
    const box = consoleRef.current;
    const column = box?.querySelector<HTMLElement>(`:scope > .${PANE_CLASS[id]}`);
    const other = box?.querySelector<HTMLElement>(`:scope > .${PANE_CLASS[id === 'accounts' ? 'list' : 'accounts']}`);
    if (!box || !column || !other) return null;
    const width = column.getBoundingClientRect().width;
    // With nothing to read the list is the flexible column, so its width on screen is no bound.
    if (id === 'accounts' && box.dataset.reader === 'blank') return { width, room: blankAccountsRoom(box.clientWidth) };
    return { width, room: box.clientWidth - other.getBoundingClientRect().width };
  }, []);
  const live = useCallback((id: MailPaneId, width: number) => setWidths((now) => ({ ...now, [id]: width })), []);
  const done = useCallback((id: MailPaneId, width: number) => {
    saved.current = { ...saved.current, [id]: width };
    writePaneWidths(saved.current);
    setWidths(saved.current);
  }, []);
  const reset = useCallback((id: MailPaneId) => {
    const { [id]: _gone, ...rest } = saved.current;
    saved.current = rest;
    writePaneWidths(rest);
    setWidths(rest);
  }, []);
  return { widths, consoleRef, measure, live, done, reset };
}

export function MailApp(props: AppComponentProps) {
  const mail = useMailConsole();
  const narrow = useMediaQuery(NARROW_QUERY);
  const panes = usePaneWidths();
  const [adding, setAdding] = useState(false);
  const [showMailboxes, setShowMailboxes] = useState(false);
  // Only once the accounts are in: the deep link reads one message and then selects its mailbox, and
  // doing that before the console has its account list would race `ensureSelection`, which would then
  // move the human off the message they followed a link to.
  useMailDeepLink(props.search, mail.loaded && mail.accounts.length > 0);
  // Something in the reader slot. With nothing there the list takes the room and the reader is a narrow
  // hint (mail.css, `data-reader`); the dragged list width comes back the moment something opens.
  const reading = !!(mail.open || mail.composer || mail.ask);
  useRowStaysPut(panes.consoleRef, reading, !narrow);

  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  // Which pane a narrow viewport shows. The reader slot wins (the composer lives in it, and both
  // carry their own back control), then an explicit request for the mailbox list, then the list
  // itself; with nothing selected there is only the account list.
  const pane = !narrow
    ? 'all'
    : (mail.open || mail.composer || mail.ask) ? 'reader'
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
        <LoadingState size="pane" title="Loading mail…" />
      </div>
    );
  }

  if (mail.stand) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <UnavailableState
          size="pane"
          title={mail.stand.title}
          hint={mail.stand.detail}
          action={mail.stand.retryable ? retryAction(mail.loading) : undefined}
          testId="mail-app-stand-in"
        />
      </div>
    );
  }

  if (mail.error && !mail.loaded) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <UnavailableState
          size="pane"
          title="Mail is not answering right now"
          hint={mail.error}
          action={retryAction(mail.loading)}
          testId="mail-app-error"
        />
      </div>
    );
  }

  if (mail.accounts.length === 0) {
    return (
      <div className="mail-app" data-testid="mail-app">
        <MailHeader />
        <EmptyState
          size="pane"
          title="No mail accounts yet"
          hint={mail.providers.length === 0
            ? 'Install a provider plugin (IMAP, for example) and it will add accounts here.'
            : 'A provider plugin adds accounts here. Ready to use: '
              + mail.providers.map((provider) => provider.label).join(', ') + '.'}
          action={mail.providers.length > 0
            ? { label: 'Add account', onClick: openAdd, primary: true, testId: 'mail-add-account' }
            : undefined}
          testId="mail-app-empty"
        />
        {dialog}
      </div>
    );
  }

  return (
    <div className="mail-app mail-app-panes" data-testid="mail-app">
      <div
        className="mail-console"
        data-narrow-pane={pane}
        {...(narrow ? {} : { 'data-reader': reading ? 'open' : 'blank' })}
        ref={panes.consoleRef}
        style={narrow ? undefined : paneStyle(panes.widths)}
      >
        {/* First in the DOM so the reader stays `:last-child`; absolutely placed, so no grid cell. The
            list's handle only while something is open: with nothing to read the list fills the room,
            and a drag there would move nothing on screen. */}
        {!narrow && (reading ? ['accounts', 'list'] as MailPaneId[] : ['accounts'] as MailPaneId[]).map((id) => (
          <MailPaneSplitter
            key={id}
            id={id}
            width={panes.widths[id]}
            onWidth={(width) => panes.live(id, width)}
            onDone={(width) => panes.done(id, width)}
            onReset={() => panes.reset(id)}
            measure={() => panes.measure(id)}
          />
        ))}
        <MailAccountsPane
          accounts={mail.accounts}
          mailboxes={mail.mailboxes}
          drafts={mail.drafts}
          providers={mail.providers}
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
        {/* One slot, three tenants: the Ask drawer, the composer, then the reader. Writing a mail or
            asking about one is a task you look things up during, so the two panes on its left stay
            live. The order cannot be observed, because everything that takes this pane clears the
            others (`openMailAsk`'s callers close a composer, `openMailMessage` and `handOver` clear
            `ask`); it is written widest-first so a state that did slip through still shows the pane
            the person asked for last. */}
        {mail.ask ? (
          <MailAskDrawer ask={mail.ask} accounts={mail.accounts} />
        ) : mail.composer ? (
          <ComposerPanel
            composer={mail.composer}
            mailboxes={mail.mailboxes[mail.composer.accountId] ?? []}
            drafts={mail.drafts[mail.composer.accountId] ?? []}
            narrow={narrow}
            canSend={canSendFrom(mail.providers, mail.composer.accountId, mail.accounts)}
            cannotSendTitle={CANNOT_SEND_TITLE}
          />
        ) : (
          <MailReader open={mail.open} narrow={narrow} accounts={mail.accounts} providers={mail.providers} />
        )}
      </div>
      {dialog}
      {/* The correction card and Sort senders: portalled, opened from the grouped list via the bus. */}
      <MailGroupsLearnHost />
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
