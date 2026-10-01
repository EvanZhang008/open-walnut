/**
 * A tiny external store the grouped-inbox pieces talk through, so a row, a popover, a dialog and
 * the list's status strip never import each other.
 *
 * Three channels, each small on purpose:
 * - the LEARN request: which correction card (a mail's, or a group's) is open, anchored where;
 * - the list STATUS strip: up to 3 short notes per view (newest first), with optional actions;
 * - two plain signals: "refetch the groups" and "these mails moved out of the view".
 *
 * `useSyncExternalStore` with snapshot objects that change identity only on a write, so a reader
 * re-renders exactly when its own channel moved.
 */
import { useSyncExternalStore } from 'react';
import type { MailGroupsScope } from '@/api/mail-groups';

/** The key every view-scoped note is filed under: `smart:inbox` or `acct/<a>/<m>`. */
export function groupsViewKey(scope: MailGroupsScope): string {
  return 'role' in scope ? `smart:${scope.role}` : `acct/${scope.accountId}/${scope.mailboxId}`;
}

// ── learn requests ──

export interface MailCorrectRequest {
  kind: 'correct';
  accountId: string;
  messageId: string;
  groupId: string;
  /** The group's name as the row has it (a sender's group is not in the catalog). */
  groupLabel?: string;
  scope: MailGroupsScope;
  viewKey: string;
  anchor: HTMLElement;
  returnFocus?: HTMLElement | null;
  /** The destination the menu item named (`important` or `not-important`), picked when the card opens. */
  preset?: string;
}

/** A group's `These are important…`, `Rename group` and `Keep out of Inbox…`: a small card on the row. */
export interface MailGroupCardRequest {
  kind: 'group-important' | 'rename' | 'group-filter';
  groupId: string;
  label: string;
  unread: number;
  scope: MailGroupsScope;
  viewKey: string;
  anchor: HTMLElement;
  /** `group-filter`: the unread the person sees (what "move them now" touches). */
  watermark?: { at: number; seq: number };
  /** `group-filter`: accounts whose mail cannot be moved. */
  cannotArchive?: string[];
}

export type MailLearnRequest = MailCorrectRequest | MailGroupCardRequest;

let learn: MailLearnRequest | null = null;
const learnListeners = new Set<() => void>();

function setLearn(next: MailLearnRequest | null): void {
  learn = next;
  for (const one of learnListeners) one();
}

export function requestMailCorrect(request: Omit<MailCorrectRequest, 'kind'>): void {
  setLearn({ kind: 'correct', ...request });
}

export function requestGroupCard(request: MailGroupCardRequest): void {
  setLearn(request);
}

export function closeMailLearnRequest(): void {
  if (learn) setLearn(null);
}

function subscribeLearn(fn: () => void): () => void {
  learnListeners.add(fn);
  return () => { learnListeners.delete(fn); };
}

export function useMailLearnRequest(): MailLearnRequest | null {
  return useSyncExternalStore(subscribeLearn, () => learn, () => learn);
}

// ── list status strip ──

export interface MailListStatusAction {
  label: string;
  testId?: string;
  run: () => void;
}

export interface MailListStatus {
  id: string;
  viewKey: string;
  text: string;
  tone?: 'info' | 'success' | 'warn' | 'error';
  /** Stays until dismissed (no ttl). */
  sticky?: boolean;
  /** Auto-dismiss after this long; default 8 s unless sticky. */
  ttlMs?: number;
  actions?: MailListStatusAction[];
}

const MAX_STATUS = 3;
const DEFAULT_TTL_MS = 8_000;

let statuses: MailListStatus[] = [];
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const statusListeners = new Set<() => void>();
/** Per view, the last array handed out, so a snapshot keeps its identity between writes. */
const viewCache = new Map<string, { source: MailListStatus[]; view: MailListStatus[] }>();

function announceStatus(): void {
  for (const one of statusListeners) one();
}

