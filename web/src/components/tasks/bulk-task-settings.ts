/**
 * The task menu's setting rows (Pinned, and each plugin field such as Sprint) for a GROUP of tasks:
 * a folder's or a project's open tasks. Pure, so the gating and the mixed-state reading are testable
 * without a renderer; the hook that wires them to the stores is `useBulkTaskSettings`.
 *
 * A group has no pin or sprint of its own. Its row reads what its open tasks share: one tier lit
 * when every open task is pinned there, a field's value when every open task has it ("Mixed" when
 * they differ), and a pick writes that value to every open task. Completed tasks are left alone,
 * the same rule the task menu applies (no Pinned row on a done task).
 */
import type { ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { ContextMenuItem } from '@/utils/context-menu';
import type { FocusTier } from '@/api/focus';

/** From this many tasks a pick asks first: one click would otherwise re-tier a whole project. */
export const BULK_CONFIRM_AT = 20;

export function isOpenTask(task: Pick<Task, 'phase' | 'status'>): boolean {
  return task.phase !== 'COMPLETE' && task.status !== 'done';
}

/** Open tasks filed in any of `folderIds` (a folder and every folder under it). */
export function folderMemberTasks(tasks: readonly Task[], folderIds: ReadonlySet<string>): Task[] {
  return tasks.filter((t) => !!t.group_id && folderIds.has(t.group_id) && isOpenTask(t));
}

/** Open tasks of one project ('' = Inbox). Project identity is case-insensitive, as on the server. */
export function projectMemberTasks(tasks: readonly Task[], project: string): Task[] {
  const name = project.trim().toLowerCase();
  return tasks.filter((t) => (t.project ?? '').trim().toLowerCase() === name && isOpenTask(t));
}

export type CommonTier =
  | { kind: 'unpinned' }
  | { kind: 'pinned'; tier: FocusTier }
  | { kind: 'mixed' };

/** What a group's Pinned row lights: one tier only when EVERY task sits in it. */
export function commonTier(members: readonly Task[], tierOf: (task: Task) => FocusTier): CommonTier {
  if (members.length === 0 || members.every((t) => !t.pinned)) return { kind: 'unpinned' };
  if (!members.every((t) => t.pinned)) return { kind: 'mixed' };
  const first = tierOf(members[0]);
  return members.every((t) => tierOf(t) === first) ? { kind: 'pinned', tier: first } : { kind: 'mixed' };
}

export type CommonValue = { kind: 'none' } | { kind: 'same'; value: string } | { kind: 'mixed' };

export function commonValue(members: readonly Task[], read: (task: Task) => string | undefined): CommonValue {
  const values = new Set(members.map((t) => read(t) ?? ''));
  if (values.size === 0 || (values.size === 1 && values.has(''))) return { kind: 'none' };
  if (values.size === 1) return { kind: 'same', value: [...values][0] };
  return { kind: 'mixed' };
}

export interface TierPillOption {
  value: FocusTier;
  label: string;
  icon?: ReactNode;
  color: string;
}

export type BulkNoun = 'folder' | 'project';

const tasksWord = (count: number) => `${count} open task${count === 1 ? '' : 's'}`;

/**
 * The Pinned row: one pill per tier. The lit pill is the pin itself, so clicking it again unpins
 * every task (`onPick(null)`), exactly as on a single task.
 */
export function buildPinnedPills(opts: {
  options: readonly TierPillOption[];
  common: CommonTier;
  count: number;
  noun: BulkNoun;
  onPick: (tier: FocusTier | null) => void;
}): ContextMenuItem[] {
  const { options, common, count, noun, onPick } = opts;
  const heading = common.kind === 'pinned' ? 'Pinned' : 'Pin to';
  const none = count === 0 ? `No open tasks in this ${noun}` : undefined;
  return options.map((option) => {
    const lit = common.kind === 'pinned' && common.tier === option.value;
    return {
      key: `pin-${option.value}`,
      label: option.label,
      icon: option.icon,
      pill: { group: 'pinned', label: heading, color: option.color },
      checked: lit,
      disabled: count === 0,
      title: none ?? (lit ? `Unpin the ${tasksWord(count)}` : `Pin the ${tasksWord(count)} to ${option.label}`),
      onSelect: () => onPick(lit ? null : option.value),
    };
  });
}

export interface BulkFieldRow {
  /** Stable id of the field (`pluginId.key`). */
  id: string;
  label: string;
  common: CommonValue;
}

/** One setting row per plugin field (Sprint, …): the shared value, "Mixed", or "Set…". */
export function buildFieldRows(opts: {
  fields: readonly BulkFieldRow[];
  count: number;
  noun: BulkNoun;
  onOpen: (fieldId: string) => void;
}): ContextMenuItem[] {
  const { fields, count, noun, onOpen } = opts;
  return fields.map((field) => ({
    key: `field-${field.id}`,
    label: field.label,
    value: field.common.kind === 'same' ? field.common.value : field.common.kind === 'mixed' ? 'Mixed' : 'Set…',
    disabled: count === 0,
    title: count === 0
      ? `No open tasks in this ${noun}`
      : `${field.label} of the ${tasksWord(count)} in this ${noun}`,
    onSelect: () => onOpen(field.id),
  }));
}

/** The question a large pick asks, or null when it can just happen. */
export function bulkConfirmCopy(
  action: { kind: 'tier'; tierLabel: string | null } | { kind: 'field'; fieldLabel: string; valueLabel: string | null },
  count: number,
): { title: string; message: string; confirmLabel: string } | null {
  if (count < BULK_CONFIRM_AT) return null;
  if (action.kind === 'tier') {
    return action.tierLabel === null
      ? { title: `Unpin ${count} tasks?`, message: 'Every open task here leaves the pinned area.', confirmLabel: 'Unpin' }
      : { title: `Pin ${count} tasks to ${action.tierLabel}?`, message: 'Every open task here moves to that tier.', confirmLabel: 'Pin' };
  }
  return action.valueLabel === null
    ? { title: `Clear ${action.fieldLabel} on ${count} tasks?`, message: 'Every open task here loses its value.', confirmLabel: 'Clear' }
    : { title: `Set ${action.fieldLabel} to ${action.valueLabel} on ${count} tasks?`, message: 'Every open task here gets that value.', confirmLabel: 'Set' };
}
