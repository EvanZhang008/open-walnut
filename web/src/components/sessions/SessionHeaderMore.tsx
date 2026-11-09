/**
 * Where a narrow session header's hidden tool-row items go: the tool row's own
 * menu, never the title row's kebab (2026-10-03: window buttons in the task kebab
 * read as task actions and confused).
 *
 * `SessionHeaderMoreMenu` is the "..." chip on the tool row and its menu: one row
 * per hidden view chip (Changed, Files, Board, Terminal, Fork, a plugin fact
 * the user pinned to the header), then, after a divider, one per hidden window button (Open in new tab,
 * Minimize). Watch and Locate are no header buttons any more: they are rows of the kebab, by name
 * (2026-11-09, the user: "this 2 put iot in the drop down").
 *
 * Its rows proxy to the REAL element, which stays mounted under `data-hidden="true"`
 * (see useSessionHeaderFit.ts): a click on a row is `.click()` on it, and a
 * row's state (the open view, pinned or not) is read from its live attributes.
 * There is no second copy of any handler or label to drift.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { ICON_MINIMIZE, ICON_NEW_TAB } from '../common/Icons';
import { SLOT_ID_PREFIX, TOOL_ITEMS, toolItemSpec, useToolRowFit } from './useSessionHeaderFit';
import { TASK_SLOT_SPACER } from './header-record-gate';

// A synchronous fit must not recreate the composer's observers during resize delivery.
export function SessionHeaderToolRow({ rowRef, children }: {
  rowRef: RefObject<HTMLDivElement | null>;
  children: (fit: { hid: (id: string) => 'true' | 'false'; inMore: string[] }) => ReactNode;
}) {
  const fit = useToolRowFit(rowRef);
  return <div className="session-meta-row-2" ref={rowRef}>
    {children({ hid: (id) => fit.hidden.has(id) ? 'true' : 'false', inMore: fit.inMore })}
  </div>;
}

const itemOf = (row: HTMLElement | null, id: string) => row?.querySelector<HTMLElement>(`[data-header-id="${id}"]`) ?? null;

/** The row's name for an item: its own, or a pinned plugin fact's title. */
const nameOf = (row: HTMLElement | null, id: string) => toolItemSpec(id, itemOf(row, id))?.name ?? id;

/** Click the hidden item's own button (a wrapper's child, or the item itself). */
function activate(row: HTMLElement | null, id: string) {
  const el = itemOf(row, id);
  if (!el) return;
  const target = el.matches('button, [role="button"]') ? el : el.querySelector<HTMLElement>('button, [role="button"]') ?? el;
  target.click();
}

interface ItemState {
  /** The open view. */
  value: string;
  /** The real button's accessible name ("Find on Home" where the panel is not on Home). */
  label: string;
  /** The real button cannot be clicked (Fork on an engine without session forking), and why. */
  disabled: string | null;
}

/** What the hidden item currently says about itself. */
function stateOf(row: HTMLElement | null, id: string): ItemState {
  const el = itemOf(row, id);
  const none: ItemState = { value: '', label: '', disabled: null };
  if (!el) return none;
  const button = el.matches('button, [role="button"]') ? el : el.querySelector<HTMLElement>('button, [role="button"]') ?? el;
  const disabled = button instanceof HTMLButtonElement && button.disabled ? (button.title || 'Unavailable') : null;
  const label = button.getAttribute('aria-label') ?? '';
  let value = '';
  if (button.classList.contains('session-action-chip-active')) value = 'Open';
  // A pinned plugin fact's row shows what the chip says, so hiding it costs nothing: its
  // `data-header-value` when it gives one (the time pill's exact "You 2h 46m · Agent 8h 26m"
  // behind its "2h" and "8h"), else its text.
  else if (id.startsWith(SLOT_ID_PREFIX)) value = (button.dataset.headerValue || button.textContent || '').replace(/\s+/g, ' ').trim();
  return { value, label, disabled };
}

