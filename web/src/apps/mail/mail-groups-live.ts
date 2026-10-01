/**
 * The grouped inbox's live refresh, and the one question every caller asks first: is the list on
 * screen a grouped one?
 *
 * The All mail path answers every sync event with `loadMailMessages(true)`, which reads the
 * UNGROUPED page. Taken over a grouped view that either replaces Important with the whole inbox or
 * drops pager mail into it, so while grouped these events come here instead: the Important first
 * page is read again and MERGED (older pages and the scroll stay), the group rows are read again
 * (debounced), and every open group's list gains its new mail without losing a row already shown.
 */
import { useEffect } from 'react';
import type { MailGroupsScope } from '@/api/mail-groups';
import { groupsViewKey, markMailMovedOut, onGroupsRefresh, onMailMovedOut } from './mail-groups-bus';
import { readGroupedPref, useGroupedPref } from './mail-grouped-pref';
import { unreadExplain } from './mail-groups-copy';
import { onBulkEvent } from './mail-bulk-read';
import {
  IMPORTANT_ID, dropRows, knownViews, loadGroupPage, loadGroupedRailBadge, loadGroups,
  overlayDelta, patchView, peekView, useGroupsView, viewState,
  type GroupsViewState,
} from './mail-groups-store';
import { SMART_ACCOUNT, SMART_INBOX, onMailStoreReset, store, type MailSelection } from './mail-store';
import { readUnreadOnly } from './mail-unread-filter';

export const GROUPS_DEBOUNCE_MS = 500;

/** The scope a selection sorts, when it is an inbox (a real inbox folder or All Inboxes). */
export function groupedScopeOf(selection: MailSelection | null): MailGroupsScope | null {
  if (!selection) return null;
  if (selection.accountId === SMART_ACCOUNT) return selection.mailboxId === SMART_INBOX ? { role: 'inbox' } : null;
  const row = (store.state.mailboxes[selection.accountId] ?? []).find((one) => one.mailboxId === selection.mailboxId);
  return row?.role === 'inbox' ? { accountId: selection.accountId, mailboxId: selection.mailboxId } : null;
}

/** The grouped scope on screen right now, or null (switch off, not an inbox, searching). */
export function groupedOnScreen(): MailGroupsScope | null {
  if (!readGroupedPref() || store.state.search.active) return null;
  const scope = groupedScopeOf(store.state.selected);
  if (!scope) return null;
  // A view whose `/groups` failed shows All mail (spec 8.5), so its list is the ordinary one.
  return peekView(groupsViewKey(scope))?.error && !peekView(groupsViewKey(scope))?.groups ? null : scope;
}

function unreadFilterOf(scope: MailGroupsScope): boolean {
  const selection = 'role' in scope
    ? { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX }
    : scope;
  return readUnreadOnly(selection.accountId, selection.mailboxId);
}

/** Read the grouped lists of one view again, merging first pages (never replacing older ones). */
export function refreshGroupedView(scope: MailGroupsScope): void {
  scheduleGroups(scope);
  void loadGroupPage(scope, IMPORTANT_ID, '', 'first', unreadFilterOf(scope));
  const view = peekView(groupsViewKey(scope));
  for (const [id, open] of Object.entries(view?.expanded ?? {})) {
    if (open) void loadGroupPage(scope, id, '', 'first', true, true);
  }
}

/**
 * What the sync events call instead of `loadMailMessages(true)`: the grouped refresh when the list
 * on screen is grouped, the caller's own reload otherwise.
 */
export function reloadListOnScreen(fallback: () => void): void {
  const scope = groupedOnScreen();
  if (!scope) { fallback(); return; }
  refreshGroupedView(scope);
}

/**
 * How much NEW mail lights a folder in the sidebar. While grouped, an inbox only lights for mail that
 * landed in Important (`importantAdded`); mail sorted into a group moves that row's number instead.
 */
export function arrivalCount(payload: { accountId?: string; mailboxId?: string; added?: number; importantAdded?: number }): number | undefined {
  if (!readGroupedPref() || !payload.accountId || !payload.mailboxId) return payload.added;
  const row = (store.state.mailboxes[payload.accountId] ?? []).find((one) => one.mailboxId === payload.mailboxId);
  if (row?.role !== 'inbox') return payload.added;
  return typeof payload.importantAdded === 'number' ? payload.importantAdded : 0;
}

