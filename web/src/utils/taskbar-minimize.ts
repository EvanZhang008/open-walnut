// Minimize from any session panel: the session joins the app's taskbar chips
// (pages/sessionTaskbarStore.ts), and Home takes it off its strip when it shows it there.
// One request, heard by both, so a panel never needs to know which page it is on.

const EVENT = 'walnut:minimize-to-taskbar';

export function requestMinimizeToTaskbar(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: sessionId }));
}

const OPEN_ON_PAGE = 'walnut:taskbar-open-on-page';

/** A chip clicked on a page that opens sessions itself (the Org page): true when it took it. */
export function requestOpenOnPage(sessionId: string): boolean {
  const e = new CustomEvent<string>(OPEN_ON_PAGE, { detail: sessionId, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

/** The page's answer to requestOpenOnPage; returns the unsubscribe. */
export function onOpenOnPage(handler: (sessionId: string) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<unknown>).detail;
    if (typeof id !== 'string' || !id) return;
    e.preventDefault();
    handler(id);
  };
  window.addEventListener(OPEN_ON_PAGE, listener);
  return () => window.removeEventListener(OPEN_ON_PAGE, listener);
}

/** Subscribe to the request; returns the unsubscribe. */
export function onMinimizeToTaskbar(handler: (sessionId: string) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<unknown>).detail;
    if (typeof id === 'string' && id) handler(id);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
