/**
 * The draft launch bar's decision chips, its More button, and the ONE menu
 * controller they share (DraftTaskMenuPopover is the single popover instance).
 *
 * Chips are data from draftDecisionChips (draft-decisions.ts); this file only
 * renders them and owns the interaction rules (spec 7.2 / 7.4):
 *  . a click on a chip or More opens the menu anchored there; a click on another
 *    trigger while open RE-ANCHORS it in place (no close, no remount); a click on
 *    the current anchor closes it (the outside closer exempts it, so a toggle is
 *    safe here, unlike the folder pill);
 *  . outside mousedown, Escape, the anchor scrolling out of view, and the first
 *    keystroke in the composer close it; a vanished chip hands the menu to More,
 *    a vanished More closes it;
 *  . focus: a MOUSE open (event.detail > 0) never takes focus and puts the
 *    composer's caret back on close, so the next Enter is Start; a KEYBOARD open
 *    moves focus into the tier row and returns it to the anchor (or More).
 * Chips and More prevent the default mousedown: in WebKit (the Mac app) a click
 * on a button blurs the textarea even though the button never takes focus.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ICON_PIN, tierIcon } from '@/components/common/Icons';
import type { DraftDecisionChip } from './draft-decisions';
import type { DraftMenuCloseReason } from './DraftTaskMenu';

type OpenMode = 'mouse' | 'keyboard';

/** Data attribute that marks this bar's menu triggers for the outside closer. */
const OWNER_ATTR = 'data-draft-menu-owner';

interface MenuState { anchor: HTMLElement | null; mode: OpenMode }

export interface DraftDecisionMenu {
  anchor: HTMLElement | null;
  open: boolean;
  mode: OpenMode;
  menuRef: RefObject<HTMLDivElement | null>;
  /** Stamp every trigger with `{ [ownerAttr]: ownerId }`. */
  ownerId: string;
  focusNonce: number;
  openFrom: (el: HTMLElement, e?: { detail: number }) => void;
  close: (reason: DraftMenuCloseReason) => void;
  /** useMenuPlacement lost the anchor: hand the menu to More, else close. */
  onAnchorLost: () => void;
}

export const DRAFT_MENU_OWNER_ATTR = OWNER_ATTR;

