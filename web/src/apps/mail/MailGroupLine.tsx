/**
 * One group of the grouped inbox: a title line and a summary line, and under them (when open) the
 * group's unread mail.
 *
 * The title line: chevron, name, unread pill, who sent it, the newest mail's time. Under it, one line
 * saying what the mail is ABOUT (the server's `summary`: the model's words, or the newest subject), so
 * a group can be judged without opening it. On hover or keyboard focus the time gives way to two icon
 * buttons, ✓ (`Mark N read`) and ⋯ (the group's menu); at zero unread there is nothing to mark, so
 * neither ✓ nor the footer's `Mark … read` is drawn. While a bulk read runs, its progress sits in
 * that same place; its RESULT goes to the list's status strip, because a group whose unread all got
 * read leaves the list and would take a result drawn in it (and its Undo) along.
 *
 * Open: up to three compact rows (one line each: sender, subject, time), then `N more`, then a footer
 * with the same two actions as words. A mail opened from here is marked read and its row stays put
 * until the group is closed, so nothing jumps out from under the pointer.
 *
 * The line is a `div role="button"` (Enter / Space toggle it, arrows move between lines); every button
 * inside stops propagation so a press on one never also toggles the group.
 */
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import type { MailAccountDto, MailMessageDto } from '@/api/mail';
import type { MailGroupItem, MailGroupsScope } from '@/api/mail-groups';
import { openMailMessage } from './mail-actions';
import { filterRuleFor } from './mail-group-filter';
import { groupBusy, slotKey, startBulkRead, stopBulk, useBulkSlot, type BulkTarget } from './mail-bulk-read';
import { formatCount, formatMailTime, isUnread, senderLabel } from './mail-format';
import { groupsViewKey, requestGroupCard } from './mail-groups-bus';
import {
  CANT_MARK_HERE, FILTER_MENU, GROUPS_UPDATING_TITLE, GROUP_ACTIONS_ARIA, IMPORTANT_MENU, RENAME_MENU, SHOW_FEWER,
  UNSUBSCRIBE_ELLIPSIS, groupRowAria, markLabel, moreLabel, progressLabel, readOnlyTitle,
} from './mail-groups-copy';
import { loadGroupPage, setGroupOpen, setGroupShowAll, useGroupPage, useGroupsView } from './mail-groups-store';
import { CheckIcon, MoreIcon, TwistIcon } from './mail-icons';
import { isOpenRow } from './MailMessageRow';
import { pairKey, type MailSnapshot } from './mail-store';
import type { MailRowMenuHandle } from './MailRowContextMenu';

/** Rows an open group shows before `N more`. */
export const FIRST_ROWS = 3;

/** Every line the arrow keys walk: group lines, their open rows, then Important's rows. */
const NAV_SELECTOR = '.mail-grouped .mail-group-row, .mail-grouped .mail-row';

/** Arrow keys between lines of the grouped list (document order is display order). */
export function moveInGroupedList(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
  if (event.target !== event.currentTarget) return false;
  const rows = [...document.querySelectorAll<HTMLElement>(NAV_SELECTOR)];
  const index = rows.indexOf(event.currentTarget);
  if (index < 0) return false;
  event.preventDefault();
  rows[event.key === 'ArrowUp' ? index - 1 : index + 1]?.focus();
  return true;
}

export interface GroupNumbers {
  /** The group's unread with the optimistic read overlay applied. */
  unread: number;
  /** Unread in accounts that can change the flag; the press marks these. */
  markable: number;
  rulesRev: string;
  recomputing: boolean;
}

