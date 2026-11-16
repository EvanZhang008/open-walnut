/**
 * A router's state on its Org page, above its chat (2026-11-11, the person, on a router page that
 * showed only "No conversation history found": "why it is empty that is weird it is not working or
 * what"). A router's chat stays empty until mail the person assigned to its area reaches it, so the
 * page says what it does, whether it runs, what it routed and what feeds it, from
 * GET /api/v1/router/nodes/:id/summary (counts and the newest route's target; never an item's words).
 *
 *   What     one line: it reads the mail assigned to its area and hands each one on; it does no work itself
 *   State    Paused / Running, checking every 5 minutes (last check 2 min ago) / Not running yet
 *   Routed   N so far: how many went to a task, needed nothing, failed; the newest, when and to which task
 *   Missed   the hourly check: per account, what its source saw in the last day against what the router had
 *   Next     with nothing assigned: how mail reaches it, with Open Mail
 *
 * Read on mount, when Paused changes, every minute and when the window comes back; a failed read keeps the last one and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '@/api/client';
import { timeAgo } from '@/utils/time';

export interface RouterSummary {
  areaId: string;
  areaName: string;
  paused: boolean;
  /** Not paused, yet its wake hands it nothing, with why ("The org is off."). */
  blocked?: string;
  sources: number;
  assigned: number;
  /** null: could not be read. */
  waiting: number | null;
  /** `letters` (an older server sends none): of the not_routed ones, those sent to the person as a letter. */
  counts: { routed: number; not_routed: number; routing: number; failed: number; unknown: number; letters?: number };
  latest?: { at: number; status: string; taskId?: string; taskTitle?: string; letter?: boolean };
  wake: { armed: boolean; everyMs?: number; lastCheckAt?: number; nextAt?: number };
  session: { started: boolean; state?: string };
  /** The last missed-message check: per account, what its source saw against what reached the router. */
  reconcile?: { at: number; sinceMs: number; accounts: RouterReconcileAccount[] };
}

export interface RouterReconcileAccount {
  kind: string;
  account: string;
  saw: number;
  filtered: number;
  had: number;
  missed: number;
  entered: number;
  error?: string;
}

const REFRESH_MS = 60_000;

/** What a router is, in its own words (the page's first line). */
export function routerWhatLine(title: string, area: string): string {
  return `${title} reads the mail and messages that reach ${area} and hands each one to the task or VP that should own it. It does none of the work itself.`;
}

function everyWords(ms: number | undefined): string {
  if (!ms || ms <= 0) return '';
  const min = Math.round(ms / 60_000);
  return min <= 1 ? 'every minute' : `every ${min} minutes`;
}

/** Whether it runs and when it last looked for mail. */
export function routerStateLine(s: RouterSummary, now = Date.now()): string {
  if (s.paused) return 'Paused: it reads nothing until you turn Paused off in Router settings.';
  if (s.blocked) return `Not reading now: ${s.blocked}`;
  const checked = s.wake.lastCheckAt ? ` (last check ${timeAgo(new Date(s.wake.lastCheckAt).toISOString(), { now })})` : '';
  const every = everyWords(s.wake.everyMs);
  if (!s.wake.armed) return 'Ready, but its check for new messages is off: nothing will hand it any. Turn Paused on and off again in Router settings.';
  const look = `It checks for new ${s.areaName} messages${every ? ` ${every}` : ''}${checked}.`;
  return s.session.started ? `Running. ${look}` : `Not running yet: it starts when a message for ${s.areaName} arrives. ${look}`;
}

/** What it routed so far (mail and chat messages alike); "No messages so far" says plainly it has had nothing to do. */
export function routerRoutedLine(s: RouterSummary, now = Date.now()): string {
  const c = s.counts;
  const total = c.routed + c.not_routed + c.routing + c.failed + c.unknown;
  const letters = Math.min(c.not_routed, Math.max(0, c.letters ?? 0));
  if (total === 0) return 'No messages so far.';
  const parts = [
    c.routed ? `${c.routed} handed to a task` : '',
    letters ? `${letters} sent to you as a letter` : '',
    c.not_routed - letters ? `${c.not_routed - letters} needed nothing` : '',
    c.routing ? `${c.routing} being handed on` : '',
    c.failed ? `${c.failed} failed` : '',
    c.unknown ? `${c.unknown} not confirmed delivered` : '',
  ].filter(Boolean);
  const head = `${total} ${total === 1 ? 'message' : 'messages'}: ${parts.join(', ')}.`;
  const latest = s.latest;
  if (!latest) return head;
  const when = timeAgo(new Date(latest.at).toISOString(), { now });
  const where = latest.taskTitle ? ` to ${latest.taskTitle}` : latest.letter ? ', sent to you as a letter' : latest.status === 'not_routed' ? ', needed nothing' : '';
  return `${head} Last one ${when}${where}.`;
}

/** The next step when it has nothing to read, else '' (it already has mail). */
export function routerNextLine(s: RouterSummary): string {
  if (s.paused || s.blocked || s.assigned > 0) return '';
  return `Nothing is assigned to ${s.areaName} yet, so it has nothing to route. To give it mail, open an email in Mail and choose ${s.areaName} on its route line.`;
}

