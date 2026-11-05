/**
 * One browser, one permission request.
 *
 * A pending permission / AskUserQuestion ask is shown by THREE surfaces at once
 * — the session timeline card (SessionChatHistory), the notification rail card
 * (NotificationPanel) and the toast (NotificationToaster) — and all three are
 * mounted together on the home page. Each used to keep a private `useState`
 * copy and POST `/api/sessions/:id/permission` itself, so answering in one left
 * the other two armed: approving from the rail and then clicking Approve in the
 * timeline 404'd, and that card stamped "Denied" on a request the user had just
 * APPROVED.
 *
 * So the request's state lives here, keyed by `requestId`, and every surface
 * reads it through `usePermissionRequest`. One writer (`respondToPermissionRequest`)
 * flips the status optimistically BEFORE the round-trip, which is what makes the
 * other two surfaces settle in the same frame instead of waiting on the REST
 * answer plus its WS echo (a stalled server used to leave them disagreeing for
 * seconds). The `session:permission-request` / `session:permission-resolved`
 * events feed the same store from ONE subscription (NotificationProvider), so a
 * decision taken on the phone or in another tab lands here too.
 *
 * The store is deliberately not the only truth a card can read: a HISTORY-only
 * card (reloaded page, evicted entry) has no store entry and falls back to the
 * status the stream block carries. That is why eviction below is safe.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { respondToPermission } from '@/api/sessions';
import { buildImageRefsPayload } from '@/api/image-upload';
import type { ImageAttachment } from '@/api/chat';
import { log } from '@/utils/log';

/**
 * Status vocabulary, shared by every surface.
 *
 * `stale` is the third OUTCOME and the reason this store exists: a 404/409 means
 * the request already settled somewhere else and we never learned which way, so
 * the card must say "Already answered" — claiming `denied` there is the bug.
 * `expired` is the server withdrawing the ask (session died, CLI took it back,
 * superseded); it also arrives as `allowed: false`, so it must be read from the
 * cancelled/expired flags FIRST or it reads as the user's Deny.
 */
export type PermissionRequestStatus =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'stale'
  | 'expired';

export interface PermissionRequestState {
  status: PermissionRequestStatus;
  /** A response is in flight — surfaces disable their controls, never re-submit. */
  inFlight: boolean;
  /** The last attempt failed transiently (network / 5xx) and `status` rolled back
   *  to `pending`, so the user can retry. Cleared by the next attempt. */
  failed: boolean;
  /** Why the server held the last attempt, in its words (a rule's file it cannot write). */
  failReason?: string;
  /** ACP option the user picked (Allow for Session, a prefix amendment, …). */
  optionId?: string;
  /** AskUserQuestion answers as submitted — a settled card shows what was said. */
  answers?: Record<string, string>;
  /** Message that rode along with a denial (the "dismissed the questions" note). */
  message?: string;
  /** A message sent to its session while it waited denies it (the server's rule): its card says so. */
  byMessage?: boolean;
  /** Answered in this browser (respondToPermissionRequest), not settled by word from elsewhere. */
  answeredHere?: boolean;
}

/** Everything except `pending` is a settled request: no more Approve/Deny. */
export function isSettledPermission(status: PermissionRequestStatus): boolean {
  return status !== 'pending';
}

/**
 * Cap on remembered requests. A long-lived tab can watch hundreds of asks, and an
 * evicted entry degrades to the stream block's own status — the same fallback a
 * reloaded page uses — so trimming is lossless for the user.
 */
const MAX_ENTRIES = 300;

const entries = new Map<string, PermissionRequestState>();
const listeners = new Set<() => void>();

