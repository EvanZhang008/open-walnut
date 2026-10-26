import React from 'react';
import { linkKindGroup, linkPathOfTag, linkTagKey, linkTagName, linkUrlOfTag } from '../../../../src/core/link-tags';
import { useLinkHoverCard } from './LinkHoverCard';
import { LinkKindIcon } from './LinkKindIcon';

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
  /** Opens a file-path link tag (`html:/tmp/run/result.html`) in the session's Files view.
   *  Without it a path tag is a plain pill whose tooltip names the path. */
  onOpenPath?: (path: string) => void;
  /** A link tag's name among its task's links (linkTagNames: distinct on one task); without it
   *  the pill reads the name the tag makes on its own. */
  linkName?: string;
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
export function TagChip({ tag, inline, onRemove, onClick, active, hiddenOnTasks, whole, valueOnly, href, onOpenPath, linkName }: TagChipProps) {
  const colonIdx = tag.indexOf(':');
  const hasPrefix = colonIdx > 0 && colonIdx < tag.length - 1;
  // A link tag reads as its name (`Fix plan r5b`, a ticket's id) after an icon for its kind,
  // whatever a value-only rule says; the hover card has the kind and the URL or path.
  const ownUrl = linkUrlOfTag(tag);
  const ownPath = ownUrl ? undefined : linkPathOfTag(tag);
  const isLink = !!(ownUrl || ownPath);
  const kind = isLink ? linkTagKey(tag)! : undefined;
  const prefix = hasPrefix && !valueOnly && !isLink ? tag.slice(0, colonIdx) : null;
  const value = isLink ? (linkName ?? linkTagName(tag)!) : hasPrefix ? tag.slice(colonIdx + 1) : tag;
  const openPath = ownPath && onOpenPath && !onClick ? () => onOpenPath(ownPath) : undefined;
  // A link tag names its target in a hover card; the tag editor, where the pill has a remove
  // button, keeps the plain tooltip.
  const hover = useLinkHoverCard(isLink && !onRemove ? {
    kind: kind!.replace(/-/g, ' '),
    name: value,
    target: (ownUrl ?? ownPath)!,
    opens: ownUrl ? `Opens in a new tab \u00b7 ${hostOf(ownUrl)}` : openPath ? 'Opens in Files' : 'A file on this task',
  } : undefined);
  const hoverRef = (el: HTMLElement | null) => { hover.anchorRef.current = el; };

  const className = [
    'tag-chip',
    inline && 'tag-chip-inline',
    onClick && 'tag-chip-clickable',
    active && 'tag-chip-active',
    hiddenOnTasks && 'tag-chip-hidden',
    whole && 'tag-chip-whole',
    valueOnly && hasPrefix && !isLink && 'tag-chip-value-only',
    (href || openPath) && 'tag-chip-linked',
    isLink && 'tag-chip-link-tag',
  ].filter(Boolean).join(' ');
  const title = hiddenOnTasks ? `${tag} (not shown on tasks; Settings, Tasks, Tags)`
    : isLink ? `${value}, ${kind!.replace(/-/g, ' ')}: ${ownUrl ?? ownPath}` : tag;
  const text = (
    <>
      {isLink && <LinkKindIcon group={linkKindGroup(kind!)} />}
      {prefix && <span className="tag-chip-prefix">{prefix}:</span>}
      <span className="tag-chip-value">{value}</span>
    </>
  );
  const linkProps = href ? {
    href, target: '_blank', rel: 'noopener noreferrer', draggable: false,
    onClick: keepToLink, onPointerDown: keepToLink, onMouseDown: keepToLink,
  } : null;

  // A file-path link opens in the session's Files view, never the row under it.
  if (openPath && !onRemove) {
    return (
      <span
        ref={hoverRef}
        {...hover.handlers}
        className={className}
        role="link"
        tabIndex={0}
        aria-label={`${title} (opens in Files)`}
        data-tag={tag}
        onClick={(e) => { e.stopPropagation(); openPath(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); openPath(); } }}
        onPointerDown={keepToLink}
        onMouseDown={keepToLink}
      >
        {text}
        {hover.card}
      </span>
    );
  }

  // A pill with nothing else in it IS the link (the pill rows lay out its parts as its own
  // children); one with a remove button keeps the button outside the link.
  if (linkProps && !onRemove) {
    return (
      <a {...linkProps} ref={hoverRef} {...hover.handlers} className={className} data-tag={tag}
        {...(isLink ? { 'aria-label': `${title} (opens ${hostOf(href!)})` } : { title: `${title} (opens ${hostOf(href!)})` })}
        data-hidden-on-tasks={hiddenOnTasks ? 'true' : undefined}>
        {text}
        {hover.card}
      </a>
    );
  }

  return (
    <span
      ref={hoverRef}
      {...hover.handlers}
      className={className}
      onClick={onClick}
      {...(isLink && !onRemove ? { 'aria-label': title } : { title })}
      data-hidden-on-tasks={hiddenOnTasks ? 'true' : undefined}
      data-tag={tag}
    >
      {linkProps ? <a {...linkProps} className="tag-chip-link" title={`${title} (opens ${hostOf(href!)})`}>{text}</a> : text}
      {hover.card}
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
