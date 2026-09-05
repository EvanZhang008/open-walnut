/**
 * The left pane: every account, its mailboxes, and the two controls that change the set.
 *
 * An account that cannot be reached is shown WITH its state rather than hidden or silently
 * empty: a mailbox that has stopped updating and never says so is the failure this pane exists
 * to prevent. `auth-required` also says what fixes it, because polling has stopped for that
 * account until a human acts and no amount of waiting or clicking refresh will change that.
 */
import type { MailAccountDto, MailboxDto } from '@/api/mail';
import type { MailSelection } from './mail-store';
import { requestMailRefresh, selectMailbox } from './mail-actions';
import { MailboxRoleIcon, RefreshIcon } from './mail-icons';

interface Props {
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  selected: MailSelection | null;
  refreshing: boolean;
  refreshNote: string | null;
  onAddAccount: () => void;
  /** A narrow viewport drills back to the list once a mailbox is picked. */
  onPicked: () => void;
}

const STATE_LABEL: Record<string, string> = {
  'auth-required': 'Sign-in needed',
  disabled: 'Paused',
};

export function MailAccountsPane({
  accounts, mailboxes, selected, refreshing, refreshNote, onAddAccount, onPicked,
}: Props) {
  return (
    <aside className="mail-accounts-pane" data-testid="mail-accounts-pane">
      <div className="mail-pane-head">
        <span className="mail-pane-title">Mailboxes</span>
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
      </div>

      {refreshNote && (
        <p className="mail-refresh-note" data-testid="mail-refresh-note">{refreshNote}</p>
      )}

      <div className="mail-accounts-scroll">
        {accounts.map((account) => {
          const rows = mailboxes[account.accountId] ?? [];
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

              {rows.length === 0 ? (
                <p className="mail-account-hint">No folders yet. The first sync lists them.</p>
              ) : (
                <ul className="mail-mailboxes">
                  {rows.map((mailbox) => {
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
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            selectMailbox(account.accountId, mailbox.mailboxId);
                            onPicked();
                          }}
                        >
                          <MailboxRoleIcon role={mailbox.role} />
                          <span className="mail-mailbox-name">{mailbox.name}</span>
                          {mailbox.unread > 0 && (
                            <span className="mail-unread-badge" data-testid="mail-mailbox-unread">
                              {mailbox.unread > 99 ? '99+' : mailbox.unread}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
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
