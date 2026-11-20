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