// ── debounced /groups ──

const pendingGroups = new Map<string, { scope: MailGroupsScope; withImportant: boolean; timer: ReturnType<typeof setTimeout> }>();

/**
 * One `/groups` read per burst. `withImportant` also reads Important's first page for the view on
 * screen: the model moving a mail out of Important (it waited there as "Sorting") is a groups change,
 * and without the page read that row stayed in Important until some other refresh came along.
 */
function scheduleGroups(scope: MailGroupsScope, withImportant = false): void {
  const key = groupsViewKey(scope);
  const pending = pendingGroups.get(key);
  if (pending) { pending.withImportant ||= withImportant; return; }
  const timer = setTimeout(() => {
    const due = pendingGroups.get(key);
    pendingGroups.delete(key);
    void loadGroups(scope, true);
    const onScreen = groupedOnScreen();
    if (due?.withImportant && onScreen && groupsViewKey(onScreen) === key) {
      void loadGroupPage(scope, IMPORTANT_ID, '', 'first', unreadFilterOf(scope));
    }
  }, GROUPS_DEBOUNCE_MS);
  pendingGroups.set(key, { scope, withImportant, timer });
}

onMailStoreReset(() => {
  for (const one of pendingGroups.values()) clearTimeout(one.timer);
  pendingGroups.clear();
});

function touches(view: { scope: MailGroupsScope }, pairs: Array<{ accountId: string; mailboxId: string }> | undefined): boolean {
  if (!pairs || pairs.length === 0 || 'role' in view.scope) return true;
  const scope = view.scope;
  return pairs.some((one) => one.accountId === scope.accountId && one.mailboxId === scope.mailboxId);
}

// ── the sorting events ──

type UnsubBatchListener = (data: { batchId: string; index: number; status: string; message?: string; url?: string }) => void;
const unsubListeners = new Set<UnsubBatchListener>();

/** The checklist dialog (and the strip line of a batch whose dialog is closed) follow a batch here. */
export function onUnsubBatch(fn: UnsubBatchListener): () => void {
  unsubListeners.add(fn);
  return () => { unsubListeners.delete(fn); };
}

/**
 * Progress only. The rendered `rulesRev` is deliberately left as the answer said: it is what a
 * `Mark N read` press quotes, and counts drawn from old rules must not pass for new ones.
 */
function setRecomputing(value: { done: number; total: number } | null): void {
  for (const view of knownViews()) {
    if (!view.groups) continue;
    const groups = { ...view.groups };
    if (value) groups.recomputing = value; else delete groups.recomputing;
    patchView(view.scope, { groups });
  }
}

/**
 * The events inbox sorting adds. Answered here in full, ahead of the console's loaded gate: the
 * rail badge of a tab that never opened Mail follows `groups-changed` too. Returns false for every
 * other name, which the caller then handles as before.
 */
export function onGroupsEvent(name: string, data: unknown): boolean {
  const payload = (data ?? {}) as {
    pairs?: Array<{ accountId: string; mailboxId: string }>;
    done?: number; total?: number; rulesRev?: string;
    batchId?: string; index?: number; status?: string; message?: string; url?: string;
    accountId?: string; messageIds?: unknown[];
  };
  switch (name) {
    case 'groups-changed': {
      if (!readGroupedPref()) return true;
      const views = knownViews().filter((view) => touches(view, payload.pairs));
      for (const view of views) scheduleGroups(view.scope, true);
      if (!views.some((view) => view.viewKey === 'smart:inbox')) void loadGroupedRailBadge();
      return true;
    }
    case 'sort-progress':
      setRecomputing({ done: payload.done ?? 0, total: payload.total ?? 0 });
      return true;
    case 'sorted': {
      setRecomputing(null);
      for (const view of knownViews()) void loadGroups(view.scope, true);
      const scope = groupedOnScreen();
      if (scope) refreshGroupedView(scope);
      return true;
    }
    case 'rules-changed':
      for (const view of knownViews()) scheduleGroups(view.scope);
      return true;
    case 'bulk-progress':
    case 'bulk-done':
      onBulkEvent(name, data);
      return true;
    case 'filtered': {
      // A keep-out-of-Inbox rule moved mail to Archive: its rows leave every open list now.
      const moved = (payload.messageIds ?? []).filter((one): one is string => typeof one === 'string');
      const accountId = payload.accountId;
      if (typeof accountId === 'string' && moved.length > 0) {
        markMailMovedOut(moved.map((messageId) => ({ accountId, messageId })));
      }
      return true;
    }
    case 'unsub-batch':
      if (payload.batchId) {
        const event = {
          batchId: payload.batchId, index: payload.index ?? 0, status: payload.status ?? '',
          ...(payload.message ? { message: payload.message } : {}), ...(payload.url ? { url: payload.url } : {}),
        };
        for (const one of [...unsubListeners]) one(event);
      }
      return true;
    default:
      return false;
  }
}

