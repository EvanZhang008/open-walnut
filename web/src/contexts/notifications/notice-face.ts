/**
 * How a notification reads on its card (common/NoticeCard.tsx): who it is from (the bold title),
 * its status as a dot and a word, and where a click on it goes. Pure, so every kind is checked in
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

/** Where a click on the card goes: the session or task it is about, else nowhere of its own. */
export function noticeTarget(n: Pick<Notification, 'taskId' | 'sessionId'>): string | null {
  if (n.taskId) return `/tasks/${n.taskId}`;
  if (n.sessionId) return `/sessions?id=${encodeURIComponent(n.sessionId)}`;
  return null;
}