/** The live state of one hidden item, re-read whenever the item changes. */
function useItemState(rowRef: RefObject<HTMLElement | null>, id: string): ItemState {
  const [state, setState] = useState(() => stateOf(rowRef.current, id));
  useEffect(() => {
    const el = itemOf(rowRef.current, id);
    const read = () => setState(stateOf(rowRef.current, id));
    read();
    if (!el || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(el, { subtree: true, attributes: true, characterData: true, childList: true });
    return () => mo.disconnect();
  }, [rowRef, id]);
  return state;
}

interface MoreMenuProps {
  /** `.session-meta-row-2`, where the hidden items live. */
  rowRef: RefObject<HTMLElement | null>;
  /** Hidden chip and window button ids, in row order. Renders nothing when empty. */
  ids: string[];
  /** Ids on the row only as spacers (taskControlSlot in header-record-gate.ts): folded
   *  like the rest, but never a row of the menu nor part of its count. */
  spacerIds?: ReadonlySet<string>;
}

export function SessionHeaderMoreMenu({ rowRef, ids: folded, spacerIds }: MoreMenuProps) {
  const ids = spacerIds ? folded.filter((id) => !spacerIds.has(id)) : folded;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Changed folded in here and open lights the "···" chip.
  const changed = useItemState(rowRef, 'changed');
  const placement = useMenuPlacement(open, buttonRef, menuRef, {
    align: 'left', preferSide: 'down', minHeight: 100, onAnchorLost: () => setOpen(false),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node | null;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Keyboard: focus lands on the first row, arrows move, Escape returns to the
    // chip. The hidden chips left the tab order with their display, so this menu
    // is the keyboard's only way to them.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The menu lists what is hidden; when the row widens and nothing is, it goes.
  useEffect(() => { if (ids.length === 0) setOpen(false); }, [ids.length]);

  const choose = useCallback((id: string) => {
    setOpen(false);
    activate(rowRef.current, id);
  }, [rowRef]);

  if (folded.length === 0) return null;
  // Only spacers are folded: the chip keeps its place for the row's sake (the fit
  // counted it), as one more spacer.
  if (ids.length === 0) {
    return (
      <button type="button" className="session-action-chip session-header-more-btn" data-header-more="true" {...TASK_SLOT_SPACER}>
        <span aria-hidden="true">···</span>
      </button>
    );
  }
  const views = ids.filter((id) => TOOL_ITEMS[id]?.kind !== 'window');
  const windows = ids.filter((id) => TOOL_ITEMS[id]?.kind === 'window');
  const label = (id: string) => nameOf(rowRef.current, id);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // Changed folded in here and open: "..." reads as the open view's chip.
        className={`session-action-chip session-header-more-btn${open || (ids.includes('changed') && changed.value === 'Open') ? ' session-action-chip-active' : ''}`}
        data-header-more="true"
        data-testid="session-header-more-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More (${ids.length})`}
        title={`More: ${ids.map(label).join(', ')}`}
      >
        <span aria-hidden="true">···</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu session-header-more-menu"
          role="menu"
          style={menuPlacementStyle(placement)}
          // A portal escapes clipping, not bubbling: the header's own handlers
          // (its context menu, the column's drag) must not see these clicks.
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="session-header-more-menu"
        >
          {views.map((id) => <MoreRow key={id} id={id} rowRef={rowRef} onChoose={choose} />)}
          {views.length > 0 && windows.length > 0 && <div className="task-kebab-divider" />}
          {windows.map((id) => <WindowRow key={id} id={id} rowRef={rowRef} onChoose={choose} />)}
        </div>,
        document.body,
      )}
    </>
  );
}

function MoreRow({ id, rowRef, onChoose }: { id: string; rowRef: RefObject<HTMLElement | null>; onChoose: (id: string) => void }) {
  const { value, disabled } = useItemState(rowRef, id);
  const name = nameOf(rowRef.current, id);
  return (
    <button
      type="button"
      className="task-kebab-item"
      role="menuitem"
      // A disabled chip (Fork on an engine without session forking, Fork or Board
      // while the session record loads) stays a disabled row, with the chip's own
      // reason as its hover text.
      disabled={!!disabled}
      title={disabled ?? undefined}
      onClick={(e) => { e.stopPropagation(); onChoose(id); }}
      data-testid={`session-header-more-item-${id}`}
      data-state={value || undefined}
    >
      <span className="session-header-more-name">{name}</span>
      {value && <span className="session-header-more-value">{value}</span>}
    </button>
  );
}

/** A hidden window button's row in the "..." menu, with the button's icon and its live label. */
function WindowRow({ id, rowRef, onChoose }: { id: string; rowRef: RefObject<HTMLElement | null>; onChoose: (id: string) => void }) {
  const { value, label: ariaLabel, disabled } = useItemState(rowRef, id);
  const label = TOOL_ITEMS[id]?.name ?? ariaLabel ?? id;
  return (
    <button
      type="button"
      className="task-kebab-item"
      role="menuitem"
      disabled={!!disabled}
      title={disabled ?? undefined}
      onClick={(e) => { e.stopPropagation(); onChoose(id); }}
      data-testid={`session-header-more-item-${id}`}
      data-state={value || undefined}
    >
      <span className="task-kebab-icon" aria-hidden="true">{WINDOW_ICONS[id] ?? null}</span>
      <span className="session-header-more-name">{label}</span>
    </button>
  );
}

const WINDOW_ICONS: Record<string, ReactNode> = { popout: ICON_NEW_TAB, minimize: ICON_MINIMIZE };
