import React, { type RefObject } from 'react';
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
  /** A change link with a status (ChangePill.tsx): a dot in its tone and a few words after the
   *  name (`CR-1001 · prod-w1 baking`). */
  status?: { tone: string; text: string };
  /** The pill opens a card of its own instead of the link (a change's status card); `expanded`
   *  says the card is open, and the hover card stays away meanwhile. */
  onActivate?: () => void;
  expanded?: boolean;
  /** Set to the pill's element, for a card placed beside it. */
  anchorRef?: RefObject<HTMLElement | null>;
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
export function TagChip({ tag, inline, onRemove, onClick, active, hiddenOnTasks, whole, valueOnly, href, onOpenPath, linkName, status, onActivate, expanded, anchorRef }: TagChipProps) {
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
  const activate = onActivate && !onRemove ? onActivate : undefined;
  const hover = useLinkHoverCard(isLink && !onRemove && !expanded ? {
    kind: kind!.replace(/-/g, ' '),
    name: value,
    target: (ownUrl ?? ownPath)!,
    opens: activate ? 'Click for its status' : ownUrl ? `Opens in a new tab \u00b7 ${hostOf(ownUrl)}` : openPath ? 'Opens in Files' : 'A file on this task',
  } : undefined);
  const hoverRef = (el: HTMLElement | null) => { hover.anchorRef.current = el; if (anchorRef) anchorRef.current = el; };

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
    status && 'tag-chip-change',
  ].filter(Boolean).join(' ');
  const title = hiddenOnTasks ? `${tag} (not shown on tasks; Settings, Tasks, Tags)`
    : isLink ? `${value}, ${kind!.replace(/-/g, ' ')}: ${ownUrl ?? ownPath}` : tag;
  const text = (
    <>
      {isLink && <LinkKindIcon group={linkKindGroup(kind!)} />}
      {prefix && <span className="tag-chip-prefix">{prefix}:</span>}
      <span className="tag-chip-value">{value}</span>
      {status && (
        <span className="tag-chip-change-status" data-testid="change-pill-status">
          <span className="tag-chip-change-sep">{' \u00b7 '}</span>
          <span className="tag-chip-change-dot" data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
      )}
    </>
  );
  const linkProps = href ? {
    href, target: '_blank', rel: 'noopener noreferrer', draggable: false,
    onClick: keepToLink, onPointerDown: keepToLink, onMouseDown: keepToLink,
  } : null;

  // A pill with a card of its own (a change's status) opens it; the card links to the target.
  if (activate) {
    return (
      <span
        ref={hoverRef}
        {...hover.handlers}
        className={`${className} tag-chip-activatable`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={!!expanded}
        aria-label={status ? `${title}: ${status.text}` : title}
        data-tag={tag}
        data-tone={status?.tone}
        onClick={(e) => { e.stopPropagation(); activate(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); activate(); } }}
        onPointerDown={keepToLink}
        onMouseDown={keepToLink}
      >
        {text}
        {hover.card}
      </span>
    );
  }

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