// ── the bus signals every grouped view answers ──

let wired = false;

/** Called once by the grouped list: `requestGroupsRefresh()` and `markMailMovedOut()` land here. */
export function wireGroupsBus(): void {
  if (wired) return;
  wired = true;
  onGroupsRefresh(() => {
    for (const view of knownViews()) void loadGroups(view.scope, true);
    const scope = groupedOnScreen();
    if (scope) refreshGroupedView(scope);
  });
  onMailMovedOut((ids) => { collapseThenDrop(ids); });
}

export const COLLAPSE_MS = 160;

/** Rows a correction moved out: they fold away in 160 ms (none under reduced motion), then go. */
function collapseThenDrop(ids: Array<{ accountId: string; messageId: string }>): void {
  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof document === 'undefined') { dropRows(ids); return; }
  for (const one of ids) {
    const quoted = (value: string) => value.replace(/["\\]/g, (ch) => `\\${ch}`);
    document.querySelectorAll(`.mail-grouped .mail-row[data-account-id="${quoted(one.accountId)}"][data-message-id="${quoted(one.messageId)}"]`)
      .forEach((row) => row.classList.add('mail-row-leaving'));
  }
  setTimeout(() => { dropRows(ids); }, COLLAPSE_MS);
}

// ── the numbers every unread place shows (spec 5.9) ──

export interface GroupedNumbers {
  importantUnread: number;
  importantTotal: number;
  /** Unread in the groups (not Important). */
  groupedUnread: number;
  cachedUnread: number;
  providerUnread: number;
  /** Unread waiting for the model (inside Important meanwhile). */
  pending: number;
  /** `unreadExplain()`, the one title the badge, the header and the IMPORTANT head all carry. */
  explain: string;
}

/** A view's unread numbers with the optimistic read overlay applied. */
export function groupedNumbers(view: GroupsViewState): GroupedNumbers | null {
  const groups = view.groups;
  if (!groups) return null;
  const key = view.viewKey;
  const importantUnread = Math.max(0, groups.important.unread + overlayDelta(key, IMPORTANT_ID));
  let moved = overlayDelta(key, IMPORTANT_ID);
  let groupedUnread = 0;
  for (const group of groups.groups) {
    const delta = overlayDelta(key, group.id);
    moved += delta;
    groupedUnread += Math.max(0, group.unread + delta);
  }
  const cachedUnread = Math.max(0, groups.cachedUnread + moved);
  const pending = groups.ai?.pending ?? 0;
  return {
    importantUnread,
    importantTotal: groups.important.total,
    groupedUnread,
    cachedUnread,
    providerUnread: groups.providerUnread,
    pending,
    explain: unreadExplain({ importantUnread, groupedUnread, providerUnread: groups.providerUnread, cachedUnread }),
  };
}

/**
 * An inbox badge while grouping is on: Important unread and its sentence; `null` while the switch
 * is off (the caller draws the provider's number, as before). `pending` while the view's first
 * `/groups` answer is on its way: the badge then draws nothing rather than the other mode's number.
 */
export function useGroupedBadge(scope: MailGroupsScope | null): { value: number; title: string } | 'pending' | null {
  const on = useGroupedPref();
  const view = useGroupsView(scope ?? { role: 'inbox' });
  const wanted = on && !!scope;
  const key = scope ? groupsViewKey(scope) : '';
  useEffect(() => {
    if (!wanted || !scope) return;
    if (!viewState(scope).groups) void loadGroups(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key]);
  if (!wanted) return null;
  const numbers = groupedNumbers(view);
  if (!numbers) return 'pending';
  return { value: numbers.importantUnread, title: numbers.explain };
}
