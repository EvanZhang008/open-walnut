/**
 * Tree Mode's path bar (the split design 4, 2026-11-03): an arrow-shaped
 * ribbon of the levels from the main conversation down to the deepest question
 * the reader went to, at the top of the Tree Mode body.
 *
 *   [Main conversation v] > [6 title v] > [6.1 title L v] > [6.1.2 title R v]   Cmd[ Cmd] move the pair
 *
 * The two pages in the halves wear L and R (`only` for a single page). A click
 * on a segment moves the pair there (useTreeSplit); its caret opens the
 * questions at the same level, with their status words, and a pick switches
 * the segment (the levels right of it are cut back to it).
 *
 * The level list follows web/src/AGENTS.md's menu rules: portalled to body,
 * placed by useMenuPlacement, pointerdown stops at the portal, an outside click
 * closes it and exempts the other question overlays, no native select.
 * Separators and carets are CSS / SVG, never glyph characters (the question UI
 * bans arrow and dash glyphs in visible text).
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { THREAD_OVERLAY_ATTR, THREAD_OVERLAY_SELECTOR } from '@/components/sessions/ThreadConfirm';
import { ThreadChevronIcon } from '@/components/sessions/ThreadIcons';
import { ThreadStatusDot } from '@/components/sessions/ThreadStatusDot';
import { ThreadStatusWord } from '@/components/sessions/ThreadStatusWord';
import { isMacPlatform } from '@/hooks/usePanelKeyRouter';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import type { SegmentRole } from '@/utils/tree-split-state';
import '@/styles/tree-split.css';

const MENU_EXEMPT = `${THREAD_OVERLAY_SELECTOR}, .thread-drawer`;
const CMD = '\u2318';
/** The badge's words for a screen reader, read as part of the segment's name. */
const ROLE_NAME: Record<NonNullable<SegmentRole>, string> = { L: '(left half)', R: '(right half)', only: '(on screen)' };

export interface PathBarSegment {
  key: string;
  /** The question's label (`6.1`); none for Main or an Ask not sent yet. */
  number?: string;
  title: string;
  role: SegmentRole;
}

export interface PathBarLevelItem {
  key: string;
  number?: string;
  title: string;
  status: ThreadViewStatus;
  hue: number;
  depth: number;
  unread: boolean;
  /** This item is the segment's own question. */
  current: boolean;
}

export interface ThreadPathBarProps {
  segments: PathBarSegment[];
  /** Two halves on screen (the hint says `move the pair`). */
  split: boolean;
  /** Titles only on the pages on screen, no key hint. */
  narrow: boolean;
  onSegment: (j: number) => void;
  /** The questions at segment `j`'s level, read when its list opens. */
  levelItems: (j: number) => PathBarLevelItem[];
  levelHeading: (j: number) => string;
  onPick: (j: number, key: string) => void;
}

export const ThreadPathBar = memo(function ThreadPathBar(p: ThreadPathBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const caretRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The segments changed under an open list (the pick moved the pair): close it.
  const sig = p.segments.map((s) => s.key).join('\n');
  useEffect(() => { setOpen(null); }, [sig]);
  const mod = isMacPlatform() ? CMD : 'Ctrl ';
  return (
    <nav className="tree-path-bar" aria-label="Question path" data-narrow={p.narrow ? 'true' : undefined} data-split={p.split ? 'true' : undefined}>
      <ol className="tree-path-segs">
        {p.segments.map((seg, j) => {
          const shownHere = seg.role !== null;
          const label = seg.key === '' ? 'Main conversation' : seg.title;
          return (
            <li key={seg.key || 'root'} className="tree-path-seg" data-role={seg.role ?? undefined}
              data-first={j === 0 ? 'true' : undefined} data-shown={shownHere ? 'true' : undefined}>
              <button type="button" className="tree-path-seg-main" title={seg.number ? `${seg.number} ${label}` : label}
                aria-current={seg.role === 'R' || seg.role === 'only' ? 'page' : undefined} onClick={() => p.onSegment(j)}>
                {seg.number && <span className="tree-path-num">{seg.number}</span>}
                <span className="tree-path-title">{label}</span>
                {seg.role && (
                  <>
                    <span className="tree-path-role" data-role={seg.role} aria-hidden="true">{seg.role}</span>
                    <span className="tree-sr-only">{ROLE_NAME[seg.role]}</span>
                  </>
                )}
              </button>
              <button
                type="button"
                ref={(el) => { caretRefs.current[j] = el; }}
                className="tree-path-caret"
                aria-haspopup="menu"
                aria-expanded={open === j}
                aria-label={j === 0 ? 'Questions on the main conversation' : `Questions beside ${seg.number ?? label}`}
                title="Questions at this level"
                onClick={() => setOpen((o) => (o === j ? null : j))}
              >
                <ThreadChevronIcon size={10} className="thread-icon--down" />
              </button>
            </li>
          );
        })}
      </ol>
      {!p.narrow && p.segments.length > 1 && (
        <span className="tree-path-hint" aria-hidden="true">
          <kbd>{mod}[</kbd><kbd>{mod}]</kbd>
          <span>{p.split ? 'move the pair' : 'move along the path'}</span>
        </span>
      )}
      {open !== null && (
        <LevelMenu
          anchorEl={caretRefs.current[open] ?? null}
          heading={p.levelHeading(open)}
          items={p.levelItems(open)}
          onPick={(key) => { const j = open; setOpen(null); p.onPick(j, key); }}
          onClose={() => setOpen(null)}
        />
      )}
    </nav>
  );
});

function LevelMenu({ anchorEl, heading, items, onPick, onClose }: {
  anchorEl: HTMLElement | null;
  heading: string;
  items: PathBarLevelItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const triggerRef = useRef<HTMLElement | null>(anchorEl);
  triggerRef.current = anchorEl;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const place = useMenuPlacement(true, triggerRef, menuRef, { align: 'start', minHeight: 120, onAnchorLost: onClose });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (menuRef.current?.contains(t) || anchorEl?.contains(t) || t.closest(MENU_EXEMPT)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchorEl]);
  // Focus the segment's own question (else the first), so arrows start there.
  useEffect(() => {
    if (!place) return;
    const list = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const cur = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (cur ?? list?.[0])?.focus({ preventScroll: true });
  }, [place]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchorEl?.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    // Tab leaves the list where it was opened (a portalled menu has no place
    // in the tab order of its own).
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); anchorEl?.focus({ preventScroll: true }); }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="thread-menu tree-path-menu"
      role="menu"
      aria-label={heading}
      {...{ [THREAD_OVERLAY_ATTR]: 'path-level' }}
      style={menuPlacementStyle(place)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKey}
    >
      <div className="tree-path-menu-heading">{heading}</div>
      {items.length === 0 && <div className="tree-path-menu-empty">No questions here yet.</div>}
      {items.map((it) => (
        <button key={it.key} type="button" role="menuitemradio" aria-checked={it.current}
          className="thread-menu-item tree-path-menu-item" data-current={it.current ? 'true' : undefined}
          title={it.title} onClick={() => onPick(it.key)}>
          <span className="tree-path-menu-num">
            <ThreadStatusDot status={it.status} hue={it.hue} depth={it.depth} unread={it.unread} />
            {it.number}
          </span>
          <span className="thread-menu-label tree-path-menu-title">{it.title}</span>
          <ThreadStatusWord status={it.status} unread={it.unread} className="tree-path-menu-status" />
        </button>
      ))}
    </div>,
    document.body,
  );
}
