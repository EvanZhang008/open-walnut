/**
 * Where the router sent an incoming message, as one secondary line: the same component on a mail row
 * and in the reader head, so the two surfaces always say the same thing about one message.
 *
 * The target's name is a `<button>`, never an `<a href>`: a link inside the row would hand the row's
 * right-click back to the browser (`keepNativeContextMenu`).
 */
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MailRouteDto, MailRoutingCoverage } from '@/api/mail';
import { apiGet } from '@/api/client';
import { fetchTask } from '@/api/tasks';
import { openTaskOnHome } from '@/utils/open-session';
import { mailRouteAction, mailRouteView, orgNodePath, outgoingRouteView, routerPathOf, type MailRouteAction, type MailRouteLink } from './mail-route-model';

const stop = (event: SyntheticEvent) => { event.stopPropagation(); };
// Only the keys that activate the button: every other key still reaches the app's own shortcuts.
const stopActivation = (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
};

export function MailRouteLine({ route, surface, subject, routingArea, routingCoverage, outgoing, unavailable = false }: {
  route: MailRouteDto | undefined;
  /** The person's own sent mail or draft, outside its own list: never routed, and the line says why. */
  outgoing?: 'sent' | 'draft' | null;
  unavailable?: boolean;
  surface: 'row' | 'reader';
  /** The reader's subject, named on the router's page when its "Open router" is followed. */
  subject?: string;
  /** The area whose router takes this message: the line names it on every surface. */
  routingArea?: { id: string; name: string; paused?: boolean };
  /** With no area: why no router has the message (the server's `routingCoverage`). */
  routingCoverage?: MailRoutingCoverage;
}) {
  const navigate = useNavigate();
  // Every row says where its message went or why it went nowhere (the user's ask), on one line.
  const view = outgoing ? outgoingRouteView(outgoing) : mailRouteView(route, unavailable, routingArea, routingCoverage);
  const Tag = surface === 'row' ? 'span' : 'p';
  const go = (link: MailRouteLink) => {
    if (link.kind === 'task') {
      // Its details open too: a routed task often has no session yet, and a bare highlight in the
      // task list reads as nothing happened.
      openTaskOnHome(link.id, navigate, { detail: true });
      return;
    }
    void fetchTask(link.id)
      .then((task) => navigate(orgNodePath(task)))
      .catch(() => navigate(orgNodePath(null)));
  };
  // The reader offers the one next step a stuck state has (the row keeps to its line).
  const action = surface === 'reader' && !unavailable && !outgoing ? mailRouteAction(view, route, routingArea) : null;
  const act = (next: MailRouteAction) => {
    // The router's page says which message brought the person there and what to do (OrgRouterFromMail).
    const state = [view.lead, view.name].filter(Boolean).join(' ') + (view.detail ? ` · ${view.detail}` : '');
    void apiGet<unknown>('/api/v1/router/areas')
      .then((body) => {
        const path = routerPathOf(body, next.areaId);
        const node = new URLSearchParams(path.split('?')[1] ?? '').get('node');
        navigate(path, node ? { state: { fromMail: { node, subject: subject ?? '', state } } } : undefined);
      })
      .catch(() => navigate('/org'));
  };
  const line = (
    <Tag
      className={`mail-route mail-route-${surface}`}
      data-testid={surface === 'row' ? 'mail-row-route' : 'mail-reader-route'}
      data-route-status={view.status}
      data-route-area={route?.areaId}
      {...(route?.target ? {
        'data-target-kind': route.target.kind,
        'data-target-id': route.target.id,
        'data-target-available': String(!!view.link),
      } : {})}
      title={view.title}
    >
      <span className="mail-route-mark" data-route-status={view.status} aria-hidden="true" />
      <span className="mail-route-lead">{view.lead}</span>
      {view.name && ' '}
      {view.name && (view.link ? (
        <button
          type="button"
          className="mail-route-link"
          data-testid={`${surface === 'row' ? 'mail-row' : 'mail-reader'}-route-link`}
          title={view.title}
          aria-label={view.link.kind === 'vp' ? `Open ${view.name} in Org` : `Open task ${view.name}`}
          onPointerDown={stop}
          onMouseDown={stop}
          onKeyDown={stopActivation}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            go(view.link!);
          }}
        >
          {view.name}
        </button>
      ) : (
        <span className="mail-route-name" data-testid={`${surface === 'row' ? 'mail-row' : 'mail-reader'}-route-name`}>
          {view.name}
        </span>
      ))}
      {view.detail && (
        <>
          {' '}
          <span className="mail-route-sep" aria-hidden="true">·</span>
          {' '}
          <span className="mail-route-detail">{view.detail}</span>
        </>
      )}
    </Tag>
  );
  // Beside the line, never inside it: the row and the reader line keep the same words.
  const next = action ? (
    <button
      type="button"
      className="mail-router-link"
      data-testid="mail-reader-route-action"
      data-action={action.kind}
      onKeyDown={stopActivation}
      onClick={(event) => { event.stopPropagation(); act(action); }}
    >
      {action.label}
    </button>
  ) : null;
  // One foot under the line, so the step reads as part of it.
  return next ? <>{line}<div className="mail-route-foot" data-testid="mail-reader-route-foot">{next}</div></> : line;
}
