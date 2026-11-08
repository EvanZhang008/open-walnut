// Minimize from a panel that is not one of Home's columns (the Org page's side panel):
// the session joins Home's taskbar chips. Home stays mounted on every route, so it hears
// the request at once and keeps the one copy of the bar (pages/sessionTaskbar.ts).

const EVENT = 'walnut:minimize-to-taskbar';

export function requestMinimizeToTaskbar(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: sessionId }));
}

/** Home's listener; returns the unsubscribe. */
export function onMinimizeToTaskbar(handler: (sessionId: string) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<unknown>).detail;
    if (typeof id === 'string' && id) handler(id);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