export function useDraftDecisionMenu({ getComposer, composerText, openMenuNonce, moreRef }: {
  getComposer: () => HTMLTextAreaElement | null;
  composerText: string;
  openMenuNonce?: number;
  moreRef: RefObject<HTMLButtonElement | null>;
}): DraftDecisionMenu {
  const ownerId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<MenuState>({ anchor: null, mode: 'mouse' });
  // Mirrors `state` synchronously so a second close in the same tick is a no-op
  // and the document listeners never read a stale anchor.
  const stateRef = useRef(state);
  const [focusNonce, setFocusNonce] = useState(0);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const textRef = useRef(composerText);
  textRef.current = composerText;
  const textAtOpenRef = useRef(composerText);

  const commit = useCallback((next: MenuState) => { stateRef.current = next; setState(next); }, []);

  const focusComposer = useCallback(() => {
    const composer = getComposer();
    if (!composer) return;
    composer.focus({ preventScroll: true });
    const sel = selectionRef.current;
    if (sel) {
      try { composer.setSelectionRange(sel.start, sel.end); } catch { /* detached or not a text field */ }
    }
  }, [getComposer]);

  const restoreFocus = useCallback((mode: OpenMode, anchor: HTMLElement) => {
    if (mode === 'mouse') { focusComposer(); return; }
    const target = anchor.isConnected ? anchor : moreRef.current;
    target?.focus({ preventScroll: true });
  }, [focusComposer, moreRef]);

  const close = useCallback((reason: DraftMenuCloseReason) => {
    const cur = stateRef.current;
    if (!cur.anchor) return;
    const anchor = cur.anchor;
    commit({ anchor: null, mode: cur.mode });
    if (reason === 'select' || reason === 'escape' || reason === 'toggle') restoreFocus(cur.mode, anchor);
    else if (reason === 'outside') {
      // Only when the click landed on nothing focusable: never steal focus from
      // the field the user just clicked into.
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) restoreFocus(cur.mode, anchor);
      }, 0);
    }
  }, [commit, restoreFocus]);

  const openFrom = useCallback((el: HTMLElement, e?: { detail: number }) => {
    const cur = stateRef.current;
    if (cur.anchor === el) { close('toggle'); return; }
    const mode: OpenMode = e && e.detail > 0 ? 'mouse' : 'keyboard';
    if (!cur.anchor) {
      const composer = getComposer();
      selectionRef.current = composer
        ? { start: composer.selectionStart ?? 0, end: composer.selectionEnd ?? 0 }
        : null;
      textAtOpenRef.current = textRef.current;
    }
    commit({ anchor: el, mode });
    if (mode === 'keyboard') setFocusNonce((n) => n + 1);
  }, [close, commit, getComposer]);

  const onAnchorLost = useCallback(() => {
    const cur = stateRef.current;
    if (!cur.anchor) return;
    const more = moreRef.current;
    if (more && more.isConnected && more !== cur.anchor && more.offsetWidth > 0) commit({ anchor: more, mode: cur.mode });
    else close('anchor-lost');
  }, [close, commit, moreRef]);

  // A chip that a parse just removed was the anchor: detected right after the
  // commit that detached it, before paint.
  useLayoutEffect(() => {
    const a = stateRef.current.anchor;
    if (a && !a.isConnected) onAnchorLost();
  });

  // Typing is leaving the menu (C46): the first change of the text closes it.
  useEffect(() => {
    if (stateRef.current.anchor && composerText !== textAtOpenRef.current) close('typing');
  }, [composerText, close]);

  // Mod+. in the composer (the owner bumps the nonce): open from More in
  // keyboard mode, or move focus back into the menu when it is already there.
  const lastNonceRef = useRef(openMenuNonce);
  useEffect(() => {
    if (openMenuNonce === lastNonceRef.current) return;
    lastNonceRef.current = openMenuNonce;
    const more = moreRef.current;
    if (!more || !more.isConnected) return;
    if (stateRef.current.anchor === more) { setFocusNonce((n) => n + 1); return; }
    openFrom(more, { detail: 0 });
  }, [openMenuNonce, moreRef, openFrom]);

  const open = state.anchor !== null;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      // Any trigger of THIS bar: its own click re-anchors or toggles.
      if (t.closest?.(`[${OWNER_ATTR}="${ownerId}"]`)) return;
      // Child portals: the project flyout and a portalled date popover.
      if (t.closest?.('.task-kebab-project-flyout, .dp-popover')) return;
      close('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // One Escape closes one layer: the composer never sees this one.
      e.stopPropagation();
      close('escape');
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      const r = stateRef.current.anchor?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) close('scroll');
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, ownerId, close]);

  return {
    anchor: state.anchor, open, mode: state.mode, menuRef, ownerId, focusNonce,
    openFrom, close, onAnchorLost,
  };
}

function ChipGlyph({ chip }: { chip: DraftDecisionChip }) {
  const g = chip.glyph;
  if (!g) return null;
  if (g.kind === 'tier') {
    return (
      <span className="draft-decision-glyph" style={{ color: g.color }} aria-hidden="true">
        {g.tier ? tierIcon(g.tier) : ICON_PIN}
      </span>
    );
  }
  if (g.kind === 'priority') {
    // The space is a real text node so the chip reads "!! Immediate", the
    // same words as the menu's lit button (C36); flex layout ignores it.
    return (
      <>
        <span className="draft-decision-glyph draft-decision-glyph-priority" style={{ color: g.color }} aria-hidden="true">
          {g.icon}
        </span>{' '}
      </>
    );
  }
  return <span className="draft-decision-glyph" style={{ color: 'var(--accent)' }} aria-hidden="true">●</span>;
}

