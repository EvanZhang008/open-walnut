/**
 * The words and tones of the Open Walnut card (NotificationUpdateCard), kept
 * apart from the component so a test pins every state without a DOM, and so
 * the Settings build line can never disagree with the card.
 */
import type { UpdateStatus } from '@/api/update';
import { formatRelative } from '@/contexts/notifications/notification-model';

export interface UpdateCardView {
  /** `unreachable` is quiet (no amber): not reaching npm is not a Walnut problem. */
  tone: 'ok' | 'neutral' | 'update' | 'unreachable';
  icon: string;
  statusLabel: string;
  status: string;
  statusClass: '' | 'ok' | 'accent';
  /** A quiet line under the status (where a source checkout lives, when it was checked). */
  note?: string;
  command?: string;
  /** The button renders only when a check can run here. */
  canCheck: boolean;
}

/** Pure: the words and tones for one status, so a test can pin every state without a DOM. */
export function updateCardView(s: UpdateStatus): UpdateCardView {
  if (!s.enabled) {
    switch (s.reason) {
      case 'source':
        return {
          tone: 'neutral', icon: '○', statusLabel: 'Status', status: 'Source checkout', statusClass: '',
          note: s.install.sourceDir ? `Updates with git pull in ${s.install.sourceDir}` : 'Updates with git pull', canCheck: false,
        };
      case 'replica':
        return { tone: 'neutral', icon: '○', statusLabel: 'Status', status: 'Cloud replica', statusClass: '', note: 'Updates with the primary console’s deploy', canCheck: false };
      case 'opted-out':
        return { tone: 'neutral', icon: '○', statusLabel: 'Status', status: 'Check turned off', statusClass: '', note: 'WALNUT_NO_UPDATE_CHECK is set', canCheck: false };
      default:
        return { tone: 'neutral', icon: '○', statusLabel: 'Status', status: 'Not checked', statusClass: '', canCheck: false };
    }
  }
  const checked = s.checkedAt ? `Checked ${formatRelative(s.checkedAt)}` : undefined;
  if (s.available && s.latest) {
    return {
      tone: 'update', icon: '↑', statusLabel: 'Update', status: `${s.latest} available`, statusClass: 'accent',
      note: s.install.updateCommand ? 'Restart Walnut after installing' : `No package manager found for this install; see ${s.packageUrl}`,
      ...(s.install.updateCommand ? { command: s.install.updateCommand } : {}),
      canCheck: true,
    };
  }
  if (s.latest) {
    return {
      tone: 'ok', icon: '✓', statusLabel: 'Status', status: 'Up to date', statusClass: 'ok',
      note: s.error ? `${checked ?? 'Checked earlier'}; the last check failed (${s.error})` : checked, canCheck: true,
    };
  }
  if (s.error) {
    return { tone: 'unreachable', icon: '○', statusLabel: 'Status', status: 'Registry unreachable', statusClass: '', note: s.error, canCheck: true };
  }
  return { tone: 'neutral', icon: '○', statusLabel: 'Status', status: 'Not checked yet', statusClass: '', canCheck: true };
}
