/**
 * The one line a mail row and the reader both show about where the router sent an incoming message.
 *
 * Pure, so the row and the reader can never word the same route two ways. Every state reads as what
 * Walnut actually knows: an ambiguous answer is never worded as delivered, and a target that is gone
 * keeps its name with no link.
 */
import type { MailboxDto, MailboxRole, MailMessageDto, MailRouteDto, MailRouteStatus, MailRoutingCoverage } from '@/api/mail';
import { ORG_MAIN_NODE, orgProjectNode } from '@open-walnut/org-tree';
import { formatMailDate } from './mail-format';

export interface MailRouteLink { kind: 'task' | 'vp'; id: string }

/** The Org page with its router setup open. */
export const ORG_ROUTER_SETUP_PATH = '/org?router_setup=1';

export interface MailRouteView {
  status: MailRouteStatus | 'none' | 'queued';
  /** The words before the target's name (or the whole state when there is no name). */
  lead: string;
  /** The target's name, when the route names one. */
  name?: string;
  /** Present only when the target exists now, so a gone target is never a working link. */
  link: MailRouteLink | null;
  /** The words after ` · `: the reason, or why there is no link. */
  detail: string;
  /** The whole line as one string. */
  text: string;
  /** The line plus when the router decided, for the tooltip and the accessible label. */
  title: string;
}

const KNOWN: readonly MailRouteStatus[] = ['routing', 'routed', 'not_routed', 'failed', 'unknown'];

/** Why no router has a message (the server's `routingCoverage`), worded as the line's reason. */
export const COVERAGE_REASON: Record<MailRoutingCoverage, string> = {
  no_router: 'No router reads this account',
  unassigned: 'No area chosen for this message',
};

/**
 * `area`: the area whose router takes this message. With no receipt yet the line says that, so the
 * row and the reader head never disagree about one message.
 * `coverage`: with no area and no receipt, why: no router reads its account, or one does but this
 * message has no area (an older server sends none, and the line says only that no router saw it).
 */
export function mailRouteView(
  route: MailRouteDto | null | undefined,
  unavailable = false,
  area?: { name?: string; paused?: boolean } | null,
  coverage?: MailRoutingCoverage | null,
): MailRouteView {
  if (unavailable) return build('unknown', 'Routing record unavailable', undefined, null, 'Check again before routing');
  // Never "routed": the area's router has not decided anything for it yet.
  if (!route && area) {
    return build('queued', 'Queued for', clean(area.name) || 'its area', null, area.paused ? 'Its router is paused' : 'Routing pending');
  }
  // No router record: never says "not reviewed" (older monitoring may have handled it), only that
  // no router routed it and why.
  if (!route) {
    const reason = coverage && Object.hasOwn(COVERAGE_REASON, coverage) ? COVERAGE_REASON[coverage] : '';
    return build('none', reason ? 'Not routed' : 'No router has seen this', undefined, null, reason);
  }
  const status: MailRouteStatus = KNOWN.includes(route.status) ? route.status : 'unknown';
  const reason = clean(route.reason);
  const at = route.at;
  if (status === 'routing') return build(status, 'Delivery not confirmed', undefined, null, 'Do not resend before checking', at);
  if (status === 'not_routed') return build(status, 'Not routed', undefined, null, reason || 'No reason given', at);
  if (status === 'failed') {
    const error = clean(route.error);
    const extra = error && reason && reason !== error ? reason : '';
    return build(status, 'Routing failed', undefined, null, error || reason || 'No error given', at, extra);
  }
  if (status === 'unknown') {
    return build(status, 'Routing state unknown', undefined, null, reason || 'Delivery not confirmed', at);
  }
  const target = route.target;
  // A receipt recorded after the fact never claims the router delivered it.
  const lead = route.origin === 'legacy' ? 'Previously handled by' : 'Routed to';
  const evidence = route.origin === 'legacy' ? clean(route.evidence) : '';
  const withEvidence = (extra: string) => [extra, evidence].filter(Boolean).join(' · ');
  if (target) {
    const kindWord = target.kind === 'vp' ? 'VP' : 'Task';
    const name = clean(target.title) || (target.kind === 'vp' ? 'a VP' : 'a task');
    if (target.available && clean(target.id)) {
      return build(status, lead, name, { kind: target.kind, id: target.id }, reason, at, evidence);
    }
    return build(status, lead, name, null, `${kindWord} no longer exists`, at, withEvidence(reason));
  }
  if (clean(route.taskId)) return build(status, lead, 'a task', null, 'Task not found', at, withEvidence(reason));
  return build('unknown', 'Routing state unknown', undefined, null, 'No target recorded', at, reason);
}

