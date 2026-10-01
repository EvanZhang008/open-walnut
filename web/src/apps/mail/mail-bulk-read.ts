/**
 * `Mark N read` and its Undo.
 *
 * One SLOT per target (`<viewKey>|<group>`). While a job runs, the group row shows its
 * progress in place of its buttons. The RESULT always goes to the list's status strip
 * (`Marked 6 read in Ticket updates · Undo`), because a group whose unread all got read leaves the
 * list: a result drawn in the row would vanish with it, Undo and all. A slot belongs to the view it
 * was started in, so a job running while the person moved to another folder never paints there.
 *
 * What it deliberately does NOT do: decrement a group's number before the server answers. The count
 * the button showed and the set the server selects can differ (the watermark), so the row is
 * refreshed from `/groups` when the job ends instead.
 */
import { useSyncExternalStore } from 'react';
import { mailFailure } from '@/api/mail';
import {
  getMailBulkJob, markMailGroupRead, retryMailBulkJob, stopMailBulkJob, undoMailBulkJob,
  type MailGroupsScope, type MailWatermark,
} from '@/api/mail-groups';
import { log } from '@/utils/log';
import { groupsViewKey, pushMailListStatus, updateMailListStatus } from './mail-groups-bus';
import {
  NO_UNREAD_NOW, RESTARTED, STALE_GROUP, UNDO_EXPIRED, bulkResultText, retryLabel,
} from './mail-groups-copy';
import { loadGroupPage, loadGroups, restyleRows, peekView } from './mail-groups-store';
import { onMailStoreReset } from './mail-store';

export const RESULT_MS = 12_000;
/** How long a finished slot is kept so the strip's Undo can still reach its job. */
const SLOT_KEEP_MS = 60_000;
const SHORT_MS = 4_000;
/** A job that ends inside this never shows its intermediate numbers (9.1 step 3). */
const QUIET_MS = 1_000;
const POLL_MS = 2_000;

export interface BulkTarget {
  scope: MailGroupsScope;
  groupId: string;
  /** Named in the result sentence (`Marked 6 read in Ticket updates.`). */
  groupLabel?: string;
}

export interface BulkResult {
  text: string;
  tone: 'success' | 'warn' | 'error';
  /** The job whose changes `Undo` reverts. */
  undoJobId?: string;
  /** `Retry N` re-runs this job's failures. */
  retryJobId?: string;
  retryCount?: number;
  /** `Try again` repeats the original press. */
  tryAgain?: boolean;
  sticky: boolean;
}

export interface BulkSlot {
  key: string;
  viewKey: string;
  target: BulkTarget;
  phase: 'starting' | 'running' | 'result';
  kind: 'read' | 'unread';
  jobId: string | null;
  total: number;
  done: number | null;
  startedAt: number;
  result: BulkResult | null;
  /** The last press, for `Try again`. */
  last: { watermark: MailWatermark; rulesRev: string } | null;
  /** The status strip line this job's result lives on (Undo rewrites it in place). */
  stripId?: string;
}

export function slotKey(target: BulkTarget): string {
  return `${groupsViewKey(target.scope)}|${target.groupId}`;
}

const slots = new Map<string, BulkSlot>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const polls = new Map<string, ReturnType<typeof setInterval>>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const one of [...listeners]) one();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useBulkSlot(key: string): BulkSlot | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return slots.get(key) ?? null;
}

/** Any job still running on a group (its other buttons are disabled meanwhile). */
export function groupBusy(viewKey: string, groupId: string): boolean {
  for (const slot of slots.values()) {
    if (slot.viewKey === viewKey && slot.target.groupId === groupId && slot.phase !== 'result') return true;
  }
  return false;
}

function put(slot: BulkSlot): void {
  slots.set(slot.key, slot);
  emit();
}

// ── the result's lifetime ──