const KIND_NAMES: Record<string, string> = { mail: 'Mail', slack: 'Slack', wechat: 'WeChat' };

/**
 * The last missed-message check, one sentence per account: what the source saw in the last day
 * against what reached the router. '' when no account was checked.
 */
export function routerCheckedLines(s: RouterSummary, now = Date.now()): string[] {
  const r = s.reconcile;
  if (!r?.accounts.length) return [];
  const when = timeAgo(new Date(r.at).toISOString(), { now });
  const perKind = new Map<string, number>();
  for (const one of r.accounts) perKind.set(one.kind, (perKind.get(one.kind) ?? 0) + 1);
  return r.accounts.map((one) => {
    const name = `${KIND_NAMES[one.kind] ?? one.kind}${(perKind.get(one.kind) ?? 0) > 1 ? ` (${one.account})` : ''}`;
    if (one.error) return `${name}: could not count what it saw (${one.error}), checked ${when}.`;
    const left = one.filtered ? ` ${one.filtered} more left out by its filter.` : '';
    if (one.missed === 0) {
      return `${name} saw ${one.saw} in the last day and the router had ${one.saw === 1 ? 'it' : `all ${one.saw}`}, checked ${when}.${left}`;
    }
    const late = one.entered === one.missed ? `all ${one.missed} entered now` : `${one.entered} of them entered now`;
    return `${name} saw ${one.saw} in the last day; the router had ${one.had}, so ${one.missed} missed, ${late}, checked ${when}.${left}`;
  });
}

/** What its empty chat says instead of "No conversation history found" (also after a new session, so no claim about past mail). */
export function routerEmptyChatLine(area: string): string {
  return `Nothing in this conversation yet. It starts when the next message for ${area} reaches the router.`;
}

/** `paused` is the task's own flag: a save of Router settings reads the state again at once. */
export function OrgRouterOverview({ routerId, title, links, paused }: { routerId: string; title: string; links: readonly string[]; paused: boolean }) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<{ id: string; value: RouterSummary } | null>(null);
  const [failed, setFailed] = useState(false);
  // A replica answers 501: it keeps no router data, so the page shows no overview there.
  const [unsupported, setUnsupported] = useState(false);
  // Only the newest read paints: one sent before a Paused save may answer after it.
  const seq = useRef(0);
  const read = useCallback(() => {
    const mine = ++seq.current;
    void apiGet<RouterSummary>(`/api/v1/router/nodes/${encodeURIComponent(routerId)}/summary`)
      .then((value) => { if (mine === seq.current) { setSummary({ id: routerId, value }); setFailed(false); } })
      .catch((error: unknown) => {
        if (mine !== seq.current) return;
        if ((error as { status?: number } | null)?.status === 501) setUnsupported(true);
        else setFailed(true);
      });
  }, [routerId]);
  useEffect(() => { read(); }, [read, paused]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') read(); }, REFRESH_MS);
    const onFocus = () => read();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [read]);
  // A read sent for another router never paints this one.
  const s = summary?.id === routerId ? summary.value : null;
  if (unsupported) return null;
  if (!s) {
    return (
      <section className="org-router-overview" data-testid="org-router-overview" data-loading="true">
        <p className="org-router-hint">{failed ? 'Could not read this router\'s state. It retries every minute.' : 'Reading its state…'}</p>
      </section>
    );
  }
  const next = routerNextLine(s);
  const checkedLines = routerCheckedLines(s);
  return (
    <section className="org-router-overview" data-testid="org-router-overview" aria-label={`${title}: state`}>
      <p className="org-router-overview-what" data-testid="org-router-overview-what">{routerWhatLine(title, s.areaName)}</p>
      <dl className="org-router-overview-facts">
        <div><dt>State</dt><dd data-testid="org-router-overview-state">{routerStateLine(s)}</dd></div>
        <div><dt>Routed</dt><dd data-testid="org-router-overview-routed">
          {routerRoutedLine(s)}
          {s.waiting === null ? <> Could not count the messages waiting for its next check.</> : s.waiting > 0 && <> {s.waiting} waiting for its next check.</>}
        </dd></div>
        {checkedLines.length > 0 && <div><dt>Missed</dt><dd data-testid="org-router-overview-checked">
          {checkedLines.map((line) => <span key={line} className="org-router-overview-checked-line">{line} </span>)}
        </dd></div>}
        {links.length > 0 && <div><dt>Works with</dt><dd data-testid="org-router-overview-links">{links.join(', ')}</dd></div>}
      </dl>
      {next && (
        <p className="org-router-overview-next" data-testid="org-router-overview-next">
          {next}{' '}
          <button type="button" className="btn btn-sm" data-testid="org-router-overview-open-mail" onClick={() => navigate('/mail')}>Open Mail</button>
        </p>
      )}
      {failed && <p className="org-router-hint" data-testid="org-router-overview-stale">Could not read its latest state; this is from the last read.</p>}
    </section>
  );
}

/** What a task that routes by itself is (Task.self_router), in one line: Walnut only lists it. */
export function selfRouterLine(title: string, project: string, links: readonly string[]): string {
  const works = links.length ? ` It works with ${links.join(', ')}.` : '';
  return `${title} routes by itself: its own triggers and loops do the work${project ? ` for ${project}` : ''}, and Walnut only lists it among the routers.${works}`;
}
