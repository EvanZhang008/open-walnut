/**
 * The reader head's one line about sorting: `In Ticket updates · Automated ticket status change ·
 * Not right?`. Only for a mail opened from the grouped inbox (only those rows carry `sort`); the
 * group rows themselves say nothing per mail, so a column of rows is not a column of reasons.
 *
 * `Not right?` opens the same correction card as the row menu's `Important…` / `Not important…`,
 * anchored on this line.
 */
import { useRef } from 'react';
import { groupsViewKey, requestMailCorrect } from './mail-groups-bus';
import { NOT_RIGHT, readerWhyText } from './mail-groups-copy';
import { groupedOnScreen } from './mail-groups-live';
import { useGroupedRow, useGroupsView } from './mail-groups-store';
import { useGroupedPref } from './mail-grouped-pref';
import type { MailOpenMessage } from './mail-store';
import './mail-groups.css';

export function MailSortLine({ open }: { open: MailOpenMessage }) {
  const on = useGroupedPref();
  const line = useRef<HTMLParagraphElement | null>(null);
  const shown = groupedOnScreen();
  // Follows the view (a correction, a relabel) and the open message's own grouped row as pages land.
  useGroupsView(shown ?? { role: 'inbox' });
  const row = useGroupedRow(open.accountId, open.messageId);
  if (!on) return null;
  const sort = row?.sort;
  if (!row || !sort) return null;
  const label = sort.label ?? (sort.group === 'important' ? 'Important' : sort.group.replace(/^[us]:/, ''));
  const scope = shown ?? { accountId: row.accountId, mailboxId: row.mailboxId };
  return (
    <p className="mail-reader-sort" data-testid="mail-reader-sort" data-group-id={sort.group} data-reason={sort.reason} ref={line}>
      <span className="mail-reader-sort-text">{readerWhyText(label, sort.why)}</span>
      <span className="mail-reader-sort-sep" aria-hidden="true">·</span>
      <button
        type="button"
        className="mail-text-btn mail-reader-sort-fix"
        data-testid="mail-reader-sort-fix"
        onClick={(event) => {
          requestMailCorrect({
            accountId: row.accountId,
            messageId: row.messageId,
            groupId: sort.group,
            groupLabel: label,
            scope,
            viewKey: groupsViewKey(scope),
            anchor: line.current ?? event.currentTarget,
            returnFocus: event.currentTarget,
          });
        }}
      >
        {NOT_RIGHT}
      </button>
    </p>
  );
}
