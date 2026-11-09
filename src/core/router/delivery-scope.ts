import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionRecord } from '../types.js';
import { PERSON_SEND_SOURCES } from '../sessions/send-sent-by.js';

const delivery = new AsyncLocalStorage<{ sessionId: string; messageId: string }>();

export function withRouterDelivery<T>(sessionId: string, messageId: string, work: () => Promise<T>): Promise<T> {
  return delivery.run({ sessionId, messageId }, work);
}

export function isRouterDelivery(sessionId: string, messageId: string | undefined): boolean {
  const held = delivery.getStore();
  return !!held && held.sessionId === sessionId && held.messageId === messageId;
}

export const AREA_RECOVERY_SOURCES = new Set(['auto-recover', 'context-compact', 'context-recovery']);

export const ROUTER_RUNTIME_SOURCE = 'router-runtime';

const wake = new AsyncLocalStorage<{ sessionId: string }>();
let wakeGranted = false;

/** Handed out once, to router/wake.ts as it loads: no other module can open a router wake. */
export function takeRouterWakeGrant(): <T>(sessionId: string, work: () => Promise<T>) => Promise<T> {
  if (wakeGranted) throw new Error('The router wake grant is already taken');
  wakeGranted = true;
  return (sessionId, work) => wake.run({ sessionId }, work);
}

export function isRouterWake(sessionId: string): boolean {
  return wake.getStore()?.sessionId === sessionId;
}

export const AREA_DELIVERY_REFUSED = 'Automatic unscoped context is not delivered into an area session';

/**
 * The area check for a message delivered into a session. Its callers: sendMessageToSession
 * (session-message-queue.ts), and the two raw enqueues behind a pending prompt that skip it
 * (session-send-core.ts deliverToSession, human-inbox/letter-ops.ts deliverLetterToOrigin).
 * A start's own first line (claude-code-session.ts spawn and start-recovery rows) and queue row
 * moves (park, engine switch, folder move) do not pass here. An area session
 * takes only a person's words, its own recovery, a router delivery under its grant, or (a router
 * session) the router wake; the router wake source reaches nothing else. Returns whether the
 * session is area-scoped. `record` is read fresh by the caller for `sessionId`.
 */
export function assertAreaDelivery(
  record: Pick<SessionRecord, 'profile'> | null | undefined,
  sessionId: string,
  source: string | undefined,
  messageId: string | undefined,
): boolean {
  const scopedArea = !!record?.profile?.areaId;
  if (!scopedArea && source !== ROUTER_RUNTIME_SOURCE) return false;
  const allowed = source === ROUTER_RUNTIME_SOURCE
    ? scopedArea && record?.profile?.areaRole === 'router' && isRouterWake(sessionId)
    : PERSON_SEND_SOURCES.has(source ?? '') || AREA_RECOVERY_SOURCES.has(source ?? '') || isRouterDelivery(sessionId, messageId);
  if (!allowed) throw new Error(AREA_DELIVERY_REFUSED);
  return scopedArea;
}
