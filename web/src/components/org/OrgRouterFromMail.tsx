/**
 * The line a router's page shows when Mail's "Open router" brought the person here: which message,
 * the state it is stuck in, and the one thing to do next on this page. It lives in the navigation's
 * own state, so it is gone after a reload or once another node is opened.
 */
import { useLocation } from 'react-router-dom';
import { ROUTER_SETTINGS_OPEN_EVENT } from './OrgRouterSettings';
import { useRouterSettingsOpen } from './router-settings-open';

/** What Mail hands over with its "Open router" (navigate state `fromMail`). */
export interface RouterFromMail {
  /** The router's Org node key the note belongs to (`router:<taskId>`). */
  node: string;
  subject: string;
  /** The message's route line as Mail shows it ("Handoff not approved · Nothing was delivered"). */
  state: string;
}

export function routerFromMailOf(state: unknown, node: string): RouterFromMail | null {
  const one = (state as { fromMail?: Partial<RouterFromMail> } | null)?.fromMail;
  if (!one || one.node !== node || typeof one.subject !== 'string' || typeof one.state !== 'string') return null;
  return { node, subject: one.subject.trim() || '(no subject)', state: one.state.trim() };
}

/** The next step this page offers: Paused off when the router reads nothing, else its chat. */
export function routerFromMailNext(title: string, paused: boolean): string {
  return paused
    ? `${title} is paused, so it reads nothing until you turn Paused off in its settings.`
    : `Ask ${title} about it in the chat below.`;
}

export function OrgRouterFromMail({ node, routerId, title, paused }: { node: string; routerId: string; title: string; paused: boolean }) {
  const location = useLocation();
  const from = routerFromMailOf(location.state, node);
  const settingsOpen = useRouterSettingsOpen(routerId);
  if (!from) return null;
  return (
    <div className="org-router-from-mail" data-testid="org-router-from-mail" role="note">
      <p>
        <span className="org-router-from-mail-label">From Mail:</span>{' '}
        <span data-testid="org-router-from-mail-subject">“{from.subject}”</span>
        {from.state && <> · <span className="org-router-from-mail-state">{from.state}</span></>}
      </p>
      <p className="org-router-hint" data-testid="org-router-from-mail-next">
        {routerFromMailNext(title, paused)}
        {paused && !settingsOpen && <>{' '}<button
          type="button"
          className="btn btn-sm"
          data-testid="org-router-from-mail-settings"
          onClick={() => window.dispatchEvent(new CustomEvent(ROUTER_SETTINGS_OPEN_EVENT, { detail: routerId }))}
        >Open settings</button></>}
      </p>
    </div>
  );
}
