/**
 * TaskTagPills: a task's own tags, as pills on the Homepage task row, its detail
 * pane and the session header (the /tasks card and table draw the same TagChip).
 *
 * Only the tags the display rules show (src/core/tag-display-rules.ts): Walnut's
 * machine tags ("walnut:…") are types with a pill of their own (Imported), and
 * any tag or key the user or a plugin hid stays off. A tag whose rule says value
 * reads as its value alone ("V1234567890", a label's word), the same on every row.
 * A row or a pinned card shows two next to its title (an id and its severity read
 * together); the rest fold into "+N", whose tooltip names them. The detail pane
 * passes a larger max.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TagChip } from './TagChip';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTagDisplay } from '@/stores/tag-display-store';
import { shownTags, tagValue, type CompiledTagDisplay } from '../../../../src/core/tag-display-rules';
import { isLinkTag, linkTagKey, linkTagLabel, linkTagShowsId } from '../../../../src/core/link-tags';
import '@/styles/session-header-pills.css';
import '@/styles/row-pills.css';
import { effectiveTags } from '../../../../src/core/tag-model';

type TaggedTask = { tags?: readonly string[]; created_at?: string; updated_at?: string };

/** The tags a task list shows, in order (the /tasks cards and table filter through this).
 *  Given the task, its own dates (`created:` / `updated:`) count too, for a rule that shows them.
 *  Link tags stay off every list: they belong to the session header (2026-10-23). */
export function useShownTags(tags: readonly string[] | undefined, task?: TaggedTask): string[] {
  const { compiled } = useTagDisplay();
  return shownTags(task ? effectiveTags(task) : tags, compiled).filter((tag) => !isLinkTag(tag));
}

/** Tags this short keep their whole text when the pills are squeezed; longer ones give way. */
const WHOLE_TAG_MAX = 8;

/** The text a tag's pill reads under the rules. A link always reads `key:label`. */
export function pillText(tag: string, compiled: CompiledTagDisplay): string {
  const label = linkTagLabel(tag);
  if (label) return linkTagShowsId(tag) ? `${linkTagKey(tag)}:${label}` : linkTagKey(tag)!;
  return compiled.valueOnly(tag) ? tagValue(tag) : tag;
}

function Pill({ tag, compiled, onOpenPath, full }: { tag: string; compiled: CompiledTagDisplay; onOpenPath?: (path: string) => void; full?: boolean }) {
  const text = pillText(tag, compiled);
  return (
    <TagChip tag={tag} inline={!full} valueOnly={compiled.valueOnly(tag)} whole={isLinkTag(tag) || text.length <= WHOLE_TAG_MAX}
      href={compiled.linkFor(tag)} onOpenPath={onOpenPath} />
  );
}

/** "+N" that opens the rest as a list: each row its own pill, a link opens where it points. */
function OverflowMenu({ rest, compiled, onOpenPath }: { rest: string[]; compiled: CompiledTagDisplay; onOpenPath?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { minHeight: 60, onAnchorLost: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tag-chip tag-chip-overflow tag-chip-overflow-btn${open ? ' open' : ''}`}
        title={rest.map((tag) => pillText(tag, compiled)).join(', ')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="tag-pills-more"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        +{rest.length}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="tag-pills-menu"
          role="menu"
          data-testid="tag-pills-menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          // A click on a link in the list opens it, and the list has done its job. Seen in the
          // capture phase (the pill stops its own click from bubbling, so it never opens the row
          // under it) and closed after it: closing at once unmounts the pill before its handler runs.
          onClickCapture={(e) => { if ((e.target as HTMLElement).closest('.tag-chip-linked')) setTimeout(() => setOpen(false), 0); }}
        >
          {rest.map((tag) => (
            <div key={tag} className="tag-pills-menu-row" role="menuitem">
              <Pill tag={tag} compiled={compiled} onOpenPath={onOpenPath} full />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export function TaskTagPills({ tags, task, max = 1, className, linksFirst, menu, onOpenPath }: {
  tags?: readonly string[]; task?: TaggedTask; max?: number; className?: string;
  /** Shows the link tags, before the other tags: the session header, where a link is what one
   *  opens. Every other surface (a task row, a card) leaves link tags off (2026-10-23). */
  linksFirst?: boolean;
  /** "+N" opens the rest as a list instead of naming them in a tooltip. */
  menu?: boolean;
  /** Opens a file-path link tag (the session header passes its Files view). */
  onOpenPath?: (path: string) => void;
}) {
  const { compiled } = useTagDisplay();
  const ordered = shownTags(task ? effectiveTags(task) : tags, compiled);
  const shown = linksFirst
    ? [...ordered.filter((tag) => isLinkTag(tag)), ...ordered.filter((tag) => !isLinkTag(tag))]
    : ordered.filter((tag) => !isLinkTag(tag));
  if (shown.length === 0) return null;
  const head = shown.slice(0, max);
  const rest = shown.slice(max);
  const more = rest.length > 0 && (menu
    ? <OverflowMenu rest={rest} compiled={compiled} onOpenPath={onOpenPath} />
    : <span className="tag-chip tag-chip-overflow" title={rest.map((tag) => pillText(tag, compiled)).join(', ')}>+{rest.length}</span>);
  const last = head.at(-1)!;
  return (
    <span className={className ? `task-tag-pills ${className}` : 'task-tag-pills'} data-testid="task-tag-pills">
      {head.slice(0, -1).map((tag) => <Pill key={tag} tag={tag} compiled={compiled} onOpenPath={onOpenPath} />)}
      {/* "+N" rides inside the last pill ("thread +3"), never as a pill of its own (2026-10-23). */}
      {more
        ? <span className="tag-pill-group" key={last}><Pill tag={last} compiled={compiled} onOpenPath={onOpenPath} />{more}</span>
        : <Pill key={last} tag={last} compiled={compiled} onOpenPath={onOpenPath} />}
    </span>
  );
}
