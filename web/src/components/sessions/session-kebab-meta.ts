/**
 * The read-only rows at the foot of the session panel's ⋮ menu: when the
 * session was created, when it was last updated, and which host it runs on.
 * Pure (no React), unit tested in tests/web/session-kebab-meta.test.ts.
 */
import { timeAgo } from '@/utils/time';
import { hostDisplayLabel } from '@/utils/host-display-label';

export interface KebabMetaRow {
  key: 'created' | 'updated' | 'host';
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
  return [
    timeRow('created', 'Created', session.startedAt, now),
    timeRow('updated', 'Updated', session.lastActiveAt, now),
    { key: 'host' as const, label: 'Host', value: host, title: (!local && session.hostname) || host },
  ].filter((row): row is KebabMetaRow => row !== null);
}
