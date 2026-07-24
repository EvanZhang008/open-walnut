/**
 * Shared task-metadata constants (tier + priority options).
 * Used by TaskQuickActions kebab menu and SessionPathSelector meta footer.
 */

import type { TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';

export const TIER_OPTIONS: { value: FocusTier; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'wait', label: 'Wait' },
];

export const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--fg-muted)',
  wait: '#8e8e93',
};

export const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

export const PIN_CYCLE: Array<FocusTier | undefined> = [undefined, 'focus', 'satellite', 'wait'];
export const PRIORITY_CYCLE: Array<TaskPriority | undefined> = [undefined, 'immediate', 'important', 'backlog'];

export function nextValue<T>(values: T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}