/**
 * The one next step the reader offers for a state that is not done: a delivery that is unconfirmed,
 * failed or unknown, and an area whose router is paused, open that area's router. Everything else
 * (routed, not routed, no record) offers nothing here.
 */
export interface MailRouteAction { kind: 'router'; areaId: string; label: string }

export function mailRouteAction(
  view: Pick<MailRouteView, 'status'>,
  route: Pick<MailRouteDto, 'areaId'> | null | undefined,
  area: { id?: string; paused?: boolean } | null | undefined,
): MailRouteAction | null {
  const router = (areaId: string | undefined): MailRouteAction | null => (clean(areaId) ? { kind: 'router', areaId: clean(areaId), label: 'Open router' } : null);
  if (view.status === 'routing' || view.status === 'failed' || view.status === 'unknown') return router(route?.areaId ?? area?.id);
  if (view.status === 'queued' && area?.paused) return router(area.id);
  return null;
}

/** The Org path of an area's router (its reading one first), read from the areas list; the Org page when none is named. */
export function routerPathOf(body: unknown, areaId: string): string {
  const list = (body as { routers?: unknown } | null)?.routers;
  const mine = (Array.isArray(list) ? list : []).filter((r) => {
    const one = r as { areaId?: unknown; taskId?: unknown };
    return one?.areaId === areaId && typeof one.taskId === 'string' && !!one.taskId;
  }) as Array<{ taskId: string; paused?: unknown }>;
  const pick = mine.find((r) => r.paused === false) ?? mine[0];
  return pick ? `/org?node=${encodeURIComponent(`router:${pick.taskId}`)}` : '/org';
}

function build(
  status: MailRouteView['status'],
  lead: string,
  name: string | undefined,
  link: MailRouteLink | null,
  detail: string,
  at?: number,
  extra = '',
): MailRouteView {
  const head = name ? `${lead} ${name}` : lead;
  const text = detail ? `${head} · ${detail}` : head;
  const when = typeof at === 'number' ? formatMailDate(at) : '';
  const title = [text, extra].filter(Boolean).join(' · ') + (when ? ` (${when})` : '');
  return { status, lead, ...(name ? { name } : {}), link, detail, text, title };
}

function clean(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a message gets the router line at all: incoming mail only. Sent and drafts lists, a message
 * filed in a sent or drafts mailbox, and a draft by its own flag are the person's own mail, which the
 * router never reviews.
 */
export function showsRouteLine(
  message: Pick<MailMessageDto, 'flags'>,
  opts: { outbound?: boolean; role?: MailboxRole } = {},
): boolean {
  if (opts.outbound) return false;
  if (opts.role === 'sent' || opts.role === 'drafts') return false;
  return !message.flags.some((flag) => flag.toLowerCase() === '\\draft');
}

/**
 * The person's own mail outside its own list (a search hit, a merged list, the reader): it still says
 * it was not routed and why, because every row the person reads answers that. A sent or drafts list
 * (`outbound`) says it once by being that list, so its rows carry no line.
 */
export function outgoingKind(
  message: Pick<MailMessageDto, 'flags'>,
  opts: { outbound?: boolean; role?: MailboxRole } = {},
): 'sent' | 'draft' | null {
  if (opts.outbound || showsRouteLine(message, opts)) return null;
  const draft = opts.role === 'drafts' || message.flags.some((flag) => flag.toLowerCase() === '\\draft');
  return draft ? 'draft' : 'sent';
}

export function outgoingRouteView(kind: 'sent' | 'draft'): MailRouteView {
  return build('none', 'Not routed', undefined, null, kind === 'draft'
    ? 'A draft. Routers read only mail you receive'
    : 'You sent this. Routers read only mail you receive');
}

export function mailboxRoleOf(
  mailboxes: Record<string, MailboxDto[]>,
  message: Pick<MailMessageDto, 'accountId' | 'mailboxId'>,
): MailboxRole | undefined {
  return mailboxes[message.accountId]?.find((one) => one.mailboxId === message.mailboxId)?.role;
}

/** The Org page's `node` value for a VP or Main task, the same key its rows are selected by. */
export function orgNodeKeyFor(task: { org_role?: string; project?: string }): string {
  return task.org_role === 'main' ? ORG_MAIN_NODE : orgProjectNode(task.project);
}

export function orgNodePath(task: { org_role?: string; project?: string } | null): string {
  return task ? `/org?node=${encodeURIComponent(orgNodeKeyFor(task))}` : '/org';
}
