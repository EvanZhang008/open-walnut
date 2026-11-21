/**
 * The read-only rows at the foot of the session panel's ⋮ menu (Session info): the
 * folder the session works in, which host it runs on, when it was created and when it
 * was last updated. The folder comes first and is shown whole: it is the fact people
 * open this group for (2026-11-21, the user: "where is the fucking path").
 * Pure (no React), unit tested in tests/web/session-kebab-meta.test.ts.
 */
import { timeAgo } from '@/utils/time';
import { hostDisplayLabel } from '@/utils/host-display-label';

export interface KebabMetaRow {
  key: 'folder' | 'host' | 'created' | 'updated';
  label: string;
  /** `/work/repo`, `Local`, `clouddev`, `2h ago` */
  value: string;
  /** Hover text: the exact time, the host's full name, or the folder. */
  title: string;
  /** The folder is gone from its host (the session's cwdGone). */
  gone?: boolean;
}

interface SessionMeta {
  cwd?: string;
  /** Its working folder was gone at its last start or resume. */
  cwdGone?: boolean;
  startedAt?: string;
  lastActiveAt?: string;
  host?: string;
  hostname?: string;
}

const NBSP_RE = /[\u202f\u00a0]/g;

/**
 * `Mon, Sep 28, 2026, 3:02:05 PM`: the exact time behind a relative one. Date and
 * time are formatted apart and joined here, because one combined format joins them
 * with ", " in V8 (Chrome) but " at " in JavaScriptCore (WebKit, so the Mac app).
 */
function exactTime(d: Date): string {
  const date = d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return `${date}, ${time}`.replace(NBSP_RE, ' ');
}

function timeRow(key: 'created' | 'updated', label: string, iso: string | undefined, now: number): KebabMetaRow | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { key, label, value: timeAgo(iso, { now }), title: exactTime(d) };
}

/** A missing or unparseable time drops its row rather than printing "Invalid Date"; no folder, no Folder row. */
export function sessionKebabMetaRows(session: SessionMeta, now: number = Date.now()): KebabMetaRow[] {
  const local = !session.host || session.host === '__local__' || session.host === 'local';
  const host = hostDisplayLabel(local ? null : session.host);
  const folder: KebabMetaRow | null = session.cwd
    ? {
        key: 'folder', label: 'Folder', value: session.cwd,
        title: session.cwdGone ? `${session.cwd} no longer exists on this host` : session.cwd,
        ...(session.cwdGone ? { gone: true } : {}),
      }
    : null;
  return [
    folder,
    { key: 'host' as const, label: 'Host', value: host, title: (!local && session.hostname) || host },
    timeRow('created', 'Created', session.startedAt, now),
    timeRow('updated', 'Updated', session.lastActiveAt, now),
  ].filter((row): row is KebabMetaRow => row !== null);
}

/** A path as one shell word: bare when it is plain, single-quoted otherwise. */
export function shellWord(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}
