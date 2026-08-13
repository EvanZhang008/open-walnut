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
 * Open a NEW draft session column on the home page, optionally seeded with a
 * project — the cross-page twin of the home panel's project-header "+".
 *
 * Rides the existing `session-launcher:open` event (already MainPage's "grow a
 * draft column" entry, used by the `/session` slash command) rather than a new
 * channel, so /tasks and the command palette share one code path. The optional
 * `project` detail routes MainPage to its handleOpenLauncherForProject, which also
 * patches in the project's default folder when the detail fetch lands.
 *
 * MainPage stays mounted behind every route (App.tsx), so the listener is live
 * before the navigation — the draft is already open by the time home paints.
 */
export function openDraftSessionOnHome(project: string | undefined, navigate: (to: string) => void): void {
  window.dispatchEvent(new CustomEvent('session-launcher:open', { detail: project ? { project } : undefined }));
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
