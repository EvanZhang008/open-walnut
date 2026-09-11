/**
 * The left pane: every account, its mailboxes, and the two controls that change the set.
 *
 * An account that cannot be reached is shown WITH its state rather than hidden or silently
 * empty: a mailbox that has stopped updating and never says so is the failure this pane exists
 * to prevent. `auth-required` also says what fixes it, because polling has stopped for that
 * account until a human acts and no amount of waiting or clicking refresh will change that.
 */
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { MailAccountDto, MailDraftDto, MailProviderSummary, MailboxDto } from '@/api/mail';
import { ContextMenu } from '@/components/common/ContextMenu';
import { DRAFTS_MAILBOX, serverDraftsMailbox, type MailSelection } from './mail-store';
import { requestMailRefresh, selectMailbox } from './mail-actions';
import { sendMailDigest } from './mail-task-actions';
import { openMailComposer } from './compose/compose-actions';
import { CANNOT_SEND_TITLE, canSendFrom, isOpenDraft } from './compose/send-status';
import { formatCount } from './mail-format';
import { ComposeIcon, DraftsIcon, MailboxRoleIcon, RefreshIcon } from './mail-icons';

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

const STATE_LABEL: Record<string, string> = {
  'auth-required': 'Sign-in needed',
  disabled: 'Paused',
};

export function MailAccountsPane({
  accounts, mailboxes, drafts, providers, selected, refreshing, refreshNote, onAddAccount, onPicked,
}: Props) {
  // The compose entry point belongs to the SELECTED account, and whether it may send is that
  // ACCOUNT's own capability when the server sent one, the provider's otherwise. An account that
  // cannot send says so on the button rather than failing on the click.
  const composeAccount = selected?.accountId;
  const canCompose = canSendFrom(providers, composeAccount, accounts);
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
    <aside className="mail-accounts-pane" data-testid="mail-accounts-pane">
      {/* No pane title: the folders are directly below and name themselves, and the 232px head has
          three controls to fit. The primary action gets the room instead. */}
      <div className="mail-pane-head">
        <button
          type="button"
          className="mail-compose-new"
          data-testid="mail-compose-new"
          title={canCompose ? 'Write a new message' : CANNOT_SEND_TITLE}
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
        {accounts.map((account) => {
          const all = mailboxes[account.accountId] ?? [];
          // The provider's own Drafts folder leaves the list: the ONE Drafts row below reaches it,
          // in the place that folder held, so the order a person knows their mailbox by is kept.
          const rows = all.filter((mailbox) => mailbox.role !== 'drafts');
          const draftsAt = serverDraftsMailbox(all) ? all.findIndex((one) => one.role === 'drafts') : rows.length;
          const stateLabel = account.state === 'active' ? null : STATE_LABEL[account.state] ?? account.state;
          return (
            <section className="mail-account" key={account.accountId} data-account-id={account.accountId}>
              <header className="mail-account-head">
                <span className="mail-account-name">{account.displayName || account.address}</span>
                {account.address && account.displayName !== account.address && (
                  <span className="mail-account-address">{account.address}</span>
                )}
                {stateLabel && (
                  <span
                    className="mail-account-state"
                    data-testid="mail-account-state"
                    data-state={account.state}
                  >
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

              {/* `all`, not the filtered rows: an account whose only folder is Drafts has been
                  listed, and the merged row below is showing it. */}
              {all.length === 0 && (
                <p className="mail-account-hint">No folders yet. The first sync lists them.</p>
              )}

              <ul className="mail-mailboxes">
                {withDraftsRow(
                  rows.map((mailbox) => {
                    const active = selected?.accountId === account.accountId
                      && selected.mailboxId === mailbox.mailboxId;
                    return (
                      <li key={mailbox.mailboxId}>
                        <button
                          type="button"
                          className={`mail-mailbox${active ? ' active' : ''}`}
                          data-mailbox-id={mailbox.mailboxId}
                          data-account-id={account.accountId}
                          data-unread={mailbox.unread}
                          data-total={mailbox.total}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            selectMailbox(account.accountId, mailbox.mailboxId);
                            onPicked();
                          }}
                        >
                          <MailboxRoleIcon role={mailbox.role} />
                          <span className="mail-mailbox-name">{mailbox.name}</span>
                          {/* The EXACT number, from this mailbox row, which is the same row the list
                              header's own two numbers come from. It used to cap at "99+", and a
                              folder saying "Inbox 99+" next to a header saying "5 unread" is two
                              numbers a human cannot reconcile by looking. The badge grows instead
                              and the folder name gives up the width (see mail.css). */}
                          {mailbox.unread > 0 && (
                            <span className="mail-unread-badge" data-testid="mail-mailbox-unread">
                              {formatCount(mailbox.unread)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  }),
                  draftsAt,
                  /* ONE Drafts row for both kinds. Walnut's own drafts live in the plugin's
                     database with their approval state, which a provider's Drafts folder knows
                     nothing about; the folder holds what another device wrote. The row opens a
                     list with a section for each. */
                  <li key="walnut-drafts">
                    <DraftsRow
                      accountId={account.accountId}
                      drafts={drafts[account.accountId] ?? []}
                      active={selected?.accountId === account.accountId
                        && selected.mailboxId === DRAFTS_MAILBOX}
                      onPicked={onPicked}
                    />
                  </li>,
                )}
              </ul>
            </section>
          );
        })}
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

/**
 * One account's Drafts row.
 *
 * The badge counts what is still WAITING ON A HUMAN (composing, waiting for approval, failed,
 * unknown) rather than the list length: a row that is mid-send needs nobody's attention, and a
 * badge that counts it trains the human to ignore the number.
 */
function DraftsRow({ accountId, drafts, active, onPicked }: {
  accountId: string;
  drafts: MailDraftDto[];
  active: boolean;
  onPicked: () => void;
}) {
  const waiting = drafts.filter(isOpenDraft).length;
  return (
    <button
      type="button"
      className={`mail-mailbox${active ? ' active' : ''}`}
      data-testid="mail-drafts-row"
      data-mailbox-id={DRAFTS_MAILBOX}
      data-account-id={accountId}
      data-count={waiting}
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