function arm(status: MailListStatus): void {
  const old = statusTimers.get(status.id);
  if (old) clearTimeout(old);
  statusTimers.delete(status.id);
  if (status.sticky) return;
  const timer = setTimeout(() => dismissMailListStatus(status.id), status.ttlMs ?? DEFAULT_TTL_MS);
  statusTimers.set(status.id, timer);
}

/** Adds (or replaces, by id) a note; the view keeps its newest 3. */
export function pushMailListStatus(status: MailListStatus): void {
  const rest = statuses.filter((one) => one.id !== status.id);
  const next = [status, ...rest];
  const inView = next.filter((one) => one.viewKey === status.viewKey);
  const dropped = new Set(inView.slice(MAX_STATUS).map((one) => one.id));
  for (const id of dropped) {
    const timer = statusTimers.get(id);
    if (timer) clearTimeout(timer);
    statusTimers.delete(id);
  }
  statuses = next.filter((one) => !dropped.has(one.id));
  arm(status);
  announceStatus();
}

/** Changes a note in place (a progress line becoming a result); a missing id is a no-op. */
export function updateMailListStatus(id: string, patch: Partial<Omit<MailListStatus, 'id' | 'viewKey'>>): void {
  let found: MailListStatus | undefined;
  statuses = statuses.map((one) => {
    if (one.id !== id) return one;
    found = { ...one, ...patch };
    return found;
  });
  if (!found) return;
  if ('sticky' in patch || 'ttlMs' in patch) arm(found);
  announceStatus();
}

export function dismissMailListStatus(id: string): void {
  const timer = statusTimers.get(id);
  if (timer) clearTimeout(timer);
  statusTimers.delete(id);
  const next = statuses.filter((one) => one.id !== id);
  if (next.length === statuses.length) return;
  statuses = next;
  announceStatus();
}

function subscribeStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

function statusesFor(viewKey: string): MailListStatus[] {
  const cached = viewCache.get(viewKey);
  if (cached && cached.source === statuses) return cached.view;
  const view = statuses.filter((one) => one.viewKey === viewKey).slice(0, MAX_STATUS);
  const same = cached && cached.view.length === view.length && cached.view.every((one, i) => one === view[i]);
  const stable = same ? cached!.view : view;
  viewCache.set(viewKey, { source: statuses, view: stable });
  return stable;
}

/** The notes of one view, newest first, at most 3. */
export function useMailListStatus(viewKey: string): MailListStatus[] {
  return useSyncExternalStore(subscribeStatus, () => statusesFor(viewKey), () => statusesFor(viewKey));
}

/** Non-hook read (tests, imperative callers). */
export function mailListStatusSnapshot(viewKey: string): MailListStatus[] {
  return statusesFor(viewKey);
}

// ── signals ──

const refreshListeners = new Set<() => void>();
const movedListeners = new Set<(ids: Array<{ accountId: string; messageId: string }>) => void>();

/** Ask every mounted grouped view to refetch `/groups` (after a save, a bulk job, an undo). */
export function requestGroupsRefresh(): void {
  for (const one of [...refreshListeners]) one();
}

export function onGroupsRefresh(cb: () => void): () => void {
  refreshListeners.add(cb);
  return () => { refreshListeners.delete(cb); };
}

/** These mails left the list they were shown in (a correction moved them to another group). */
export function markMailMovedOut(ids: Array<{ accountId: string; messageId: string }>): void {
  if (ids.length === 0) return;
  for (const one of [...movedListeners]) one(ids);
}

export function onMailMovedOut(cb: (ids: Array<{ accountId: string; messageId: string }>) => void): () => void {
  movedListeners.add(cb);
  return () => { movedListeners.delete(cb); };
}

/** Test seam: forget every note, timer and request. */
export function resetMailGroupsBusForTests(): void {
  for (const timer of statusTimers.values()) clearTimeout(timer);
  statusTimers.clear();
  statuses = [];
  viewCache.clear();
  learn = null;
  announceStatus();
}
