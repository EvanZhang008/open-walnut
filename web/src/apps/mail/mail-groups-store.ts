/**
 * The grouped inbox's state, per view (`groupsViewKey(scope)`: `smart:inbox` or `acct/<a>/<m>`).
 *
 * What it holds, and why here rather than in `mail-store.ts`:
 * - the last `/groups` answer of each view, which is also what every inbox badge reads while the
 *   switch is on, so the badge, the header and the IMPORTANT head are ONE value;
 * - which groups are open, and the row order held while the pointer is over the list (a group whose
 *   mail just arrived must not jump under the pointer; it moves up once the pointer leaves);
 * - an open group stays on screen after its last unread is read (its row says 0) while the pointer is
 *   still over the list, so the mail you just opened does not vanish from under you; it goes once
 *   the pointer leaves or the view is entered again (`releaseSpentGroups`);
 * - the message pages (`mail-groups-pages.ts`), keyed apart from the All mail list;
 * - an unread OVERLAY: the optimistic read flag (`mail-read-flag.ts`) moves the numbers here the
 *   moment a mail is opened, and puts them back in the same frame when the provider refuses. An
 *   entry retires only when a `/groups` read that STARTED after the server confirmed the flip lands,
 *   so a refetch in flight cannot bounce the badge back (spec 9.3a, C12, C85).
 *
 * `useSyncExternalStore` with snapshots that change identity only on a write.
 */
import { useSyncExternalStore } from 'react';
import { listMailMessages, mailFailure, type MailMessageDto } from '@/api/mail';
import {
  getMailGroups, getMailGroupsSummary,
  type MailGroupItem, type MailGroupsResponse, type MailGroupsScope,
} from '@/api/mail-groups';
import { log } from '@/utils/log';
import { groupsViewKey } from './mail-groups-bus';
import {
  EMPTY_PAGE, appendOlder, mergeFirstPage, mergeKeepShown, pageKey, rowId, withFlags, withoutRows,
  type GroupPageState,
} from './mail-groups-pages';
import { PAGE_SIZE, SEEN, onMailStoreReset } from './mail-store';

export const IMPORTANT_ID = 'important';

export interface GroupsViewState {
  viewKey: string;
  scope: MailGroupsScope;
  groups: MailGroupsResponse | null;
  loading: boolean;
  /** The server's sentence for a failed `/groups`; the list falls back to All mail. */
  error: string | null;
  /** Open groups (their mail listed under the row). */
  expanded: Record<string, boolean>;
  /** Open groups showing every loaded mail, not only the first three. */
  showAll: Record<string, boolean>;
  /** The last row seen for every open group, so it stays drawn at 0 unread until it is closed. */
  held: Record<string, MailGroupItem>;
  /** The row order frozen while the pointer is over the list; null = the server's order. */
  heldOrder: string[] | null;
}

interface OverlayEntry {
  accountId: string;
  mailboxId: string;
  groupId: string;
  senderKey: string;
  delta: number;
  /** When the server confirmed the flip; null while it is still in flight. */
  settledAt: number | null;
}

const views = new Map<string, GroupsViewState>();
const pages = new Map<string, GroupPageState>();
const overlay = new Map<string, OverlayEntry>();
/** When each view's last `/groups` request STARTED (the overlay retires against this). */
const groupsStartedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();
const listeners = new Set<() => void>();
let railSummary: number | null = null;
let railListener: ((value: number | null) => void) | null = null;

function emit(): void {
  for (const one of [...listeners]) one();
  railListener?.(railValue());
}

