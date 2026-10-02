/**
 * The read-only rows at the foot of the session panel's ⋮ menu: when the
 * session was created, when it was last updated, and which host it runs on.
 * Pure (no React), unit tested in tests/web/session-kebab-meta.test.ts.
 */
import { timeAgo } from '@/utils/time';
import { hostDisplayLabel } from '@/utils/host-display-label';
import { formatCpu, formatMemory, formatProcCount } from '@/utils/resource-format';

export interface KebabMetaRow {
  key: 'created' | 'updated' | 'host' | 'memory' | 'cpu';
  label: string;
  /** `2h ago`, `Local`, `clouddev` */
  value: string;
  /** Hover text: the exact time, or the host's full name. */
  title: string;
}

interface SessionMeta {
  startedAt?: string;
  lastActiveAt?: string;
  host?: string;
  hostname?: string;
  /** The session's last resource reading (session-resources-store), when a host reports it. */
  resources?: { rssBytes: number; cpuPct: number | null; procCount: number; top: Array<{ pid: number; comm: string; rssBytes: number }> } | null;
}

const NBSP_RE = /[\u202f\u00a0]/g;

/** `Mon, Sep 28, 2026, 3:02:05 PM`: the exact time behind a relative one. */
function exactTime(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).replace(NBSP_RE, ' ');
}

function timeRow(key: 'created' | 'updated', label: string, iso: string | undefined, now: number): KebabMetaRow | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { key, label, value: timeAgo(iso, { now }), title: exactTime(d) };
}

/** A missing or unparseable time drops its row rather than printing "Invalid Date". */
export function sessionKebabMetaRows(session: SessionMeta, now: number = Date.now()): KebabMetaRow[] {
  const local = !session.host || session.host === '__local__' || session.host === 'local';
  const host = hostDisplayLabel(local ? null : session.host);
  const r = session.resources;
  // What the session costs its machine: its whole process tree, the top processes on hover.
  const procs = r ? r.top.slice(0, 5).map((p) => `${p.comm} (${p.pid}) ${formatMemory(p.rssBytes)}`).join('\n') : '';
  return [
    timeRow('created', 'Created', session.startedAt, now),
    timeRow('updated', 'Updated', session.lastActiveAt, now),
    { key: 'host' as const, label: 'Host', value: host, title: (!local && session.hostname) || host },
    r ? { key: 'memory' as const, label: 'Memory', value: `${formatMemory(r.rssBytes)} · ${formatProcCount(r.procCount)}`, title: procs || 'No processes found' } : null,
    r ? { key: 'cpu' as const, label: 'CPU', value: formatCpu(r.cpuPct), title: r.cpuPct == null ? 'Measured from the next sample on' : 'Over the last sample; more than 100% is more than one core' } : null,
  ].filter((row): row is KebabMetaRow => row !== null);
}
