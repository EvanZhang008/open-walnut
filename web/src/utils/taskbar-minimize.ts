// Minimize from any session panel: the session joins the app's taskbar chips
// (pages/sessionTaskbarStore.ts), and Home takes it off its strip when it shows it there.
// One request, heard by both, so a panel never needs to know which page it is on.

const EVENT = 'walnut:minimize-to-taskbar';

export function requestMinimizeToTaskbar(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: sessionId }));
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
