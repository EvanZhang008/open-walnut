/**
 * The smart mailbox group: one row per role that more than one account actually has.
 *
 * A row is an entry to a MERGED list, so it deliberately carries no folder glyph: the chevron already
 * holds the icon column, and a second mark would push the group's own rows further right than the
 * ordinary folder rows below them, which reads as "these belong to that account" (see the box model in
 * the slice spec). The chevron and the row are SIBLING buttons inside one line, because a button cannot
 * nest inside a button and the two do different things: the chevron only opens the group, the row
 * selects the merged list.
 *
 * Every number here comes from the same mailbox rows the message list header reads, which is the only
 * reason the sidebar and the header cannot disagree. Visibility and membership come from the HELD rows
 * (the pane freezes row insertions while somebody is aiming at it); the counts are always live.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MailAccountDto, MailboxDto } from '@/api/mail';
import { formatCount } from './mail-format';
import { selectMailbox, selectSmartMailbox } from './mail-actions';
import {
  DRAFTS_MAILBOX,
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  SMART_SENT,
  pairKey,
  type MailSelection,
  type SmartMailboxId,
} from './mail-store';
import {
  SMART_LABEL,
  accountsNotSyncing,
  degradedTitle,
  smartPairs,
  smartRowVisible,
  type SmartRole,
} from './mail-smart';
import type { SmartPrefId } from './mail-sidebar-prefs';
import { TwistIcon } from './mail-icons';

interface Props {
  accounts: MailAccountDto[];
  /** Membership and order. Held while the pointer or focus is inside the pane. */
  mailboxes: Record<string, MailboxDto[]>;
  /** This frame's mailbox rows, keyed by `pairKey`, so a badge moves in the frame a mail was read. */
  live: Record<string, MailboxDto>;
  /** Live unread per role, from `smartUnread` over the live rows. */
  unread: Record<SmartRole, number>;
  /** What each account's Drafts row opens onto, and the sum, which is the All Drafts row's number. */
  draftsCounts: Record<string, number>;
  draftsTotal: number;
  selected: MailSelection | null;
  expanded: Partial<Record<SmartPrefId, 1>>;
  onToggle: (id: SmartPrefId, on: boolean) => void;
  onPicked: () => void;
}

interface RowSpec {
  id: SmartMailboxId;
  role: SmartRole;
  pref: SmartPrefId;
  title: string;
}

/** The label comes from `SMART_LABEL`, which the message list header reads too, so they cannot drift. */
const ROWS: RowSpec[] = [
  { id: SMART_INBOX, role: 'inbox', pref: 'inbox', title: "Every account's inbox in one list" },
  { id: SMART_SENT, role: 'sent', pref: 'sent', title: "Every account's sent mail in one list" },
  { id: SMART_DRAFTS, role: 'drafts', pref: 'drafts', title: "Every account's drafts in one list" },
];

function accountLabel(account: MailAccountDto): string {
  return account.displayName || account.address;
}

export function MailSmartRows({
  accounts, mailboxes, live, unread, draftsCounts, draftsTotal, selected, expanded, onToggle, onPicked,
}: Props) {
  const shown = ROWS.filter((row) => smartRowVisible(mailboxes, accounts, row.role));
  // The group's hairline is this list's own border, so an install with no smart row has no hairline
  // either: nothing is drawn to separate.
  if (shown.length === 0) return null;
  return (
    <>
      {/* A visible group title, muted and small. Without it the three rows read as a third account. */}
      <p className="mail-smart-head" data-testid="mail-smart-head">Smart mailboxes</p>
      <ul className="mail-smart" aria-label="Smart mailboxes" data-testid="mail-smart">
        {shown.map((row) => (
          <SmartRow
            key={row.id}
            spec={row}
            accounts={accounts}
            mailboxes={mailboxes}
            live={live}
            unread={row.role === 'drafts' ? draftsTotal : unread[row.role]}
            draftsCounts={draftsCounts}
            selected={selected}
            open={expanded[row.pref] === 1}
            onToggle={onToggle}
            onPicked={onPicked}
          />
        ))}
      </ul>
    </>
  );
}

