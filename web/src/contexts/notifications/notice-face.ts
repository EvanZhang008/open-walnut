/**
 * How a notification reads on its card (common/NoticeCard.tsx): who it is from (the bold title),
 * its status as a dot and a word (a click on it goes where linkTargetOf, notification-model.ts, says). Pure, so every kind is checked in
 * tests/web/notice-face.test.ts, which also fails when a new kind has no face here.
 */
import type { NoticeTone } from '@/components/common/NoticeCard';
import type { Notification, NotificationKind, NotificationSeverity } from './types';

/** Who a notice is from when no session or task names it. */
export const KIND_SOURCE: Record<NotificationKind, string> = {
  permission: 'A session',
  cron: 'Scheduled job',
  'operation-error': 'Walnut',
  sort: 'Tasks',
  'audio-error': 'Voice',
  skill: 'Skills',
  hook: 'Hook',
  letter: 'Inbox',
  reminder: 'Reminder',
  hint: 'Walnut',
  host: 'Computers',
};

export function noticeSource(n: Pick<Notification, 'kind' | 'sessionTitle' | 'category' | 'host'>): string {
  if (n.sessionTitle?.trim()) return n.sessionTitle.trim();
  if (n.kind === 'operation-error' && n.category?.trim()) return n.category.trim();
  if (n.kind === 'host' && n.host?.trim()) return n.host.trim();
  return KIND_SOURCE[n.kind] ?? 'Walnut';
}

const SEVERITY_STATUS: Record<NotificationSeverity, { tone: NoticeTone; text?: string }> = {
  error: { tone: 'error', text: 'Error' },
  warning: { tone: 'warn', text: 'Warning' },
  success: { tone: 'ok', text: 'Done' },
  // Plain news has no status word: a grey dot alone would only add noise.
  info: { tone: 'muted' },
};

/** The status on the card: an ask waits on you, a settled one says how it settled, else the severity. */
export function noticeStatus(n: Pick<Notification, 'kind' | 'severity' | 'resolved'>): { tone: NoticeTone; text?: string } {
  if (n.kind === 'permission') {
    switch (n.resolved) {
      case undefined: return { tone: 'ask', text: 'Needs you' };
      case 'allowed': return { tone: 'ok', text: 'Allowed' };
      case 'denied': return { tone: 'muted', text: 'Denied' };
      default: return { tone: 'muted', text: 'No longer asked' };
    }
  }
  if (n.resolved === 'recovered') return { tone: 'ok', text: 'Recovered' };
  return SEVERITY_STATUS[n.severity] ?? SEVERITY_STATUS.info;
}

/**
 * The status of a row in the notification center: the card's own status, and "New" while it is
 * unread. Unread is this dot and word, never a tint over the whole card (2026-11-21 audit: unread
 * rows had a blue fill and a strong border; read ones were white, so the state was a colour to
 * guess). An error that has gone stale says so in the same place.
 */
export function feedRowStatus(n: Pick<Notification, 'kind' | 'severity' | 'resolved' | 'read'>): { tone: NoticeTone; text?: string } {
  if (n.kind !== 'permission' && n.resolved === 'expired') return { tone: 'muted', text: n.kind === 'operation-error' ? 'Stale' : 'Ended' };
  const s = noticeStatus(n);
  if (n.read || n.kind === 'permission' || n.resolved) return s;
  if (s.tone === 'error' || s.tone === 'warn') return { tone: s.tone, text: `New ${(s.text ?? '').toLowerCase()}`.trim() };
  return { tone: s.tone === 'muted' ? 'ask' : s.tone, text: 'New' };
}

/** A session's name that only says how it was made ("Fork of Session: ..."), or an id: not a sender. */
const MACHINE_LABEL = /^(fork of session\b|session [0-9a-f]{6,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}\b)/i;
/** Host names that mean "this computer": no news on a row. */
const LOCAL_HOSTS = new Set(['local', 'localhost', '__local__']);

/**
 * The one quiet last line of a row: who it came from, then the project, each once. What only
 * helps debugging (the session id, a fork's machine name, the host) is not on the row; it is the
 * line's `title`, one hover away (2026-11-21 audit: "Fork of Session: ...", "local" and a short id
 * sat as two stacked chips under the words and did not say who sent it).
 */
export function feedRowSource(
  n: Pick<Notification, 'sessionTitle' | 'sessionId' | 'host' | 'project'>,
  hostLabel?: string,
): { text: string | null; detail: string | null } {
  const session = n.sessionTitle?.trim() || '';
  const sender = session && !MACHINE_LABEL.test(session) ? session : '';
  const project = n.project?.trim() || '';
  const parts = [sender, project && project !== sender ? project : ''].filter(Boolean);
  const host = (hostLabel ?? n.host ?? '').trim();
  const detail = [
    session && session !== sender ? `Session: ${session}` : '',
    n.sessionId ? `Session id: ${n.sessionId}` : '',
    host ? `Host: ${host}${LOCAL_HOSTS.has(host.toLowerCase()) ? ' (this computer)' : ''}` : '',
  ].filter(Boolean);
  return { text: parts.length ? parts.join(' \u00b7 ') : null, detail: detail.length ? detail.join('\n') : null };
}

/** The tone of the avatar's tile when no session names the notice. */
export function noticeTone(n: Pick<Notification, 'kind' | 'severity' | 'resolved'>): NoticeTone {
  return noticeStatus(n).tone;
}

/**
 * Which toasts stay in sight when only `room` fit: an error first (it is never the one folded
 * away while plain news stays up: 2026-11-20, an error must not be hidden), then the newest of
 * the rest. Tested in tests/web/notice-face.test.ts.
 */
export function keepInSight<T extends { severity?: string }>(list: readonly T[], room: number): Set<T> {
  if (room <= 0) return new Set();
  const errors = list.filter((t) => t.severity === 'error').slice(-room);
  const left = room - errors.length;
  const rest = left > 0 ? list.filter((t) => t.severity !== 'error').slice(-left) : [];
  return new Set([...errors, ...rest]);
}
