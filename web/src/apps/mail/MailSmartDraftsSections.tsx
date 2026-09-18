/**
 * What All Drafts shows: every account's unfinished mail, in the shape one account's Drafts row uses.
 *
 * The merged row cannot be a message list like All Inboxes is. The per-account Drafts row deliberately
 * puts TWO stores under one row (the drafts written in this console, which have an approval state and
 * are editable, and whatever another device left in the provider's Drafts folder). Merged, that becomes:
 * one group per account for what was written here, then one group per account that actually keeps a
 * server folder. An account without such a folder appears once, in the first half, and the word "server"
 * is never printed against it.
 *
 * The GROUPS ARE THE BADGE, spelled out: every group count adds up to the row's badge and to this view's
 * header, so a person can check that number by counting rows instead of trusting it. The badge used to be
 * the first half only, so a row saying 1 opened onto four drafts.
 *
 * `renderRow` comes from the message list rather than a row component imported here: the two drafts
 * views and the merged message list draw the same row, and taking it as a prop keeps this file out of
 * an import cycle with the list that renders it.
 */
import type { ReactNode } from 'react';
import type { MailAccountDto, MailDraftDto, MailMessageDto } from '@/api/mail';
import { MailDraftsList } from './compose/MailDraftsList';
import { serverDraftsMailbox, type MailSnapshot } from './mail-store';

interface Props {
  snapshot: MailSnapshot;
  /** One page of every account's provider drafts folder, from the single merged query. */
  serverRows: MailMessageDto[];
  renderRow: (message: MailMessageDto) => ReactNode;
}

/** `displayName || address`, the same string the account head and the sidebar child rows print. */
function nameOf(account: MailAccountDto): string {
  return account.displayName || account.address;
}

export function MailSmartDraftsSections({ snapshot, serverRows, renderRow }: Props) {
  const accounts = snapshot.accounts;
  const written = accounts
    .map((account) => ({ account, drafts: snapshot.drafts[account.accountId] ?? [] }))
    .filter((one) => one.drafts.length > 0);
  // Only accounts that really keep a Drafts folder get a second group. This is the same question the
  // per-account view asks, asked once per account.
  const onServer = accounts.filter(
    (account) => !!serverDraftsMailbox(snapshot.mailboxes[account.accountId]),
  );

  if (written.length === 0 && onServer.length === 0) {
    // Nothing written anywhere and no provider folder: one sentence, the same one the per-account row
    // shows, rather than a page of empty group headers.
    return <MailDraftsList drafts={[]} openDraftId={null} loading={snapshot.draftsLoading} />;
  }

  return (
    <>
      {written.length === 0 ? (
        /* WITH its own heading. "No drafts. Start one with New message." used to sit unlabelled at the
           top of a view listing three real drafts under labelled groups, so it read as the empty state
           of the whole view: the common case (nothing written here yet, drafts waiting on the server)
           was the one that contradicted itself. */
        <>
          <GroupHeader group="written-here" name="Written here" count={0} />
          <MailDraftsList drafts={[]} openDraftId={null} loading={snapshot.draftsLoading} />
        </>
      ) : written.map(({ account, drafts }) => (
        <WrittenHere key={account.accountId} account={account} drafts={drafts} snapshot={snapshot} />
      ))}
      {onServer.map((account) => (
        <OnTheServer
          key={account.accountId}
          account={account}
          rows={serverRows.filter((one) => one.accountId === account.accountId)}
          loading={snapshot.listLoading}
          renderRow={renderRow}
        />
      ))}
    </>
  );
}

/**
 * One account's own drafts.
 *
 * Editing one from here opens the composer on the draft's own account: `openMailDraft` reads
 * `draft.accountId`, never the current selection, which is what makes a merged list safe to write from.
 */
function WrittenHere({ account, drafts, snapshot }: {
  account: MailAccountDto;
  drafts: MailDraftDto[];
  snapshot: MailSnapshot;
}) {
  return (
    <>
      <GroupHeader
        group="written-here"
        accountId={account.accountId}
        name={`Written here · ${nameOf(account)}`}
        /* EVERY draft this account has here, not only the ones waiting on a human: the group counts what
           is listed under it, and the group counts have to add up to the row's badge and to this view's
           header, so a person can check that number by counting rows. */
        count={drafts.length}
      />
      <MailDraftsList
        drafts={drafts}
        openDraftId={snapshot.composer?.draftId ?? null}
        loading={snapshot.draftsLoading}
      />
    </>
  );
}

/** One account's provider Drafts folder, drawn from the merged page rather than its own request. */
function OnTheServer({ account, rows, loading, renderRow }: {
  account: MailAccountDto;
  rows: MailMessageDto[];
  loading: boolean;
  renderRow: (message: MailMessageDto) => ReactNode;
}) {
  return (
    <>
      <GroupHeader
        group="on-the-server"
        accountId={account.accountId}
        name={`On the server · ${nameOf(account)}`}
        count={rows.length}
      />
      {rows.length === 0 ? (
        <p className="mail-pane-empty" data-testid="mail-server-drafts-empty">
          {loading ? 'Loading…' : `Nothing in the Drafts folder of ${nameOf(account)}.`}
        </p>
      ) : rows.map(renderRow)}
    </>
  );
}

/**
 * A group heading inside the rows column.
 *
 * Shared with the per-account drafts view, which is where it started: two views drawing the same
 * heading two ways is how "Written here" ends up one weight in one of them.
 */
export function GroupHeader({ group, name, count, accountId }: {
  group: string;
  name: string;
  count: number;
  accountId?: string;
}) {
  return (
    <p
      className="mail-rows-group"
      data-testid="mail-drafts-group"
      data-group={group}
      {...(accountId ? { 'data-account-id': accountId } : {})}
    >
      <span className="mail-rows-group-name">{name}</span>
      <span className="mail-rows-group-count">{count}</span>
    </p>
  );
}
