/**
 * What is broken right now, at the top of the notification panel's All and
 * Errors views: this machine's Claude Code (install / sign in) and every remote
 * host with a problem row. They are errors, not ambient status, so the
 * user sees them the moment the panel opens (it lands on All) without picking a
 * section first.
 *
 * A problem host is one SingleHostRow (dense, with an x that dismisses it): the
 * headline, the primary button (Retry), Show details, and the shared expanded
 * flag and attempt store, so a Retry here, on its toast (HostProblemToasts) and
 * in Settings is ONE attempt. This is the one place a host problem is listed:
 * no card on the page carries it (host-attention.ts). The
 * feed errors that host caused (causeKey `host:<alias>`) sit right under its row
 * instead of in a second block that names the same host again.
 *
 * A row the user dismissed ("I know") and a
 * host found in ~/.ssh/config that nobody reached for are left out here too, and
 * so is a host switched off in Settings. Every host, dismissed or not, is still
 * in System's Remote hosts list, which is the inventory. Every host gets its own
 * row (no credential grouping) and there is no cap.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WarningTriangleIcon } from './PhoneIcons';
import { NoticeCard, type NoticeTone } from './NoticeCard';
import { agentCannotRun, localNoticeIsFailure, type LocalNoticeKind } from '@/utils/local-claude-banner';
import { useRowDisclosure } from '@/components/sessions/row-disclosure';
import { useNavigate } from 'react-router-dom';
import type { DaemonHealth, SystemHealth } from '@/hooks/useSystemHealth';
import { serverNow, useAllHostStatus } from '@/hooks/useHostStatus';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { fetchConfig } from '@/api/config';
import { hostRowFor, type BannerRow } from '@/utils/attention-banner-model';
import { dismissHostKeys, getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { useUserEngagedHosts, useUserRetryingHosts } from '@/utils/host-user-retrying';
import { openHostSettings } from '@/utils/host-settings-nav';
import { log } from '@/utils/log';
import { SingleHostRow } from './HostProblemRows';
import { hostProblemNeedsYou, type NeedsYou } from '@open-walnut/notice-audience';
import { useLocalClaudeNotice } from './SetupBanner';
import '@/styles/attention-banner.css';
import '@/styles/attention-banner-dense.css';

/** Hosts switched off in Settings (the health list carries no such flag), re-read on every open. */
export function useDisabledHosts(open: boolean): ReadonlySet<string> {
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchConfig()
      .then((c) => {
        const hosts = (c as { hosts?: Record<string, { enabled?: boolean }> }).hosts ?? {};
        if (live) setOff(new Set(Object.entries(hosts).filter(([, h]) => h?.enabled === false).map(([a]) => a)));
      })
      .catch((err) => log.warn('notifications', 'host config read failed', { error: String(err) }));
    return () => { live = false; };
  }, [open]);
  return off;
}

/** `needsYou` set: the person's to clear (the bell lists it); unset: Walnut Health's (audience.ts). */
export interface ProblemHost { alias: string; row: BannerRow; needsYou?: NeedsYou }

/**
 * The configured hosts (the health list) with a problem row right now, by the
 * problem-row model's rules (dismissed and unreached discovered
 * hosts left out, see nextBanner's collect). Each host keeps the row it had
 * through an attempt (hostRowFor's `prev`), so a Retry does not make it jump
 * out and back.
 */
export function useProblemHosts(daemons: DaemonHealth[] | undefined, disabled: ReadonlySet<string>): ProblemHost[] {
  const statuses = useAllHostStatus();
  const replica = useIsReplicaServer();
  const userRetrying = useUserRetryingHosts();
  const engaged = useUserEngagedHosts();
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed, getHostDismissed);
  const prev = useRef(new Map<string, BannerRow>());
  const byHost = new Map(statuses.map((s) => [s.host, s] as const));
  const out: ProblemHost[] = [];
  const next = new Map<string, BannerRow>();
  for (const d of daemons ?? []) {
    const status = byHost.get(d.host);
    if (!status || disabled.has(d.host) || (status.discovered && !engaged.has(d.host))) continue;
    const row = hostRowFor(status, { now: serverNow(), replica, userRetrying }, prev.current.get(d.host) ?? null);
    if (!row || (row.dismissKeys.length > 0 && row.dismissKeys.every((k) => dismissed.has(k)))) continue;
    const needsYou = hostProblemNeedsYou(row, engaged);
    out.push({ alias: d.host, row, ...(needsYou ? { needsYou } : {}) });
    next.set(d.host, row);
  }
  prev.current = next;
  // Connect failures first, then readiness, each in Settings order.
  const rank = (r: BannerRow): number => (r.group === 'connect' ? 0 : 1);
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.row) - rank(b.p.row) || a.i - b.i).map((x) => x.p);
}