function clearTimer(key: string): void {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function retire(key: string): void {
  clearTimer(key);
  const slot = slots.get(key);
  if (!slot || slot.phase !== 'result') return;
  slots.delete(key);
  emit();
}

function showResult(slot: BulkSlot, result: BulkResult, ms = RESULT_MS): void {
  const stripId = slot.stripId ?? `bulk:${slot.key}:${slot.startedAt}`;
  const next: BulkSlot = { ...slot, phase: 'result', result, stripId };
  put(next);
  // The slot outlives the strip line a while, so an Undo pressed at the last moment still works.
  clearTimer(slot.key);
  timers.set(slot.key, setTimeout(() => retire(slot.key), Math.max(ms, SLOT_KEEP_MS)));
  pushMailListStatus({
    id: stripId,
    viewKey: slot.viewKey,
    text: result.text,
    tone: result.tone,
    ...(result.sticky ? { sticky: true } : { ttlMs: ms }),
    actions: [
      ...(result.undoJobId ? [{ label: 'Undo', testId: 'mail-bulk-undo', run: () => { void undoBulk(slot.key); } }] : []),
      ...(result.retryJobId ? [{ label: retryLabel(result.retryCount ?? 0), testId: 'mail-bulk-retry', run: () => { void retryBulk(slot.key); } }] : []),
      ...(result.tryAgain && slot.last ? [{ label: 'Try again', testId: 'mail-bulk-try-again', run: () => { tryAgainBulk(slot.key); } }] : []),
    ],
  });
}

// ── refresh after a job ──

function refreshAfter(target: BulkTarget): void {
  void loadGroups(target.scope, true);
}

/** More changed rows than the event could name: read that open group's list again. */
function reloadLoaded(target: BulkTarget): void {
  const view = peekView(groupsViewKey(target.scope));
  if (view?.expanded[target.groupId]) void loadGroupPage(target.scope, target.groupId, '', 'first', true, true);
}

// ── starting and following a job ──

function bodyOf(error: unknown): { error?: string; message?: string; jobId?: string } {
  const body = (error as { body?: unknown })?.body;
  return body && typeof body === 'object' ? body as { error?: string; message?: string; jobId?: string } : {};
}

function stopPolling(key: string): void {
  const timer = polls.get(key);
  if (timer) clearInterval(timer);
  polls.delete(key);
}

/** A job is followed by its events and, as a floor for a lost socket, by `GET /bulk/:id` (9.1 step 9). */
function follow(key: string): void {
  stopPolling(key);
  polls.set(key, setInterval(() => { void pollOnce(key); }, POLL_MS));
}

async function pollOnce(key: string): Promise<void> {
  const slot = slots.get(key);
  if (!slot?.jobId || slot.phase !== 'running') { stopPolling(key); return; }
  try {
    const job = await getMailBulkJob(slot.jobId);
    if (job.state === 'done') {
      finish(slot.jobId, { changedCount: job.changedCount, failedCount: job.failed.length, stopped: job.stopped }, job.failed[0]?.reason);
      return;
    }
    progress(slot.jobId, job.done, job.total);
  } catch (error) {
    if (mailFailure(error).status !== 404) return;
    // The server restarted: the job is gone, what it changed stays changed.
    stopPolling(key);
    refreshAfter(slot.target);
    showResult(slot, { text: RESTARTED, tone: 'warn', sticky: false });
  }
}

function running(slot: BulkSlot, jobId: string, total: number, kind: 'read' | 'unread'): void {
  put({ ...slot, phase: 'running', kind, jobId, total, done: null, startedAt: Date.now(), result: null });
  follow(slot.key);
}

/**
 * The press. The watermark and rules revision are the ones the button was RENDERED with, so the
 * server marks only what the person saw (C14) and refuses when the groups moved since (C18).
 */
export async function startBulkRead(
  target: BulkTarget,
  rendered: { watermark: MailWatermark; rulesRev: string; total: number },
  /** A retry writes over the strip line of the press it repeats. */
  stripId?: string,
): Promise<void> {
  const key = slotKey(target);
  if (slots.get(key)?.phase === 'starting' || slots.get(key)?.phase === 'running') return;
  clearTimer(key);
  const slot: BulkSlot = {
    key, viewKey: groupsViewKey(target.scope), target, phase: 'starting', kind: 'read', jobId: null,
    total: rendered.total, done: null, startedAt: Date.now(), result: null,
    last: { watermark: rendered.watermark, rulesRev: rendered.rulesRev },
    ...(stripId ? { stripId } : {}),
  };
  put(slot);
  try {
    const answer = await markMailGroupRead({
      scope: target.scope, group: target.groupId,
      watermark: rendered.watermark, rulesRev: rendered.rulesRev,
    });
    running(slot, answer.jobId, answer.total, 'read');
  } catch (error) {
    const body = bodyOf(error);
    const failure = mailFailure(error);
    if (failure.status === 409 && body.error === 'in-flight' && body.jobId) {
      // The second press of the same job is not an error: follow the one already running.
      running(slot, body.jobId, rendered.total, 'read');
      return;
    }
    refreshAfter(target);
    if (failure.status === 409 && body.error === 'stale') {
      showResult(slot, { text: STALE_GROUP, tone: 'warn', sticky: false });
      return;
    }
    const reason = body.message ?? failure.message;
    showResult(slot, {
      text: failure.status === 409 && body.error === 'recomputing' ? reason : bulkResultText({ kind: 'read', changed: 0, failed: 1, firstReason: reason }),
      tone: 'error', tryAgain: true, sticky: true,
    });
    log.warn('mail', 'bulk read refused', { key, code: failure.code, error: failure.message });
  }
}

function slotOfJob(jobId: string): BulkSlot | null {
  for (const slot of slots.values()) if (slot.jobId === jobId) return slot;
  return null;
}

/** `plugin:mail:bulk-progress`. Nothing to say inside the first second. */
export function progress(jobId: string, done: number, total: number): void {
  const slot = slotOfJob(jobId);
  if (!slot || slot.phase !== 'running') return;
  const quiet = Date.now() - slot.startedAt < QUIET_MS;
  put({ ...slot, total, done: quiet ? slot.done : done });
}

export interface BulkDone {
  changedCount: number;
  failedCount: number;
  changedIds?: Array<{ accountId: string; messageId: string }>;
  stopped?: boolean;
}

/** `plugin:mail:bulk-done` (or the poll finding the job done). */
export function finish(jobId: string, done: BulkDone, firstReason?: string): void {
  const slot = slotOfJob(jobId);
  if (!slot || slot.phase !== 'running') return;
  stopPolling(slot.key);
  if (done.changedIds) restyleRows(done.changedIds, slot.kind === 'read');
  else if (done.changedCount > 0) reloadLoaded(slot.target);
  refreshAfter(slot.target);
  if (done.failedCount > 0 && firstReason === undefined) {
    // The event names no reason: the job record does.
    void getMailBulkJob(jobId)
      .then((job) => { conclude(slot, done, job.failed[0]?.reason ?? ''); })
      .catch(() => { conclude(slot, done, ''); });
    return;
  }
  conclude(slot, done, firstReason ?? '');
}

function conclude(slot: BulkSlot, done: BulkDone, reason: string): void {
  const text = bulkResultText({
    kind: slot.kind, changed: done.changedCount, failed: done.failedCount, firstReason: reason,
    ...(done.stopped ? { stopped: true } : {}),
    ...(slot.target.groupLabel ? { groupLabel: slot.target.groupLabel } : {}),
  });
  const allFailed = done.changedCount === 0 && done.failedCount > 0;
  const undoable = slot.kind === 'read' && done.changedCount > 0;
  const result: BulkResult = {
    text,
    tone: allFailed ? 'error' : done.failedCount > 0 ? 'warn' : 'success',
    ...(undoable && slot.jobId ? { undoJobId: slot.jobId } : {}),
    ...(done.failedCount > 0 && !allFailed && slot.jobId ? { retryJobId: slot.jobId, retryCount: done.failedCount } : {}),
    ...(allFailed ? { tryAgain: true } : {}),
    sticky: done.failedCount > 0,
  };
  // An Undo that fully worked says so briefly; everything else gets the 12 s (9.2).
  showResult({ ...slot, phase: 'result' }, result, slot.kind === 'unread' && done.failedCount === 0 ? SHORT_MS : RESULT_MS);
}

/** `Undo`: its own job, with the same progress and the same partial failure as the mark (9.2). */
export async function undoBulk(key: string): Promise<void> {
  const slot = slots.get(key);
  const jobId = slot?.result?.undoJobId;
  if (!slot || !jobId) return;
  clearTimer(key);
  if (slot.stripId) updateMailListStatus(slot.stripId, { text: 'Undoing\u2026', tone: 'info', actions: [], sticky: true });
  put({ ...slot, phase: 'starting', kind: 'unread', result: null });
  try {
    const answer = await undoMailBulkJob(jobId);
    running(slots.get(key) ?? slot, answer.jobId, answer.total, 'unread');
  } catch (error) {
    const failure = mailFailure(error);
    const body = bodyOf(error);
    const expired = failure.status === 410 || failure.status === 404;
    showResult({ ...slot, kind: 'unread' }, expired
      ? { text: UNDO_EXPIRED, tone: 'warn', sticky: false }
      : { text: bulkResultText({ kind: 'unread', changed: 0, failed: 1, firstReason: body.message ?? failure.message }), tone: 'error', sticky: true },
    SHORT_MS);
  }
}

/** `Retry N`: only the failures of that job, as a new job of the same kind. */
export async function retryBulk(key: string): Promise<void> {
  const slot = slots.get(key);
  const jobId = slot?.result?.retryJobId;
  if (!slot || !jobId) return;
  put({ ...slot, phase: 'starting', result: null });
  try {
    const answer = await retryMailBulkJob(jobId);
    running(slots.get(key) ?? slot, answer.jobId, answer.total, slot.kind);
  } catch (error) {
    const failure = mailFailure(error);
    showResult(slot, {
      text: bulkResultText({ kind: slot.kind, changed: 0, failed: 1, firstReason: bodyOf(error).message ?? failure.message }),
      tone: 'error', sticky: true, tryAgain: false,
    });
  }
}

/**
 * `Try again` after a refusal: the same press with the numbers the group shows NOW (the refusal
 * already re-read the groups), so a stale watermark is not simply sent again.
 */
export function tryAgainBulk(key: string): void {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  clearTimer(key);
  if (slot.stripId) updateMailListStatus(slot.stripId, { text: 'Trying again\u2026', tone: 'info', actions: [], sticky: true });
  const view = peekView(slot.viewKey);
  const group = view?.groups?.groups.find((one) => one.id === slot.target.groupId);
  if (!group || !view?.groups) {
    if (slot.stripId) updateMailListStatus(slot.stripId, { text: NO_UNREAD_NOW, tone: 'info', sticky: false, ttlMs: 4_000 });
    return;
  }
  void startBulkRead(slot.target, { watermark: group.watermark, rulesRev: view.groups.rulesRev, total: group.markableUnread }, slot.stripId);
}

/** `Stop`: nothing new starts; the two in flight finish; the job ends `stopped` and stays undoable. */
export async function stopBulk(key: string): Promise<void> {
  const slot = slots.get(key);
  if (!slot?.jobId || slot.phase !== 'running') return;
  try { await stopMailBulkJob(slot.jobId); } catch (error) {
    log.warn('mail', 'bulk stop refused', { key, error: mailFailure(error).message });
  }
}

/** The live layer hands the two bulk events here. */
export function onBulkEvent(name: string, data: unknown): void {
  const payload = (data ?? {}) as { jobId?: string; done?: number; total?: number } & Partial<BulkDone>;
  if (!payload.jobId) return;
  if (name === 'bulk-progress') progress(payload.jobId, payload.done ?? 0, payload.total ?? 0);
  if (name === 'bulk-done') {
    finish(payload.jobId, {
      changedCount: payload.changedCount ?? 0, failedCount: payload.failedCount ?? 0,
      ...(payload.changedIds ? { changedIds: payload.changedIds } : {}),
      ...(payload.stopped ? { stopped: true } : {}),
    });
  }
}

export function resetBulkForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  for (const timer of polls.values()) clearInterval(timer);
  timers.clear(); polls.clear(); slots.clear();
  emit();
}

onMailStoreReset(resetBulkForTests);
