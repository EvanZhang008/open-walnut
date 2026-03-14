import type { TaskPriority } from '@open-walnut/core';

interface PriorityBadgeProps {
  priority: TaskPriority;
  onClick?: (e: React.MouseEvent) => void;
}

const SHORT: Record<string, string> = { immediate: '!!', important: '!', backlog: '~', none: '--',
  high: '!!', low: '~', medium: '~', /* legacy — kept for unmigrated tasks */ };
const NEXT_LABEL: Record<string, string> = { none: 'Change to backlog', backlog: 'Change to important', important: 'Change to immediate', immediate: 'Change to none',
  high: 'Change to none', low: 'Change to important', medium: 'Change to important', /* legacy */ };
/** Map legacy priority values to new CSS classes (for unmigrated tasks). */
const BADGE_CLASS: Record<string, string> = { high: 'immediate', medium: 'backlog', low: 'backlog' };

export function PriorityBadge({ priority, onClick }: PriorityBadgeProps) {
  const cssClass = BADGE_CLASS[priority] ?? priority;
  if (onClick) {
    return (
      <button
        type="button"
        className={`badge badge-${cssClass} badge-clickable`}
        title={NEXT_LABEL[priority] ?? priority}
        onClick={onClick}
      >
        {SHORT[priority] ?? priority}
      </button>
    );
  }
  return <span className={`badge badge-${cssClass}`} title={priority}>{SHORT[priority] ?? priority}</span>;
}