/** One open-group row: dot, sender, subject, time, on one line. Same identity attributes as a list row. */
function MailKidRow({ message, selected, menu, accounts }: {
  message: MailMessageDto;
  selected: boolean;
  menu: MailRowMenuHandle;
  accounts: MailAccountDto[] | null;
}) {
  const unread = isUnread(message.flags);
  const pair = pairKey(message.accountId, message.messageId);
  const account = accounts?.find((one) => one.accountId === message.accountId);
  const open = () => { void openMailMessage(message.accountId, message.messageId); };
  return (
    <div
      role="button"
      tabIndex={0}
      className={`mail-row mail-kid${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      data-testid="mail-row"
      data-kid="true"
      data-message-id={message.messageId}
      data-account-id={message.accountId}
      data-unread={unread}
      title={account ? `${message.subject || '(no subject)'}\n${account.displayName || account.address}` : message.subject || undefined}
      {...(menu.openPair === pair ? { 'data-ctx-open': 'true' } : {})}
      /* The row menu's handle, the same `useContextMenu` every mail row opens (MailRowContextMenu.tsx). */
      onContextMenu={(event) => { menu.open(event, { accountId: message.accountId, messageId: message.messageId }); }}
      onClick={open}
      onKeyDown={(event) => {
        if (moveInGroupedList(event)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      <span className="mail-kid-dot" aria-hidden="true">{unread && <span className="mail-row-dot" />}</span>
      <span className="mail-kid-from">{senderLabel(message.from)}</span>
      <span className="mail-kid-subject">{message.subject || '(no subject)'}</span>
      <span className="mail-row-time">{formatMailTime(message.sentAt)}</span>
    </div>
  );
}

export function MailGroupLine({
  group, numbers, open, scope, snapshot, menu, accounts, onUnsubscribe, unsubBusy,
}: {
  group: MailGroupItem;
  numbers: GroupNumbers;
  open: boolean;
  scope: MailGroupsScope;
  snapshot: MailSnapshot;
  menu: MailRowMenuHandle;
  /** Two or more accounts in a merged view: rows name theirs in the title. */
  accounts: MailAccountDto[] | null;
  onUnsubscribe: (groupId: string, anchor: HTMLElement) => void;
  unsubBusy: boolean;
}) {
  const viewKey = groupsViewKey(scope);
  const target: BulkTarget = { scope, groupId: group.id, groupLabel: group.label };
  const slot = useBulkSlot(slotKey(target));
  const running = !!slot && slot.phase !== 'result';
  const busy = running || groupBusy(viewKey, group.id);
  const page = useGroupPage(scope, group.id);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const summaryId = useId();
  const { unread, markable } = numbers;

  const markBlocked = busy || numbers.recomputing || markable === 0;
  const markTitle = numbers.recomputing ? GROUPS_UPDATING_TITLE
    : markable === 0 && unread > 0 ? `${CANT_MARK_HERE}. ${readOnlyTitle(group.readOnlyAccounts)}`
    : group.readOnlyAccounts.length ? `${markLabel(markable)}\n${readOnlyTitle(group.readOnlyAccounts)}`
    : markLabel(markable);
  const mark = () => {
    if (markBlocked) return;
    void startBulkRead(target, { watermark: group.watermark, rulesRev: numbers.rulesRev, total: markable });
  };

  const toggle = () => {
    const next = !open;
    setGroupOpen(scope, group.id, next);
    if (next) void loadGroupPage(scope, group.id, '', 'first', true, true);
  };

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (menuPoint) { setMenuPoint(null); return; }
    const box = event.currentTarget.getBoundingClientRect();
    setMenuPoint({ x: box.left, y: box.bottom + 2 });
  };
  const card = (kind: 'group-important' | 'rename' | 'group-filter') => {
    const anchor = lineRef.current;
    if (!anchor) return;
    requestGroupCard({
      kind, groupId: group.id, label: group.label, unread, scope, viewKey, anchor,
      ...(kind === 'group-filter' ? { watermark: group.watermark, cannotArchive: group.cannotArchive ?? [] } : {}),
    });
  };
  const items: ContextMenuItem[] = [
    { key: 'mark', label: markLabel(markable), when: unread > 0, disabled: markBlocked, title: markTitle, onSelect: mark },
    {
      key: 'unsubscribe', label: UNSUBSCRIBE_ELLIPSIS, when: group.unsubscribable > 0, disabled: busy || unsubBusy,
      onSelect: () => { if (lineRef.current) onUnsubscribe(group.id, lineRef.current); },
    },
    { divider: true },
    { key: 'important', label: IMPORTANT_MENU, onSelect: () => card('group-important') },
    { key: 'filter', label: FILTER_MENU, when: filterRuleFor(group.id, group.label) !== null, onSelect: () => card('group-filter') },
    { key: 'rename', label: RENAME_MENU, onSelect: () => card('rename') },
  ];

  const senders = group.topSenders.map((one) => one.label).join(', ');
  const summary = group.summary?.trim() || senders;
  const rows = page.rows;
  return (
    <div className={`mail-group${open ? ' open' : ''}`} data-testid="mail-group" data-group-id={group.id}>
      <div
        ref={lineRef}
        role="button"
        tabIndex={0}
        className={`mail-group-row${menuPoint ? ' menu-open' : ''}${running ? ' running' : ''}`}
        data-testid="mail-group-row"
        data-group-id={group.id}
        data-unread={unread}
        aria-expanded={open}
        aria-label={groupRowAria(group.label, unread, open)}
        {...(summary ? { 'aria-describedby': summaryId } : {})}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); return; }
          if (event.key === 'ArrowRight' && !open) { event.preventDefault(); toggle(); return; }
          if (event.key === 'ArrowLeft' && open) { event.preventDefault(); toggle(); return; }
          moveInGroupedList(event);
        }}
      >
        <span className="mail-group-title">
          <span className="mail-group-twist" aria-hidden="true"><TwistIcon size={10} /></span>
          <span className="mail-group-name" data-testid="mail-group-name" title={group.label}>{group.label}</span>
          <span className={`mail-group-pill${unread > 0 ? '' : ' zero'}`} data-testid="mail-group-unread">{formatCount(unread)}</span>
          {/* The senders already are the summary line when there is no subject to show. */}
          <span className="mail-group-who" data-testid="mail-group-senders" title={senders}>{open || summary === senders ? '' : senders}</span>
          {running ? (
            <span className="mail-group-progress" data-testid="mail-bulk-progress" aria-busy="true">
              {progressLabel(slot!.kind, slot!.phase === 'running' ? slot!.done : null, slot!.total)}
              {slot!.phase === 'running' && (
                <button
                  type="button"
                  className="mail-text-btn mail-group-stop"
                  data-testid="mail-bulk-stop"
                  onClick={(event) => { event.stopPropagation(); void stopBulk(slotKey(target)); }}
                >
                  Stop
                </button>
              )}
            </span>
          ) : (
            <>
              <span className="mail-group-time">{formatMailTime(group.newestAt)}</span>
              <span className="mail-group-tools">
                {unread > 0 && (
                  <button
                    type="button"
                    className="mail-group-icon"
                    data-testid="mail-group-mark"
                    aria-label={markLabel(markable)}
                    title={markTitle}
                    disabled={markBlocked}
                    onClick={(event) => { event.stopPropagation(); mark(); }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <CheckIcon size={13} />
                  </button>
                )}
                <button
                  ref={moreRef}
                  type="button"
                  className="mail-group-icon"
                  data-testid="mail-group-more"
                  aria-label={`${GROUP_ACTIONS_ARIA}: ${group.label}`}
                  aria-haspopup="menu"
                  aria-expanded={!!menuPoint}
                  onClick={openMenu}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <MoreIcon size={13} />
                </button>
              </span>
            </>
          )}
        </span>
        {summary && (
          <span
            id={summaryId}
            className="mail-group-summary"
            data-testid="mail-group-summary"
            data-by={group.summary?.trim() ? group.summaryBy ?? 'subject' : 'senders'}
            title={group.summaryBy === 'ai' ? `${summary}\nSummary by Walnut` : summary}
          >
            {summary}
          </span>
        )}
      </div>
      {open && (
        <GroupRows
          group={group}
          rows={rows}
          page={page}
          scope={scope}
          snapshot={snapshot}
          menu={menu}
          accounts={accounts}
          unread={unread}
          markable={markable}
          markBlocked={markBlocked}
          markTitle={markTitle}
          onMark={mark}
          onUnsubscribe={(anchor) => onUnsubscribe(group.id, anchor)}
          unsubBusy={unsubBusy || busy}
        />
      )}
      {menuPoint && (
        <ContextMenu
          point={menuPoint}
          items={items}
          onClose={() => setMenuPoint(null)}
          ariaLabel={`${GROUP_ACTIONS_ARIA}: ${group.label}`}
          testId="mail-group-menu"
          returnFocus={moreRef.current}
        />
      )}
    </div>
  );
}

function GroupRows({
  group, rows, page, scope, snapshot, menu, accounts, unread, markable, markBlocked, markTitle, onMark, onUnsubscribe, unsubBusy,
}: {
  group: MailGroupItem;
  rows: MailMessageDto[];
  page: ReturnType<typeof useGroupPage>;
  scope: MailGroupsScope;
  snapshot: MailSnapshot;
  menu: MailRowMenuHandle;
  accounts: MailAccountDto[] | null;
  unread: number;
  markable: number;
  markBlocked: boolean;
  markTitle: string;
  onMark: () => void;
  onUnsubscribe: (anchor: HTMLElement) => void;
  unsubBusy: boolean;
}) {
  const all = !!useGroupsView(scope).showAll[group.id];
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  // The rows past the first three: what is loaded, or the group's own count when more pages wait.
  const hidden = all ? 0 : Math.max(rows.length, page.nextBefore ? group.unread : 0) - shown.length;
  return (
    <div className="mail-group-kids" data-testid="mail-group-kids">
      {!page.loaded && page.loading && <p className="mail-group-kids-note">Loading…</p>}
      {page.error && <p className="mail-inline-error">{page.error}</p>}
      {shown.map((message) => (
        <MailKidRow
          key={`${message.accountId} ${message.messageId}`}
          message={message}
          selected={isOpenRow(snapshot, message)}
          menu={menu}
          accounts={accounts}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="mail-group-more-rows"
          data-testid="mail-group-more-rows"
          onClick={() => setGroupShowAll(scope, group.id, true)}
        >
          {moreLabel(hidden)}
        </button>
      )}
      {all && page.nextBefore && (
        <button
          type="button"
          className="mail-group-more-rows"
          data-testid="mail-group-load-older"
          disabled={page.olderLoading}
          onClick={() => { void loadGroupPage(scope, group.id, '', 'older', true); }}
        >
          {page.olderLoading ? 'Loading…' : 'Load older'}
        </button>
      )}
      {all && rows.length > FIRST_ROWS && (
        <button
          type="button"
          className="mail-group-more-rows"
          data-testid="mail-group-fewer"
          onClick={() => setGroupShowAll(scope, group.id, false)}
        >
          {SHOW_FEWER}
        </button>
      )}
      <p className="mail-group-foot">
        {/* An open group whose mail was all read stays drawn until it closes; it has nothing to mark. */}
        {unread > 0 && (
          <button
            type="button"
            className="mail-text-btn"
            data-testid="mail-group-foot-mark"
            disabled={markBlocked}
            title={markTitle}
            onClick={onMark}
          >
            {markLabel(markable)}
          </button>
        )}
        {group.unsubscribable > 0 && (
          <button
            type="button"
            className="mail-text-btn"
            data-testid="mail-group-unsubscribe"
            aria-busy={unsubBusy ? 'true' : undefined}
            disabled={unsubBusy}
            onClick={(event) => onUnsubscribe(event.currentTarget)}
          >
            {UNSUBSCRIBE_ELLIPSIS}
          </button>
        )}
      </p>
    </div>
  );
}
