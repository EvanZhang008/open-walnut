/**
 * Settings > Remote Hosts: the words of the one list of machines (RemoteHostsSection.tsx and
 * HostRow.tsx), pure so each rule has a unit test (tests/web/host-row-model.test.ts): the
 * summary line, a live host's state line, the one action a row offers, and the new SSH host's
 * placeholder.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { isLive, problemsOf, type FleetSummary } from './host-fleet-dashboard-model';
import { pct, usd } from './host-fleet-model';
import type { HostEntry } from './remote-hosts-model';

/** The words of the summary line under the header, in order; a part not known yet is left out. */
export interface SummaryWords { online: string; sessions: string | null; spend: string | null; needs: string | null }

export function summaryWords(s: FleetSummary): SummaryWords {
  return {
    online: `${s.online} of ${s.total} online`,
    sessions: s.sessions === null ? null : `${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'} open`,
    spend: s.spendUsd === null ? null : `${usd(s.spendUsd)} in 30 days`,
    needs: s.problems ? `${s.problems} ${s.problems === 1 ? 'needs' : 'need'} a look` : null,
  };
}

/** A host the summary counts as needing a look: not connected, or a problem on its reading. */
export function needsLook(h: FleetHost, now: number): boolean {
  return !isLive(h) || problemsOf(h, now).some((p) => p.tone === 'warn' || p.tone === 'bad');
}

/** A live host's state line: "Online, 12% CPU, 2 sessions" (what is not known is left out). */
export function liveLine(card: FleetHost | undefined, online = 'Online'): string {
  if (!card) return online;
  const parts = [online];
  const cpu = card.now?.cpuUtil;
  if (typeof cpu === 'number') parts.push(`${pct(cpu)} CPU`);
  const n = card.sessions.running;
  if (typeof n === 'number') parts.push(`${n} ${n === 1 ? 'session' : 'sessions'}`);
  return parts.join(', ');
}

/** The connect action of a host not connected: Retry after a failed try, else Connect now. */
export function connectAction(failed: boolean, busy: boolean): { label: string; reserve: string[] } {
  const label = failed ? (busy ? 'Retrying...' : 'Retry') : busy ? 'Connecting...' : 'Connect now';
  return { label, reserve: failed ? ['Retry', 'Retrying...'] : ['Connect now', 'Connecting...'] };
}

const PLACEHOLDERS = ['buildbox', 'workstation', 'gpu-server', 'lab-pc', 'server-2'];

/** An alias for the placeholder that no host has (the page would refuse one that is taken). */
export function aliasPlaceholder(taken: ReadonlySet<string>): string {
  return PLACEHOLDERS.find((p) => !taken.has(p)) ?? `host-${taken.size + 1}`;
}

/** A new row nobody typed in yet: Cancel and Escape take it away with no confirm. */
export function untouchedDraft(h: HostEntry): boolean {
  return h.savedAlias === undefined && !h.alias && !h.hostname && !h.user && h.port === undefined && !h.label && !h.shell_setup && h.keep === undefined && h.excludeText === undefined;
}
