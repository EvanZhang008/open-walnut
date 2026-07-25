/**
 * Open a session on the HOME page's session columns — the ONLY session
 * surface (the dedicated /sessions page was removed). MainPage is always
 * mounted (App.tsx keeps it alive behind other routes), so the custom event
 * reaches its listener even when another page is active; navigating home then
 * reveals the opened column. Same window-event bridge pattern as
 * `dock:activate-task` / `sidebar:toggle-todo`.
 */
export function openSessionOnHome(sessionId: string, navigate: (to: string) => void): void {
  window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId } }));
  navigate('/');
}

/**
 * Navigate to a deep-link target, rerouting session links (`/sessions?id=…`)
 * to the home-page session columns. Non-session targets navigate as-is.
 */
export function navigateToTarget(to: string, navigate: (to: string) => void): void {
  const m = /^\/sessions\?id=([^&]+)$/.exec(to);
  if (m) openSessionOnHome(decodeURIComponent(m[1]), navigate);
  else navigate(to);
}