export function subscribeGroups(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function freshView(scope: MailGroupsScope): GroupsViewState {
  return {
    viewKey: groupsViewKey(scope), scope, groups: null, loading: false, error: null,
    expanded: {}, showAll: {}, held: {}, heldOrder: null,
  };
}

/** The view's state, created on first read. */
export function viewState(scope: MailGroupsScope): GroupsViewState {
  const key = groupsViewKey(scope);
  let view = views.get(key);
  if (!view) { view = freshView(scope); views.set(key, view); }
  return view;
}

export function peekView(viewKey: string): GroupsViewState | undefined {
  return views.get(viewKey);
}

/** Replace a view's state (never mutate: the snapshot identity is what re-renders). */
export function patchView(scope: MailGroupsScope, next: Partial<GroupsViewState>): void {
  const view = viewState(scope);
  views.set(view.viewKey, { ...view, ...next });
  emit();
}

/** One request per key; a forced caller mid-flight queues exactly one more pass. */
function coalesce(key: string, work: () => Promise<void>, force: boolean): Promise<void> {
  const running = inflight.get(key);
  if (running) { if (force) again.add(key); return running; }
  const promise = (async () => {
    try {
      do { again.delete(key); await work(); } while (again.has(key));
    } finally { inflight.delete(key); again.delete(key); }
  })();
  inflight.set(key, promise);
  return promise;
}

/** GET /groups for one view. A failure keeps the last answer and records the server's sentence. */
export function loadGroups(scope: MailGroupsScope, force = false): Promise<void> {
  const key = groupsViewKey(scope);
  return coalesce(`groups:${key}`, async () => {
    const startedAt = Date.now();
    patchView(scope, { loading: true });
    try {
      const answer = await getMailGroups(scope);
      groupsStartedAt.set(key, startedAt);
      retireOverlay(key, startedAt);
      const view = viewState(scope);
      // An open group keeps its last row, so it stays drawn once its unread reaches zero.
      const held: Record<string, MailGroupItem> = {};
      for (const [id, open] of Object.entries(view.expanded)) {
        if (!open) continue;
        const fresh = answer.groups.find((one) => one.id === id);
        const last = fresh ?? view.held[id];
        if (last) held[id] = fresh ?? { ...last, unread: 0, markableUnread: 0 };
      }
      patchView(scope, { groups: answer, loading: false, error: null, held });
      if (key === 'smart:inbox') railSummary = answer.important.unread;
    } catch (error) {
      const failure = mailFailure(error);
      log.warn('mail', 'groups read failed', { viewKey: key, code: failure.code, error: failure.message });
      patchView(scope, { loading: false, error: failure.message });
    }
  }, force);
}

/** Open or close one group. Closing a group at zero unread lets it go. */
export function setGroupOpen(scope: MailGroupsScope, groupId: string, open: boolean): void {
  const view = viewState(scope);
  const expanded = { ...view.expanded, [groupId]: open };
  const held = { ...view.held };
  const showAll = { ...view.showAll };
  if (open) {
    const row = view.groups?.groups.find((one) => one.id === groupId) ?? view.held[groupId];
    if (row) held[groupId] = row;
  } else {
    delete expanded[groupId];
    delete held[groupId];
    delete showAll[groupId];
  }
  patchView(scope, { expanded, held, showAll });
}

/**
 * Let go of every open group whose unread reached zero. An open group is held at zero only while the
 * person is still working in the list, so the mail they just opened does not vanish from under the
 * pointer; once the pointer leaves the list (or the view is entered again) a group with nothing
 * unread is not something to show.
 */
export function releaseSpentGroups(scope: MailGroupsScope): void {
  const view = viewState(scope);
  const answer = new Map((view.groups?.groups ?? []).map((one) => [one.id, one] as const));
  const expanded = { ...view.expanded };
  const held = { ...view.held };
  const showAll = { ...view.showAll };
  let changed = false;
  for (const id of Object.keys(view.expanded)) {
    const row = answer.get(id) ?? view.held[id];
    if (row && row.unread + overlayDelta(view.viewKey, id) > 0) continue;
    delete expanded[id];
    delete held[id];
    delete showAll[id];
    changed = true;
  }
  if (changed) patchView(scope, { expanded, held, showAll });
}

export function setGroupShowAll(scope: MailGroupsScope, groupId: string, all: boolean): void {
  const view = viewState(scope);
  patchView(scope, { showAll: { ...view.showAll, [groupId]: all } });
}

/** Hold the row order while the pointer is over the list (`null` lets it follow the server again). */
export function holdGroupOrder(scope: MailGroupsScope, order: string[] | null): void {
  const view = viewState(scope);
  if (order === null && view.heldOrder === null) return;
  patchView(scope, { heldOrder: order });
}

/**
 * The group rows to draw: every group with unread (after the optimistic overlay), plus open groups
 * at zero, in the server's order (newest first) unless the order is held.
 */
export function drawnGroups(view: GroupsViewState): Array<{ group: MailGroupItem; unread: number }> {
  const answer = view.groups?.groups ?? [];
  const byId = new Map<string, MailGroupItem>();
  for (const one of answer) byId.set(one.id, one);
  for (const [id, row] of Object.entries(view.held)) if (!byId.has(id)) byId.set(id, row);
  const serverOrder = [...answer.map((one) => one.id), ...Object.keys(view.held).filter((id) => !answer.some((one) => one.id === id))];
  const order = view.heldOrder
    ? [...view.heldOrder.filter((id) => byId.has(id)), ...serverOrder.filter((id) => !view.heldOrder!.includes(id))]
    : serverOrder;
  const out: Array<{ group: MailGroupItem; unread: number }> = [];
  for (const id of order) {
    const group = byId.get(id)!;
    const unread = Math.max(0, group.unread + overlayDelta(view.viewKey, id));
    if (unread > 0 || view.expanded[id]) out.push({ group, unread });
  }
  return out;
}

/** The rail badge in grouped mode: the summary, or the merged view's own answer when it has one. */
export function railValue(): number | null {
  const merged = views.get('smart:inbox');
  if (merged?.groups) return Math.max(0, merged.groups.important.unread + overlayDelta('smart:inbox', IMPORTANT_ID));
  return railSummary;
}

/** `GET /groups/summary` for the rail badge of a tab that has never opened Mail. */
export async function loadGroupedRailBadge(): Promise<void> {
  try {
    const summary = await getMailGroupsSummary();
    railSummary = summary.importantUnread;
    emit();
  } catch (error) {
    log.warn('mail', 'group summary read failed', { error: mailFailure(error).message });
  }
}

export function setRailListener(fn: ((value: number | null) => void) | null): void {
  railListener = fn;
}

// ── the unread overlay ──

function coversPair(viewKey: string, accountId: string, mailboxId: string): boolean {
  if (viewKey === 'smart:inbox') return true;
  return viewKey === `acct/${accountId}/${mailboxId}`;
}

/** The sum of the pending optimistic moves for one group (and one sender) in one view. */
export function overlayDelta(viewKey: string, groupId: string, senderKey?: string): number {
  let sum = 0;
  for (const entry of overlay.values()) {
    if (entry.groupId !== groupId || !coversPair(viewKey, entry.accountId, entry.mailboxId)) continue;
    if (senderKey !== undefined && entry.senderKey !== senderKey) continue;
    sum += entry.delta;
  }
  return sum;
}

function retireOverlay(viewKey: string, startedAt: number): void {
  for (const [id, entry] of overlay) {
    if (entry.settledAt !== null && entry.settledAt <= startedAt && coversPair(viewKey, entry.accountId, entry.mailboxId)) {
      overlay.delete(id);
    }
  }
}

/**
 * Move one group's (and sender's) unread by `delta` right now: the optimistic read (-1) and its
 * rollback (+1). `message` names the mail so the two cancel out and a confirmation can retire it.
 */
export function adjustUnread(
  groupId: string,
  senderKey: string,
  delta: number,
  message?: { accountId: string; mailboxId: string; messageId: string },
): void {
  const id = message ? rowId(message) : `anon:${groupId}|${senderKey}|${Date.now()}|${Math.random()}`;
  const held = overlay.get(id);
  const next = (held?.delta ?? 0) + delta;
  if (next === 0) overlay.delete(id);
  else {
    overlay.set(id, {
      accountId: message?.accountId ?? '', mailboxId: message?.mailboxId ?? '',
      groupId, senderKey, delta: next, settledAt: null,
    });
  }
  emit();
}

/** The server confirmed this mail's flip: the next `/groups` read that starts from now counts it. */
export function settleUnread(message: { accountId: string; messageId: string }): void {
  const entry = overlay.get(rowId(message));
  if (entry && entry.settledAt === null) entry.settledAt = Date.now();
}

// ── rows held in the grouped pages ──

/** The row a grouped page holds for this mail (the reader's own copy has no `sort`). */
export function groupedRowOf(target: { accountId: string; messageId: string }): MailMessageDto | null {
  const id = rowId(target);
  for (const page of pages.values()) {
    const hit = page.rows.find((one) => rowId(one) === id);
    if (hit) return hit;
  }
  return null;
}

/** Every row the grouped pages hold (the reader looks a mail up here too). */
export function groupedRows(): MailMessageDto[] {
  const out: MailMessageDto[] = [];
  for (const page of pages.values()) out.push(...page.rows);
  return out;
}

function flipFlags(flags: string[], seen: boolean): string[] {
  const rest = flags.filter((flag) => flag !== SEEN);
  return seen ? [...rest, SEEN] : rest;
}

/**
 * The optimistic read (and its rollback) as the grouped inbox sees it: the row's style in every page
 * holding it, and its group's and sender's unread in the same frame. Called from `applySeen`.
 */
export function applySeenToGroupedRows(message: { accountId: string; mailboxId: string; messageId: string }, seen: boolean): void {
  const row = groupedRowOf(message);
  if (!row) return;
  const wasSeen = row.flags.includes(SEEN);
  let touched = false;
  for (const [key, page] of pages) {
    const rows = withFlags(page.rows, message, (flags) => flipFlags(flags, seen));
    if (rows !== page.rows) { pages.set(key, { ...page, rows }); touched = true; }
  }
  if (wasSeen === seen) { if (touched) emit(); return; }
  const groupId = row.sort?.group ?? IMPORTANT_ID;
  adjustUnread(groupId, row.senderKey ?? '', seen ? -1 : 1, { ...message, mailboxId: row.mailboxId });
}

/** The server's own row after a flip: its flags win; the grouped fields stay (the DTO lacks them). */
export function replaceGroupedRow(message: MailMessageDto): void {
  settleUnread(message);
  let touched = false;
  for (const [key, page] of pages) {
    const rows = withFlags(page.rows, message, () => message.flags);
    if (rows !== page.rows) { pages.set(key, { ...page, rows }); touched = true; }
  }
  if (touched) emit();
}

/** A bulk job's `changedIds`: restyle every loaded row it names (spec 9.1 step 4). */
export function restyleRows(ids: Array<{ accountId: string; messageId: string }>, seen: boolean): void {
  let touched = false;
  for (const target of ids) {
    for (const [key, page] of pages) {
      const rows = withFlags(page.rows, target, (flags) => flipFlags(flags, seen));
      if (rows !== page.rows) { pages.set(key, { ...page, rows }); touched = true; }
    }
  }
  if (touched) emit();
}

/** Drop rows that left the list they were shown in (a correction moved them). */
export function dropRows(ids: Array<{ accountId: string; messageId: string }>): void {
  const set = new Set(ids.map(rowId));
  let touched = false;
  for (const [key, page] of pages) {
    const rows = withoutRows(page.rows, set);
    if (rows !== page.rows) { pages.set(key, { ...page, rows }); touched = true; }
  }
  if (touched) emit();
}

// ── pages ──

function pageQuery(scope: MailGroupsScope, group: string, sender: string, unread: boolean) {
  return {
    limit: PAGE_SIZE,
    ...('role' in scope ? { scope: 'role:inbox' as const } : { accountId: scope.accountId, mailboxId: scope.mailboxId }),
    group,
    ...(sender ? { sender } : {}),
    ...(unread ? { unread: true } : {}),
  };
}

export function pageState(key: string): GroupPageState {
  return pages.get(key) ?? EMPTY_PAGE;
}

function setPage(key: string, next: Partial<GroupPageState>): void {
  pages.set(key, { ...pageState(key), ...next });
  emit();
}

/**
 * One list's pages. `first` reads the first page and MERGES it into what is loaded (a live refresh
 * keeps the older pages and the scroll); `older` appends the next page; `reload` reads again every
 * page already loaded (a bulk job that changed more rows than it could name).
 */
export function loadGroupPage(
  scope: MailGroupsScope,
  group: string,
  sender: string,
  mode: 'first' | 'older' | 'reload',
  unread = false,
  /** An open group's list: a refresh ADDS rows and never drops one already shown (a mail just read stays). */
  keepShown = false,
): Promise<void> {
  const key = pageKey(groupsViewKey(scope), group, sender);
  return coalesce(`page:${key}:${mode}`, async () => {
    const held = pageState(key);
    const query = pageQuery(scope, group, sender, unread);
    try {
      if (mode === 'older') {
        if (!held.nextBefore) return;
        setPage(key, { olderLoading: true });
        const page = await listMailMessages({ ...query, before: held.nextBefore });
        const now = pageState(key);
        setPage(key, {
          rows: appendOlder(now.rows, page.messages), nextBefore: page.nextBefore ?? null,
          olderLoading: false, pages: now.pages + 1,
        });
        return;
      }
      setPage(key, { loading: true });
      const want = mode === 'reload' ? Math.max(1, held.pages) : 1;
      let rows: MailMessageDto[] = [];
      let cursor: string | undefined;
      let ended = false;
      for (let index = 0; index < want; index += 1) {
        const page = await listMailMessages({ ...query, ...(cursor ? { before: cursor } : {}) });
        rows = appendOlder(rows, page.messages);
        cursor = page.nextBefore;
        if (!cursor) { ended = true; break; }
      }
      const now = pageState(key);
      const merged = !now.loaded ? rows
        : keepShown ? mergeKeepShown(now.rows, rows)
        : mode === 'reload' ? rows : mergeFirstPage(now.rows, rows, ended);
      const keepCursor = mode === 'first' && now.loaded && !ended && merged.length > rows.length;
      setPage(key, {
        rows: merged,
        nextBefore: keepCursor ? now.nextBefore : (cursor ?? null),
        loaded: true, loading: false, error: null,
        pages: mode === 'reload' ? want : Math.max(1, now.pages),
      });
    } catch (error) {
      const failure = mailFailure(error);
      log.warn('mail', 'grouped page read failed', { key, mode, error: failure.message });
      setPage(key, { loading: false, olderLoading: false, error: failure.message });
    }
  }, mode !== 'older');
}

/** Forget a list's pages (the unread filter changed what it holds). */
export function resetPage(scope: MailGroupsScope, group: string, sender = ''): void {
  pages.delete(pageKey(groupsViewKey(scope), group, sender));
  emit();
}

// ── hooks and reset ──

let version = 0;
subscribeGroups(() => { version += 1; });

/** A view's state for a component; re-renders on every write to the grouped store. */
export function useGroupsView(scope: MailGroupsScope): GroupsViewState {
  useSyncExternalStore(subscribeGroups, () => version, () => version);
  return viewState(scope);
}

export function useGroupPage(scope: MailGroupsScope, group: string, sender = ''): GroupPageState {
  useSyncExternalStore(subscribeGroups, () => version, () => version);
  return pageState(pageKey(groupsViewKey(scope), group, sender));
}

/** Every view key that has state (the live layer refreshes the ones an event touches). */
export function knownViews(): GroupsViewState[] {
  return [...views.values()];
}

export function resetMailGroupsStore(): void {
  views.clear(); pages.clear(); overlay.clear(); groupsStartedAt.clear();
  inflight.clear(); again.clear(); railSummary = null;
  emit();
}

onMailStoreReset(resetMailGroupsStore);