function emit(): void {
  // Copy: a listener that unsubscribes while notifying must not mutate the set
  // being walked.
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function write(requestId: string, next: PermissionRequestState): void {
  // Re-insert so Map iteration order is least-recently-written first, which is
  // what makes the trim below evict the oldest.
  entries.delete(requestId);
  entries.set(requestId, next);
  if (entries.size > MAX_ENTRIES) {
    for (const [id, state] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      // Never evict something still in flight or still answerable.
      if (state.inFlight || state.status === 'pending') continue;
      entries.delete(id);
    }
  }
  emit();
}

export function getPermissionRequest(requestId: string): PermissionRequestState | undefined {
  return entries.get(requestId);
}

/**
 * Note a request that is now open, without touching one we already know about:
 * the CLI re-emits an UNRESOLVED ask every 60s, and re-seeding would re-arm a
 * card whose answer is already in flight.
 */
export function seedPermissionRequest(requestId: string): void {
  if (!requestId || entries.has(requestId)) return;
  write(requestId, { status: 'pending', inFlight: false, failed: false });
}

/** Map a `session:permission-resolved` payload onto a status. */
export function resolvedStatusOf(
  ev: { allowed?: boolean; cancelled?: boolean; expired?: boolean },
): PermissionRequestStatus | null {
  // Withdrawn FIRST: a cancelled/expired request also carries `allowed: false`,
  // so reading the boolean first would label the server's withdrawal as the
  // user's Deny (same precedence as the server's own stamp).
  if (ev.cancelled === true || ev.expired === true) return 'expired';
  if (typeof ev.allowed === 'boolean') return ev.allowed ? 'allowed' : 'denied';
  return null;
}

/**
 * Settle from the authoritative server event. Idempotent, and it never re-arms:
 * a resolved request can only move between settled statuses (e.g. our optimistic
 * `allowed` being confirmed), never back to `pending`.
 */
export function settlePermissionRequest(
  requestId: string,
  status: PermissionRequestStatus,
): void {
  if (!requestId || status === 'pending') return;
  const current = entries.get(requestId);
  if (current?.status === status && !current.inFlight && !current.failed) return;
  write(requestId, {
    ...current,
    status,
    inFlight: false,
    failed: false,
  });
}

export interface RespondOptions {
  optionId?: string;
  answers?: Record<string, string>;
  message?: string;
  /**
   * Pictures with an own-words answer. They go in the same request as the answers, and the server
   * puts them in the same tool result (core/answer-pictures.ts withAnswerPictures), so the model
   * reads them together; never as a message after it (the model answered before they came).
   */
  images?: ImageAttachment[];
}

/**
 * The ONE write path. Flips the status optimistically so every surface settles in
 * the same frame, then reconciles with the route:
 *   - 404/409  → `stale`: the request already settled elsewhere. Settling (rather
 *     than re-arming) is what killed the zombie-card loop (2026-08-11: 8
 *     approve→404 clicks on 2 cards), and `stale` rather than `denied` is what
 *     stops a request the user APPROVED from reading "Denied".
 *   - anything else → roll back to `pending` with `failed`, so a network blip is
 *     retryable instead of eating the decision.
 */
export async function respondToPermissionRequest(
  sessionId: string,
  requestId: string,
  allow: boolean,
  opts: RespondOptions = {},
): Promise<PermissionRequestStatus | 'failed'> {
  if (!sessionId || !requestId) return 'failed';
  const current = entries.get(requestId);
  if (current?.inFlight) return 'failed';
  if (current && isSettledPermission(current.status)) return current.status;

  const optimistic: PermissionRequestStatus = allow ? 'allowed' : 'denied';
  write(requestId, {
    status: optimistic,
    inFlight: true,
    failed: false,
    answeredHere: true,
    ...(opts.optionId ? { optionId: opts.optionId } : {}),
    ...(opts.answers ? { answers: opts.answers } : {}),
    ...(opts.message ? { message: opts.message } : {}),
  });

  try {
    const pictures = allow && opts.answers && opts.images?.length ? await buildImageRefsPayload(opts.images) : undefined;
    await respondToPermission(sessionId, requestId, allow, opts.message, opts.optionId, opts.answers, pictures);
    if (pictures) log.info('notifications', 'answer pictures sent with the answers', { sessionId, count: opts.images!.length });
    const settled = entries.get(requestId);
    // A server event may have landed while we waited (the resolution we just
    // caused, or a withdrawal) — it wins, so only clear the in-flight flag.
    write(requestId, { ...(settled ?? { status: optimistic, failed: false }), inFlight: false, failed: false });
    return entries.get(requestId)?.status ?? optimistic;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const stale = status === 404 || status === 409;
    const settled = entries.get(requestId);
    // 422: the server held the answer on purpose and says why (the prompt is still open).
    const reason = status === 422 && err instanceof Error && err.message ? err.message : undefined;
    const { failReason: _was, ...rest } = settled ?? { status: 'pending' as const, inFlight: false, failed: false };
    write(requestId, {
      ...rest,
      status: stale ? 'stale' : 'pending',
      inFlight: false,
      failed: !stale,
      ...(reason ? { failReason: reason } : {}),
    });
    log.warn('notifications', 'permission respond failed', {
      sessionId, requestId, status: String(status ?? ''), error: String(err),
    });
    return stale ? 'stale' : 'failed';
  }
}

/**
 * The person sent a message to the session while this prompt waited: the server
 * denies it for them. Kept on the entry until an answer of theirs replaces it, so
 * the settled card reads "Denied by your message", not a Deny they never gave.
 */
export function markDeniedByMessage(requestId: string): void {
  const current = entries.get(requestId);
  if (!requestId || current?.inFlight || (current && current.status !== 'pending')) return;
  write(requestId, { ...(current ?? { status: 'pending', inFlight: false, failed: false }), byMessage: true });
}

// Requests answered from their toast: that toast says which choice went for a beat
// before it leaves (NotificationToaster), instead of vanishing on the server's echo.
const answeredFromToast = new Set<string>();
export function markAnsweredFromToast(requestId: string): void {
  answeredFromToast.add(requestId);
  if (answeredFromToast.size > 200) answeredFromToast.delete(answeredFromToast.values().next().value as string);
}
export function wasAnsweredFromToast(requestId: string): boolean {
  return answeredFromToast.has(requestId);
}

/** Tests only: forget every remembered request. */
export function resetPermissionRequestStore(): void {
  entries.clear();
  answeredFromToast.clear();
  emit();
}

export const permissionRequestStore = {
  subscribe,
  get: getPermissionRequest,
};

/**
 * Subscribe one surface to one request. `undefined` = this browser knows nothing
 * about it (a history-only card after a reload, or an evicted entry) — the caller
 * falls back to whatever status its own record carries.
 *
 * Entries are replaced, never mutated, so returning the map value straight is a
 * stable snapshot for useSyncExternalStore.
 */
export function usePermissionRequest(
  requestId: string | undefined,
): PermissionRequestState | undefined {
  const snapshot = useCallback(
    () => (requestId ? entries.get(requestId) : undefined),
    [requestId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
