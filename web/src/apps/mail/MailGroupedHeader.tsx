/**
 * The grouped list's header, one line: `INBOX  19 unread  Grouped ▾`.
 *
 * While the model is still sorting new mail the count gives way to `Sorting 3 new` (that mail waits in
 * Important until it is sorted, so the reader is told why Important looks full); when the model is not
 * answering, a muted `Sorted without AI` says the groups are by sender for now. The view switch is a
 * small menu at the end of the same line, not a row of its own: a 336px column cannot spare a line
 * for a control somebody touches once.
 */
import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import type { MailGroupsScope } from '@/api/mail-groups';
import { loadMailMessages } from './mail-actions';
import { formatCount } from './mail-format';
import { useGroupedBadge } from './mail-groups-live';
import { writeGroupedPref } from './mail-grouped-pref';
import {
  ALL_MAIL, GROUPED, SORTED_WITHOUT_AI, SORTED_WITHOUT_AI_TITLE, SORTING_TITLE, UNREAD_ONLY, VIEW_MENU_ARIA,
  sortingText, unreadWord,
} from './mail-groups-copy';
import { ChevronIcon } from './mail-icons';

function choose(on: boolean): void {
  writeGroupedPref(on);
  // The ordinary page is not refreshed by live events while grouped: read it again on the way out.
  if (!on) void loadMailMessages(true);
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-testid="mail-view-menu"]')?.focus({ preventScroll: true });
  });
}

/**
 * `Grouped ▾` / `All mail ▾`: the list's view, and (while grouped) whether Important lists read mail.
 * `warn` marks it when grouping failed and the list fell back to all mail.
 */
export function MailViewMenu({ grouped, warn, unreadOnly, onUnreadOnly }: {
  grouped: boolean;
  warn?: boolean;
  unreadOnly?: boolean;
  onUnreadOnly?: (next: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const open = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (point) { setPoint(null); return; }
    const box = event.currentTarget.getBoundingClientRect();
    setPoint({ x: box.left, y: box.bottom + 2 });
  };
  const items: ContextMenuItem[] = [
    { key: 'grouped', label: GROUPED, checked: grouped, onSelect: () => { if (!grouped) choose(true); } },
    { key: 'all', label: ALL_MAIL, checked: !grouped, onSelect: () => { if (grouped) choose(false); } },
    { divider: true, when: grouped && !!onUnreadOnly },
    {
      key: 'unread-only', label: UNREAD_ONLY, toggle: true, checked: !!unreadOnly, when: grouped && !!onUnreadOnly,
      onSelect: () => onUnreadOnly?.(!unreadOnly),
    },
  ];
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`mail-view-menu-btn${warn ? ' warn' : ''}`}
        data-testid="mail-view-menu"
        data-grouped={grouped}
        aria-haspopup="menu"
        aria-expanded={!!point}
        aria-label={`${VIEW_MENU_ARIA}: ${grouped ? GROUPED : ALL_MAIL}`}
        onClick={open}
      >
        {grouped ? GROUPED : ALL_MAIL}
        <span className="mail-view-menu-caret" aria-hidden="true"><ChevronIcon size={9} /></span>
      </button>
      {point && (
        <ContextMenu
          point={point}
          items={items}
          onClose={() => setPoint(null)}
          ariaLabel={VIEW_MENU_ARIA}
          testId="mail-view-menu-list"
          returnFocus={button.current}
        />
      )}
    </>
  );
}

export function MailGroupedHeader({ name, unread, explain, ai, unreadOnly, onUnreadOnly }: {
  name: string;
  /** Every unread mail in the view (Important plus the groups), overlay applied. */
  unread: number;
  /** `unreadExplain()`: the count's title, word for word the badge's and the IMPORTANT head's. */
  explain: string;
  ai: { state: 'on' | 'down' | 'off'; pending: number } | null;
  unreadOnly: boolean;
  onUnreadOnly: (next: boolean) => void;
}) {
  const sorting = ai?.state === 'on' && ai.pending > 0;
  return (
    <p className="mail-list-section mail-grouped-head" data-testid="mail-list-section">
      <span className="mail-list-section-name">{name}</span>
      {sorting ? (
        <span className="mail-grouped-sorting" data-testid="mail-grouped-sorting" title={`${SORTING_TITLE}\n${explain}`} aria-live="polite">
          <span className="mail-grouped-spin" aria-hidden="true" />
          {sortingText(ai!.pending)}
        </span>
      ) : unread > 0 ? (
        <span className="mail-grouped-unread" data-testid="mail-grouped-unread" title={explain}>{unreadWord(unread)}</span>
      ) : null}
      {ai?.state === 'down' && (
        <span className="mail-grouped-no-ai" data-testid="mail-grouped-no-ai" title={SORTED_WITHOUT_AI_TITLE}>
          {SORTED_WITHOUT_AI}
        </span>
      )}
      <MailViewMenu grouped unreadOnly={unreadOnly} onUnreadOnly={onUnreadOnly} />
    </p>
  );
}

/**
 * An inbox's sidebar badge. While grouping is on it is Important unread with the `unreadExplain()`
 * title (the same value and words as the IMPORTANT head); while off it is the provider's number, as
 * before. Every inbox badge reads the one global switch, so they all change mode in the same frame.
 */
export function MailInboxBadge({ scope, providerUnread, testId, className = 'mail-unread-badge' }: {
  scope: MailGroupsScope | null;
  providerUnread: number;
  testId: string;
  className?: string;
}) {
  const grouped = useGroupedBadge(scope);
  if (grouped === 'pending') return null;
  if (grouped) {
    if (grouped.value <= 0) return null;
    return (
      <span className={className} data-testid={testId} data-mode="grouped" title={grouped.title} aria-label={grouped.title}>
        {formatCount(grouped.value)}
      </span>
    );
  }
  if (providerUnread <= 0) return null;
  return <span className={className} data-testid={testId} data-mode="provider">{formatCount(providerUnread)}</span>;
}