export interface NotificationProblemsProps {
  hosts: ProblemHost[];
  health: SystemHealth;
  healthLoading: boolean;
  /** The feed cards a host caused, rendered under its row (null when it has none). */
  renderHostCards: (alias: string) => ReactNode;
  /** Called before any navigation away (Open Settings): the panel closes. */
  onLeave: () => void;
  onNavigate: (to: string) => void;
}

/** The word beside the dot on the Claude Code card. */
const LOCAL_STATUS: Record<string, string> = {
  install: 'Not installed', 'sign-in': 'Not signed in', outdated: 'Update needed', provider: 'Not answering',
};

/**
 * This machine's Claude Code (or AI provider) as one notice card: severity by its dot and a short
 * title, the x at its top right (2026-11-21 audit: a light yellow block with an orange border, its
 * own icon and spacing, the x at the bottom). It is the first screen's big block only while no
 * agent can run here at all (agentCannotRun); otherwise it is its head, opened by a click.
 */
function LocalClaudeCard({ local, health }: { local: ReturnType<typeof useLocalClaudeNotice>; health: SystemHealth }) {
  const blocking = agentCannotRun(health);
  const [open, setOpen] = useRowDisclosure('nfc-local-claude-open', false);
  const expanded = blocking || open;
  const kind = local.kind ?? 'install';
  const failing = kind === 'install' || kind === 'sign-in' || kind === 'provider' ? localNoticeIsFailure(health, kind as LocalNoticeKind) : false;
  const tone: NoticeTone = failing ? 'error' : 'warn';
  const who = kind === 'provider' ? 'AI provider' : 'Claude Code';
  return (
    <NoticeCard
      solid
      className="nfc-local-claude"
      testId="nfc-local-claude"
      data={{ kind: local.kind ?? '', compact: expanded ? undefined : 'true' }}
      avatar={{ glyph: <WarningTriangleIcon size={13} />, tone }}
      who={who}
      status={{ tone, text: LOCAL_STATUS[kind] ?? 'Needs setup' }}
      line={expanded ? undefined : local.summary}
      {...(blocking ? {} : { onOpen: () => setOpen(!open), expanded, openTitle: expanded ? 'Show less' : 'Show how to set it up' })}
      end={local.dismiss}
      bodyFlush
    >
      {expanded ? local.node : undefined}
    </NoticeCard>
  );
}

/** A row's x: "I know". The host leaves this list until its problem changes; System's Remote hosts list still shows it. */
function dismissRow(row: BannerRow): void {
  dismissHostKeys(row.dismissKeys);
}

export function NotificationProblems({ hosts, health, healthLoading, renderHostCards, onLeave, onNavigate }: NotificationProblemsProps): ReactNode {
  const navigate = useNavigate();
  // Open Settings lands on the host's own Settings row.
  const onOpenSettings = useCallback((alias?: string) => {
    onLeave();
    openHostSettings(navigate, alias);
  }, [navigate, onLeave]);
  const onNavigateSettings = useCallback((hash?: string) => {
    onLeave();
    navigate(`/settings${hash ?? ''}`);
  }, [navigate, onLeave]);
  const local = useLocalClaudeNotice({ health, loading: healthLoading, onNavigateSettings, onRepairNavigate: onNavigate });
  if (!local.present && hosts.length === 0) return null;
  return (
    <div className="nfc-problems" data-testid="nfc-problems">
      {local.present && <LocalClaudeCard local={local} health={health} />}
      {hosts.length > 0 && (
        <NoticeCard
          solid
          className="nfc-problem-hosts"
          testId="nfc-problem-hosts"
          avatar={{ glyph: <WarningTriangleIcon size={13} />, tone: 'warn' }}
          who="Remote hosts"
          status={{ tone: 'warn', text: hosts.length === 1 ? '1 needs you' : `${hosts.length} need you` }}
          bodyFlush
        >
          <ul className="notification-card-details nfc-host-list">
            {hosts.map(({ alias, row }) => {
              const cards = renderHostCards(alias);
              return [
                <SingleHostRow key={alias} row={row} defaultExpanded={false} dense statusList onDismiss={dismissRow} onOpenSettings={onOpenSettings} onNavigate={onNavigate} />,
                cards ? <li key={`${alias}:cards`} className="nfc-problem-cards" data-host-cards={alias}>{cards}</li> : null,
              ];
            })}
          </ul>
        </NoticeCard>
      )}
    </div>
  );
}
