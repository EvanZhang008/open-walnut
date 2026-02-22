import React from 'react';

interface TagChipProps {
  tag: string;
  inline?: boolean;       // Compact mode for TaskCard (truncated)
  onRemove?: () => void;  // Show X button when provided
  onClick?: () => void;   // For filter interaction
  active?: boolean;       // Highlight when used as filter
}

/**
 * Reusable tag pill component.
 * Parses "key:value" format for visual prefix distinction.
 */
export function TagChip({ tag, inline, onRemove, onClick, active }: TagChipProps) {
  const colonIdx = tag.indexOf(':');
  const hasPrefix = colonIdx > 0 && colonIdx < tag.length - 1;
  const prefix = hasPrefix ? tag.slice(0, colonIdx) : null;
  const value = hasPrefix ? tag.slice(colonIdx + 1) : tag;

  const className = [
    'tag-chip',
    inline && 'tag-chip-inline',
    onClick && 'tag-chip-clickable',
    active && 'tag-chip-active',
  ].filter(Boolean).join(' ');

  return (
    <span className={className} onClick={onClick} title={tag}>
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
