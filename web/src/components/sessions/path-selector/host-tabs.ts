/**
 * The folder picker's host tabs (spec 4.1), as a pure model plus one hook.
 *
 * Tabs = All, Local, one per ENABLED configured host, then a trailing muted
 * "Removed hosts" tab that holds the history of hosts no longer in Settings
 * (removed or disabled), only when such history exists. A host that leaves
 * the config (a tombstone push) loses its tab live: `gone` names hosts the
 * status store dropped while the picker was open.
 *
 * Every remote tab wears ONE dot and ONE title from hostDotOf, so the tab, its
 * dot and the rows under it say the same thing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { hostDotOf, hostProblemOf, READINESS_ANSWER_GRACE_MS, type HostDot } from '@open-walnut/host-problem';
import type { HostStatus } from '@/api/hosts';
import type { ConfiguredHost, WorkingDirEntry } from '@/api/sessions';
import { serverNow, useAllHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';

export const ALL_TAB = 'all';
export const LOCAL_TAB = '__local__';
export const REMOVED_TAB = '__removed__';
export const REMOVED_TAB_LABEL = 'Removed hosts';

export interface HostTab {
  key: string;
  label: string;
  kind: 'all' | 'local' | 'host' | 'removed';
  /** Auto-discovered FQDN-only entry: the "give it a name" nudge. */
  rawName?: boolean;
}

export interface HostTabsModel {
  tabs: HostTab[];
  /** Hosts whose history lives under the Removed hosts tab. */
  removedHosts: ReadonlySet<string>;
  /** The configured hosts still live (the All tab fans out to these). */
  liveHosts: ConfiguredHost[];
}

export function buildHostTabs(input: {
  configured: readonly ConfiguredHost[];
  dirs: readonly WorkingDirEntry[];
  /** Hosts the status store dropped (tombstoned) while the picker was open. */
  gone?: ReadonlySet<string>;
}): HostTabsModel {
  const gone = input.gone ?? new Set<string>();
  const liveHosts = input.configured.filter((h) => !gone.has(h.alias));
  const live = new Set(liveHosts.map((h) => h.alias));
  const tabs: HostTab[] = [
    { key: ALL_TAB, label: 'All', kind: 'all' },
    { key: LOCAL_TAB, label: 'Local', kind: 'local' },
  ];
  for (const h of liveHosts) {
    if (tabs.some((t) => t.key === h.alias)) continue;
    tabs.push({ key: h.alias, label: h.label || h.alias, kind: 'host', ...(h.rawName ? { rawName: true } : {}) });
  }
  const removedHosts = new Set<string>();
  for (const d of input.dirs) if (d.host && !live.has(d.host)) removedHosts.add(d.host);
  if (removedHosts.size > 0) tabs.push({ key: REMOVED_TAB, label: REMOVED_TAB_LABEL, kind: 'removed' });
  return { tabs, removedHosts, liveHosts };
}

/** The history rows a tab shows. Removed hosts' rows live only under their own tab. */
export function historyForTab(
  dirs: readonly WorkingDirEntry[], tab: string, removedHosts: ReadonlySet<string>,
): WorkingDirEntry[] {
  return dirs.filter((d) => {
    if (tab === REMOVED_TAB) return !!d.host && removedHosts.has(d.host);
    if (d.host && removedHosts.has(d.host)) return false;
    if (tab === ALL_TAB) return true;
    if (tab === LOCAL_TAB) return !d.host;
    return d.host === tab;
  });
}

/** A tab with no single host behind it: All, and Removed hosts (the row names its host). */
export function tabInfersHost(tab: string): boolean {
  return tab === ALL_TAB || tab === REMOVED_TAB;
}

/** The remote host a tab stands for, or null (All, Local, Removed hosts). */
export function hostOfTab(tab: string): string | null {
  return tab === ALL_TAB || tab === LOCAL_TAB || tab === REMOVED_TAB ? null : tab;
}

/** The tab button's one title: the dot's sentence, e.g. 'Build box: Claude Code on Build box is 2.1.220...'. */
export function tabTitle(tab: HostTab, dot: HostDot | undefined): string | undefined {
  if (tab.kind === 'removed') return 'Hosts no longer in Settings';
  return tab.kind === 'host' ? dot?.title : undefined;
}

export interface PickerHostView {
  /** alias -> the dot its tab (and its rows) wear. */
  dots: ReadonlyMap<string, HostDot>;
  /** Hosts with a HostProblem right now (only these rows carry a dot in All). */
  problemHosts: ReadonlySet<string>;
  /** Hosts the store dropped while this picker was open (tombstones). */
  gone: ReadonlySet<string>;
  /** Hosts whose phase is 'off' (a test server): never listed live. */
  offHosts: ReadonlySet<string>;
  statusOf: (alias: string) => HostStatus | undefined;
}

/** Hosts the store once reported and no longer does: removed or disabled. */
export function goneHosts(seen: ReadonlySet<string>, now: readonly HostStatus[]): Set<string> {
  const present = new Set(now.map((s) => s.host));
  const out = new Set<string>();
  for (const h of seen) if (!present.has(h)) out.add(h);
  return out;
}

/**
 * The live per-host view the picker's tabs and rows read. `open` scopes the
 * "seen" memory to one open: a host re-added in Settings gets its tab back on
 * the next open.
 */
export function usePickerHostView(open: boolean, labels: ReadonlyMap<string, string>): PickerHostView {
  const all = useAllHostStatus();
  const hydration = useHostStatusHydration();
  const seenRef = useRef<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  if (!open) seenRef.current = new Set();
  const trusted = hydration === 'done' || all.length > 0;
  const gone = useMemo(() => {
    const g = trusted ? goneHosts(seenRef.current, all) : new Set<string>();
    for (const s of all) seenRef.current.add(s.host);
    return g;
  }, [all, trusted]);
  const hydrating = hydration === 'never' || hydration === 'pending';
  const now = serverNow();
  const view = useMemo(() => {
    const byHost = new Map(all.map((s) => [s.host, s] as const));
    const dots = new Map<string, HostDot>();
    const problemHosts = new Set<string>();
    const offHosts = new Set<string>();
    for (const [alias, label] of labels) {
      const s = byHost.get(alias);
      dots.set(alias, hostDotOf(s, { hydrating, now, label }));
      const p = hostProblemOf(s);
      if (p) problemHosts.add(alias);
      if (p?.type === 'off') offHosts.add(alias);
    }
    return { dots, problemHosts, offHosts, statusOf: (a: string) => byHost.get(a) };
    // `now` only matters for the checking window; `tick` recomputes at its end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, labels, hydrating, tick]);
  // A 'checking' dot ends by the clock (no readiness answer within the grace).
  const checkingEnd = Math.min(...all
    .filter((s) => s.connected && typeof s.connectedAt === 'number' && view.dots.get(s.host)?.kind === 'checking')
    .map((s) => (s.connectedAt as number) + READINESS_ANSWER_GRACE_MS));
  useEffect(() => {
    if (!Number.isFinite(checkingEnd)) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, checkingEnd - serverNow()) + 50);
    return () => clearTimeout(t);
  }, [checkingEnd]);
  return { ...view, gone };
}
