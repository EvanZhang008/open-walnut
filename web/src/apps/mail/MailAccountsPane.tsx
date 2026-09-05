/**
 * The left pane: every account, its mailboxes, and the two controls that change the set.
 *
 * An account that cannot be reached is shown WITH its state rather than hidden or silently
 * empty: a mailbox that has stopped updating and never says so is the failure this pane exists
 * to prevent. `auth-required` also says what fixes it, because polling has stopped for that
 * account until a human acts and no amount of waiting or clicking refresh will change that.
 */
import type { MailAccountDto, MailDraftDto, MailProviderSummary, MailboxDto } from '@/api/mail';
import { DRAFTS_MAILBOX, type MailSelection } from './mail-store';
import { requestMailRefresh, selectMailbox } from './mail-actions';
import { openMailComposer } from './compose/compose-actions';
import { CANNOT_SEND_TITLE, canSendFrom, isOpenDraft } from './compose/send-status';
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

const STATE_LABEL: Record<string, string> = {
  'auth-required': 'Sign-in needed',
  disabled: 'Paused',
};

export function MailAccountsPane({
  accounts, mailboxes, drafts, providers, selected, refreshing, refreshNote, onAddAccount, onPicked,
}: Props) {
  // The compose entry point belongs to the SELECTED account, and whether it may send is the
  // provider's declared capability (there is no per-account capability on any route yet). An
  // account whose provider cannot send says so on the button rather than failing on the click.
  const composeAccount = selected?.accountId;
  const canCompose = canSendFrom(providers, composeAccount);
  return (
    <aside className="mail-accounts-pane" data-testid="mail-accounts-pane">
      <div className="mail-pane-head">
        <span className="mail-pane-title">Mailboxes</span>
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

              {rows.length === 0 && (
                <p className="mail-account-hint">No folders yet. The first sync lists them.</p>
              )}

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

                {/* The Drafts row is Walnut's own, not the provider's: these drafts live in the
                    plugin's database with their approval state, which a provider's own Drafts
                    folder knows nothing about. */}
                <li>
                  <DraftsRow
                    accountId={account.accountId}
                    drafts={drafts[account.accountId] ?? []}
                    active={selected?.accountId === account.accountId
                      && selected.mailboxId === DRAFTS_MAILBOX}
                    onPicked={onPicked}
                  />
                </li>
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
      {waiting > 0 && (
        <span className="mail-unread-badge" data-testid="mail-drafts-count">
          {waiting > 99 ? '99+' : waiting}
        </span>
      )}
    </button>
  );
}