/**
 * The chip row above the folder/project pills. Not rendered when empty. Keyed by
 * field, so a value change rewrites the same node (no remove + insert, no
 * animation) while a newly decided field is inserted at its fixed position.
 */
export function DraftDecisionChips({ chips, menu }: { chips: readonly DraftDecisionChip[]; menu: DraftDecisionMenu }) {
  // Stagger index per chip, assigned ONLY in the commit that inserted it (C66):
  // several fields landing in one parse fade in one after another, while a chip
  // that was already there keeps its index and never re-animates.
  const staggerRef = useRef(new Map<string, number>());
  const stagger = staggerRef.current;
  const present = new Set(chips.map((c) => c.field));
  for (const key of [...stagger.keys()]) if (!present.has(key as DraftDecisionChip['field'])) stagger.delete(key);
  let inserted = 0;
  for (const c of chips) if (!stagger.has(c.field)) stagger.set(c.field, inserted++);

  if (!chips.length) return null;
  const anchor = menu.anchor;
  const activeField = anchor?.classList.contains('draft-decision-chip') ? anchor.dataset.field : undefined;
  return (
    <div className="draft-decision-row" role="group" aria-label="Task decisions">
      {chips.map((c) => {
        const active = activeField === c.field;
        const cls = ['draft-decision-chip'];
        if (c.ai) cls.push('draft-decision-chip-ai');
        if (active) cls.push('draft-decision-chip-active');
        if (c.overdue) cls.push('draft-decision-chip-overdue');
        if (c.removedTier) cls.push('draft-decision-chip-removed');
        const labelCls = `draft-decision-label${c.customTier ? ' draft-decision-label-custom' : ''}`;
        return (
          <button
            key={c.field}
            type="button"
            className={cls.join(' ')}
            data-field={c.field}
            {...{ [OWNER_ATTR]: menu.ownerId }}
            style={{ '--i': stagger.get(c.field) ?? 0 } as CSSProperties}
            title={c.title}
            aria-label={c.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => menu.openFrom(e.currentTarget, e)}
          >
            <ChipGlyph chip={c} />
            <span className={labelCls}>{c.label}</span>
            {c.ai && <span className="draft-ai-badge" aria-hidden="true">✦</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Platform label of the Mod+. shortcut the composer binds to this menu. */
function shortcutLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform) ? '⌘.' : 'Ctrl+.';
}

/** The More title (spec 5.3): no "priority" while the priority setting is off. */
export function draftMoreTitle(priorityVisible: boolean | 'unknown', shortcut = shortcutLabel()): string {
  return priorityVisible === true
    ? `Pin tier, dates, priority, start unread (${shortcut})`
    : `Pin tier, dates, start unread (${shortcut})`;
}

/**
 * The bar's "other settings" entry: a ghost button, rendered directly as the
 * last child of its row (no wrapper, the specs assert the button itself). It
 * never lights up for "has edits": the edits already show as chips.
 */
export function DraftMoreButton({ menu, moreRef, priorityVisible }: {
  menu: DraftDecisionMenu;
  moreRef: RefObject<HTMLButtonElement | null>;
  priorityVisible: boolean | 'unknown';
}) {
  const active = menu.anchor !== null && menu.anchor === moreRef.current;
  const title = useMemo(() => draftMoreTitle(priorityVisible), [priorityVisible]);
  return (
    <button
      ref={moreRef}
      type="button"
      className={`draft-more-btn${active ? ' draft-more-btn-active' : ''}`}
      {...{ [OWNER_ATTR]: menu.ownerId }}
      aria-label="Task settings"
      aria-haspopup="dialog"
      aria-expanded={active}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => menu.openFrom(e.currentTarget, e)}
    >
      More
    </button>
  );
}