function SmartRow({ spec, accounts, mailboxes, live, unread, draftsCounts, selected, open, onToggle, onPicked }: {
  spec: RowSpec;
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  live: Record<string, MailboxDto>;
  unread: number;
  draftsCounts: Record<string, number>;
  selected: MailSelection | null;
  open: boolean;
  onToggle: (id: SmartPrefId, on: boolean) => void;
  onPicked: () => void;
}) {
  // The Drafts row is Walnut's own on both levels: every account has one whether or not its provider
  // keeps a Drafts folder, so its children are the accounts and its numbers are the drafts waiting on a
  // human. Inbox and Sent take the (account, mailbox) PAIRS, because the same role has a different id in
  // every account.
  const pairs = spec.role === 'drafts'
    ? accounts.map((one) => ({ accountId: one.accountId, mailboxId: DRAFTS_MAILBOX }))
    : smartPairs(mailboxes, accounts, spec.role);
  const covered = accounts.filter((one) => pairs.some((pair) => pair.accountId === one.accountId));
  const stopped = accountsNotSyncing(covered).length;
  const degraded = degradedTitle(stopped, covered.length);
  const active = selected?.accountId === SMART_ACCOUNT && selected.mailboxId === spec.id;
  const label = open ? `Hide accounts in ${SMART_LABEL[spec.role]}` : `Show accounts in ${SMART_LABEL[spec.role]}`;
  // ArrowRight opens and ArrowLeft closes, and neither moves the focus: a keyboard that throws you
  // somewhere else is worse than one that does nothing. No roving tabindex, so Tab order stays visual.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight' && !open) { event.preventDefault(); onToggle(spec.pref, true); }
    if (event.key === 'ArrowLeft' && open) { event.preventDefault(); onToggle(spec.pref, false); }
  };
  return (
    <li>
      <div className="mail-mailbox-line">
        <button
          type="button"
          className="mail-twist"
          data-testid="mail-smart-twist"
          data-smart={spec.role}
          /* WebKit leaves a `button` out of its tab order, and the Mac app is WKWebView: without an
             explicit zero the documented tab order exists only in Chromium. Zero keeps the visual order. */
          tabIndex={0}
          aria-expanded={open}
          aria-label={label}
          title={label}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            // Only the group opens. No request (the children's numbers are already in the mailbox
            // rows), no selection change, and on a narrow viewport no drill into the list.
            event.stopPropagation();
            onToggle(spec.pref, !open);
          }}
        >
          <TwistIcon />
        </button>
        <button
          type="button"
          className={`mail-mailbox smart${active ? ' active' : ''}`}
          data-testid="mail-smart-row"
          data-smart={spec.role}
          data-account-id={SMART_ACCOUNT}
          data-mailbox-id={spec.id}
          data-unread={unread}
          tabIndex={0}
          title={spec.title}
          aria-current={active ? 'true' : undefined}
          onKeyDown={onKeyDown}
          onClick={() => {
            selectSmartMailbox(spec.id);
            onPicked();
          }}
        >
          <span className="mail-mailbox-name">{SMART_LABEL[spec.role]}</span>
          {degraded && (
            <span
              className="mail-smart-warn"
              data-testid="mail-smart-warn"
              title={degraded}
              aria-label={degraded}
            />
          )}
          {unread > 0 && (
            <span className="mail-unread-badge" data-testid="mail-smart-unread">{formatCount(unread)}</span>
          )}
        </button>
      </div>
      {open && (
        <ul className="mail-smart-children" data-testid="mail-smart-children">
          {pairs.map((pair) => {
            const account = accounts.find((one) => one.accountId === pair.accountId);
            if (!account) return null;
            const childUnread = spec.role === 'drafts'
              ? draftsCounts[pair.accountId] ?? 0
              : live[pairKey(pair.accountId, pair.mailboxId)]?.unread ?? 0;
            const childActive = selected?.accountId === pair.accountId
              && selected.mailboxId === pair.mailboxId;
            return (
              <li key={pair.accountId}>
                <button
                  type="button"
                  /* `current`, NOT `active`. The mailbox this row points at is also drawn as that
                     account's own role row further down the pane, and giving both the full active fill
                     left two rows looking clicked 400px apart, the louder of which carried no
                     `aria-current`. `current` is a quiet mark (a rail and the accent, no fill), so the
                     group can still show which of its children is on screen without a second selection. */
                  className={`mail-mailbox child${childActive ? ' current' : ''}`}
                  data-testid="mail-smart-child"
                  data-account-id={pair.accountId}
                  data-mailbox-id={pair.mailboxId}
                  data-current={childActive ? 'true' : undefined}
                  data-unread={childUnread}
                  tabIndex={0}
                  /* The name is cut to about 124px at the pane's usual width, and two accounts whose
                     display names share a prefix truncate to the same string: the full address is the
                     only thing that tells them apart. */
                  title={account.address || accountLabel(account)}
                  /* NO `aria-current`, even when this row is the selected one. The same mailbox is also
                     drawn as that account's own role row further down the pane, and both rows carrying it
                     announced the current location twice to a screen reader. The row the person clicked
                     owns the state; this one keeps the quiet `current` mark above. */
                  onClick={() => {
                    selectMailbox(pair.accountId, pair.mailboxId);
                    onPicked();
                  }}
                >
                  <span className="mail-mailbox-name">{accountLabel(account)}</span>
                  {childUnread > 0 && (
                    <span className="mail-unread-badge" data-testid="mail-smart-child-unread">
                      {formatCount(childUnread)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
