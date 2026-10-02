import React from 'react';

interface TagChipProps {
  tag: string;
  inline?: boolean;       // Compact mode for TaskCard (truncated)
  onRemove?: () => void;  // Show X button when provided
  onClick?: () => void;   // For filter interaction
  active?: boolean;       // Highlight when used as filter
  /** The display rules keep this tag off task pills (the tag editor still lists it). */
  hiddenOnTasks?: boolean;
  /** Never squeezed in a row of pills: a short tag ("sev:2") clipped reads as nonsense. */
  whole?: boolean;
  /** The display rules show only the value ("V1234567890" for "ticket:V1234567890"); the
   *  tooltip still names the whole tag. */
  valueOnly?: boolean;
}

/**
 * Reusable tag pill component.
 * Parses "key:value" format for visual prefix distinction.
 */
export function TagChip({ tag, inline, onRemove, onClick, active, hiddenOnTasks, whole, valueOnly }: TagChipProps) {
  const colonIdx = tag.indexOf(':');
  const hasPrefix = colonIdx > 0 && colonIdx < tag.length - 1;
  const prefix = hasPrefix && !valueOnly ? tag.slice(0, colonIdx) : null;
  const value = hasPrefix ? tag.slice(colonIdx + 1) : tag;

  const className = [
    'tag-chip',
    inline && 'tag-chip-inline',
    onClick && 'tag-chip-clickable',
    active && 'tag-chip-active',
    hiddenOnTasks && 'tag-chip-hidden',
    whole && 'tag-chip-whole',
    valueOnly && hasPrefix && 'tag-chip-value-only',
  ].filter(Boolean).join(' ');

  return (
    <span
      className={className}
      onClick={onClick}
      title={hiddenOnTasks ? `${tag} (not shown on tasks; Settings, Tasks, Tags)` : tag}
      data-hidden-on-tasks={hiddenOnTasks ? 'true' : undefined}
      data-tag={tag}
    >
      {prefix && <span className="tag-chip-prefix">{prefix}:</span>}
      <span className="tag-chip-value">{value}</span>
      {onRemove && (
        <button
          className="tag-chip-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title={`Remove "${tag}"`}
        >
          ×
        </button>
      )}
    </span>
  );
}
