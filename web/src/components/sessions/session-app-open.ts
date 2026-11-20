/**
 * Open a plugin App's session pane from anywhere in the console (a link to a drawing, a
 * button in another view): every mounted SessionPanel showing `sessionId` opens its App view
 * on `appKey`, and on `documentPath` when one is given. A panel that is not mounted is not
 * opened by it; the caller opens the session first.
 *
 * A window event, like the panel's other outside requests, so the caller needs no handle on
 * the panel and a panel that unmounted mid-way simply hears nothing.
 */
export const SESSION_APP_OPEN_EVENT = 'session:open-app';

export interface SessionAppOpenRequest {
  sessionId: string;
  /** The App's registry key, `<pluginId>:<appId>`. */
  appKey: string;
  /** The document to show (opaque to Walnut); absent: the one the App showed last here. */
  documentPath?: string;
}

/** True when a panel showing the session took it (it cancels the event), false when none is mounted. */
export function openSessionApp(request: SessionAppOpenRequest): boolean {
  return !window.dispatchEvent(new CustomEvent<SessionAppOpenRequest>(SESSION_APP_OPEN_EVENT, { detail: request, cancelable: true }));
}

/** The request an event carries, or null for a malformed one (another script's event of the same name). */
export function sessionAppOpenRequest(event: Event): SessionAppOpenRequest | null {
  const detail = (event as CustomEvent<unknown>).detail as Partial<SessionAppOpenRequest> | null | undefined;
  if (!detail || typeof detail.sessionId !== 'string' || typeof detail.appKey !== 'string' || !detail.appKey) return null;
  if (detail.documentPath !== undefined && typeof detail.documentPath !== 'string') return null;
  return { sessionId: detail.sessionId, appKey: detail.appKey, ...(detail.documentPath ? { documentPath: detail.documentPath } : {}) };
}
