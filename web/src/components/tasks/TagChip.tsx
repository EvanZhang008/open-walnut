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
  /** The tag is a link (a link rule, src/core/tag-display-rules.ts): the pill opens it in a new
   *  tab (the Mac app hands it to the default browser), never the row under it. */
  href?: string;
}

function hostOf(href: string): string {
  try { return new URL(href).host; } catch { return href; }
}

// A click or a press on the link is the link's: it never opens the row, selects it, or
// starts dragging it (dnd-kit listens for pointerdown on the row).
const keepToLink = (e: React.SyntheticEvent) => { e.stopPropagation(); };

/**
 * Reusable tag pill component.
 * Parses "key:value" format for visual prefix distinction.
 */
export function TagChip({ tag, inline, onRemove, onClick, active, hiddenOnTasks, whole, valueOnly, href }: TagChipProps) {
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
    href && 'tag-chip-linked',
  ].filter(Boolean).join(' ');
  const title = hiddenOnTasks ? `${tag} (not shown on tasks; Settings, Tasks, Tags)` : tag;
  const text = (
    <>
      {prefix && <span className="tag-chip-prefix">{prefix}:</span>}
      <span className="tag-chip-value">{value}</span>
    </>
  );
  const linkProps = href ? {
    href, target: '_blank', rel: 'noopener noreferrer', draggable: false,
    onClick: keepToLink, onPointerDown: keepToLink, onMouseDown: keepToLink,
  } : null;

  // A pill with nothing else in it IS the link (the pill rows lay out its parts as its own
  // children); one with a remove button keeps the button outside the link.
  if (linkProps && !onRemove) {
    return (
      <a {...linkProps} className={className} title={`${title} (opens ${hostOf(href!)})`} data-tag={tag}
        data-hidden-on-tasks={hiddenOnTasks ? 'true' : undefined}>
        {text}
      </a>
    );
  }

  return (
    <span
      className={className}
      onClick={onClick}
      title={title}
      data-hidden-on-tasks={hiddenOnTasks ? 'true' : undefined}
      data-tag={tag}
    >
      {linkProps ? <a {...linkProps} className="tag-chip-link" title={`${title} (opens ${hostOf(href!)})`}>{text}</a> : text}
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
