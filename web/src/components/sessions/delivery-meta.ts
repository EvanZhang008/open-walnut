/**
 * The 12 px line under a message the user just sent (spec 4.4 "delivery
 * status", C71), from the optimistic row's state (useSessionSend: a temp id
 * while the send is in flight, then the server's `qm-` message id):
 *
 *   pending                      -> Sending...
 *   received, a turn is running  -> Queued: delivered when this turn ends
 *   received, no turn running    -> Sending... (the session is waking up)
 *   either, 5 s and still there  -> + Starting the session...
 *   delivered                    -> Delivered (fades after 2 s)
 *   failed                       -> Not sent. Tap to retry.
 *
 * Nothing here resends: a retry is the user's tap. Pure, unit tested in
 * tests/web/delivery-meta.test.ts.
 */

export type DeliveryStatus = 'pending' | 'received' | 'delivered' | 'failed' | undefined;

export interface DeliveryMetaInput {
  status: DeliveryStatus;
  /** The session is mid-turn (a queued line waits for that turn to end). */
  turnRunning: boolean;
  /** ms since the user sent it. */
  ageMs: number;
  /** ms since it was delivered (only for 'delivered'). */
  deliveredForMs?: number;
}

export type DeliveryMetaKind = 'sending' | 'queued' | 'delivered' | 'failed';

export interface DeliveryMeta {
  kind: DeliveryMetaKind;
  text: string;
  /** The line is a button that retries the send. */
  retry: boolean;
  /** Fading out (Delivered after 2 s). */
  fading: boolean;
}

export const STARTING_AFTER_MS = 5000;
export const DELIVERED_FADE_AFTER_MS = 2000;

export const DELIVERY_TEXT = {
  sending: 'Sending...',
  queued: 'Queued: delivered when this turn ends',
  delivered: 'Delivered',
  failed: 'Not sent. Tap to retry.',
  starting: 'Starting the session...',
} as const;

export function deliveryMeta(i: DeliveryMetaInput): DeliveryMeta | null {
  switch (i.status) {
    case 'failed':
      return { kind: 'failed', text: DELIVERY_TEXT.failed, retry: true, fading: false };
    case 'delivered':
      return {
        kind: 'delivered', text: DELIVERY_TEXT.delivered, retry: false,
        fading: (i.deliveredForMs ?? 0) >= DELIVERED_FADE_AFTER_MS,
      };
    case 'received':
      if (i.turnRunning) return { kind: 'queued', text: DELIVERY_TEXT.queued, retry: false, fading: false };
      return sending(i.ageMs);
    case 'pending':
      return sending(i.ageMs);
    default:
      return null;
  }
}

function sending(ageMs: number): DeliveryMeta {
  const text = ageMs >= STARTING_AFTER_MS ? `${DELIVERY_TEXT.sending} ${DELIVERY_TEXT.starting}` : DELIVERY_TEXT.sending;
  return { kind: 'sending', text, retry: false, fading: false };
}

/** ms since an ISO timestamp (0 for a missing or unreadable one). */
export function ageOf(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}
