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

export interface ProblemHost { alias: string; row: BannerRow }

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
    out.push({ alias: d.host, row });
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
      {local.present && (
        <div className="notification-card warn nfc-local-claude" data-testid="nfc-local-claude" data-kind={local.kind ?? ''}>
          <div className="notification-card-row">
            <span className="notification-card-icon warn"><WarningTriangleIcon size={14} /></span>
            <span className="notification-card-label">Claude Code</span>
          </div>
          {local.node}
        </div>
      )}
      {hosts.length > 0 && (
        <div className="notification-card warn" data-testid="nfc-problem-hosts">
          <div className="notification-card-row">
            <span className="notification-card-icon warn"><WarningTriangleIcon size={14} /></span>
            <span className="notification-card-label">Remote hosts</span>
          </div>
          <ul className="notification-card-details nfc-host-list">
            {hosts.map(({ alias, row }) => {
              const cards = renderHostCards(alias);
              return [
                <SingleHostRow key={alias} row={row} defaultExpanded={false} dense statusList onDismiss={dismissRow} onOpenSettings={onOpenSettings} onNavigate={onNavigate} />,
                cards ? <li key={`${alias}:cards`} className="nfc-problem-cards" data-host-cards={alias}>{cards}</li> : null,
              ];
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
