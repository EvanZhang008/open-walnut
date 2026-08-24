/**
 * Open a session on the HOME page's session columns — the ONLY session
 * surface (the dedicated /sessions page was removed). MainPage is always
 * mounted (App.tsx keeps it alive behind other routes), so the custom event
 * reaches its listener even when another page is active; navigating home then
 * reveals the opened column. Same window-event bridge pattern as
 * `dock:activate-task` / `sidebar:toggle-todo`.
 */
import { armSessionInboxLink, parseSessionInboxTarget } from '@/components/inbox/session-inbox-link';

/** Extra state a session deep link can carry (currently: the Inbox tab). */
export interface OpenSessionOptions {
  /** Open the panel's Inbox tab; with a letter id, on that letter. */
  inboxLetterId?: string;
  inboxTab?: boolean;
}

export function openSessionOnHome(
  sessionId: string,
  navigate: (to: string) => void,
  opts?: OpenSessionOptions,
): void {
  // Park the tab request BEFORE the column opens: the panel is what consumes it,
  // and it does not exist yet (session-inbox-link.ts explains the mailbox).
  //
  // Note for anyone tempted to defer this until after `navigate('/')`: it does not
  // help. React Router's `useLocation()` still reports the OLD pathname for a beat
  // after the URL changes, so a panel opened from another route mounts thinking it
  // is on that route and then sees a pathname change. SessionPanel absorbs that
  // (see DEEP_LINK_SETTLE_MS there) rather than this function guessing at timing.
  if (opts?.inboxTab || opts?.inboxLetterId) armSessionInboxLink(sessionId, opts.inboxLetterId);
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
 *
 * A session link may carry `&tab=inbox[&letter=…]` (a letter's "Open session"),
 * which opens the column AND its Inbox tab on that letter. Anything else in the
 * query is ignored, so a plain `/sessions?id=…` behaves exactly as before.
 */
export function navigateToTarget(to: string, navigate: (to: string) => void): void {
  const m = /^\/sessions\?(.+)$/.exec(to);
  const params = m ? new URLSearchParams(m[1]) : null;
  const id = params?.get('id');
  if (!id) { navigate(to); return; }
  const inbox = parseSessionInboxTarget(params!);
  openSessionOnHome(id, navigate, inbox
    ? { inboxTab: true, ...(inbox.letterId ? { inboxLetterId: inbox.letterId } : {}) }
    : undefined);
}
