import type { TaskPriority } from '@open-walnut/core';
import { badge, priorityTone } from './badge';

interface PriorityBadgeProps {
  priority: TaskPriority;
  onClick?: (e: React.MouseEvent) => void;
}

const SHORT: Record<string, string> = { immediate: '!!', important: '!', backlog: '~', none: '--',
  high: '!!', low: '~', medium: '~', /* legacy — kept for unmigrated tasks */ };
const NEXT_LABEL: Record<string, string> = { none: 'Change to backlog', backlog: 'Change to important', important: 'Change to immediate', immediate: 'Change to none',
  high: 'Change to none', low: 'Change to important', medium: 'Change to important', /* legacy */ };

export function PriorityBadge({ priority, onClick }: PriorityBadgeProps) {
  // A legacy "medium" reads as backlog here, as its short mark does.
  const cls = badge(priorityTone(String(priority) === 'medium' ? 'backlog' : priority));
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        title={NEXT_LABEL[priority] ?? priority}
        onClick={onClick}
      >
        {SHORT[priority] ?? priority}
      </button>
    );
  }
  return <span className={cls} title={priority}>{SHORT[priority] ?? priority}</span>;
}
