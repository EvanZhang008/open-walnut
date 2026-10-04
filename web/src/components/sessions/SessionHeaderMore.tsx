/**
 * Where a narrow session header's hidden items go. Each row keeps its own: the
 * tool row's overflow stays on the tool row, the title row's on the title row
 * (2026-10-03: window buttons in the task kebab read as task actions and confused).
 *
 * `SessionHeaderMoreMenu` is the "..." chip on the tool row and its menu: one row
 * per hidden view chip (Changed, Files, Board, Terminal, Fork, the heavy pill),
 * then, after a divider, one per hidden window button (Open in new tab,
 * Locate task). `HiddenPillRows` is the kebab's leading section: one row per
 * title-row pill that did not fit even as a letter.
 *
 * Both proxy to the REAL element, which stays mounted under `data-hidden="true"`
 * (see useSessionHeaderFit.ts): a click on a row is `.click()` on it, and a
 * row's state (the open view, pinned or not) is read from its live attributes.
 * There is no second copy of any handler or label to drift.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { ICON_LOCATE, ICON_NEW_TAB } from '../common/Icons';
import { TOOL_ITEMS } from './useSessionHeaderFit';
import { TITLE_PILL_SELECTOR } from './session-header-fit';

const itemOf = (row: HTMLElement | null, id: string) => row?.querySelector<HTMLElement>(`[data-header-id="${id}"]`) ?? null;

/** Click the hidden item's own button (a wrapper's child, or the item itself). */
function activate(row: HTMLElement | null, id: string) {
  const el = itemOf(row, id);
  if (!el) return;
  const target = el.matches('button, [role="button"]') ? el : el.querySelector<HTMLElement>('button, [role="button"]') ?? el;
  target.click();
}

interface ItemState {
  /** The open view, the heavy pill's number. */
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
  else if (id === 'resources') value = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
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
}

export function SessionHeaderMoreMenu({ rowRef, ids }: MoreMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
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

  if (ids.length === 0) return null;
  const views = ids.filter((id) => TOOL_ITEMS[id]?.kind !== 'window');
  const windows = ids.filter((id) => TOOL_ITEMS[id]?.kind === 'window');
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`session-action-chip session-header-more-btn${open ? ' session-action-chip-active' : ''}`}
        data-header-more="true"
        data-testid="session-header-more-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More (${ids.length})`}
        title={`More: ${ids.map((id) => TOOL_ITEMS[id]?.name ?? id).join(', ')}`}
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
  const name = TOOL_ITEMS[id]?.name ?? id;
  // The heavy pill has nothing to click; its row is the number, not an action.
  const info = id === 'resources';
  return (
    <button
      type="button"
      className={`task-kebab-item${info ? ' task-kebab-info' : ''}`}
      role="menuitem"
      // A disabled chip (Fork on an engine without session forking) stays a
      // disabled row, with the chip's own reason as its hover text.
      disabled={!!disabled}
      title={disabled ?? undefined}
      onClick={(e) => { e.stopPropagation(); if (!info) onChoose(id); }}
      data-testid={`session-header-more-item-${id}`}
      data-state={value || undefined}
    >
      <span className="session-header-more-name">{info ? `${name}: ${value}` : name}</span>
      {!info && value && <span className="session-header-more-value">{value}</span>}
    </button>
  );
}

/** A hidden window button's row in the "..." menu, with the button's icon and its live label. */
function WindowRow({ id, rowRef, onChoose }: { id: string; rowRef: RefObject<HTMLElement | null>; onChoose: (id: string) => void }) {
  const { value, label: ariaLabel } = useItemState(rowRef, id);
  // Locate reads as the real button does ("Find on Home" off the home page).
  const label = id === 'locate' && ariaLabel ? ariaLabel : TOOL_ITEMS[id]?.name ?? id;
  return (
    <button
      type="button"
      className="task-kebab-item"
      role="menuitem"
      onClick={(e) => { e.stopPropagation(); onChoose(id); }}
      data-testid={`session-header-more-item-${id}`}
      data-state={value || undefined}
    >
      <span className="task-kebab-icon" aria-hidden="true">{WINDOW_ICONS[id] ?? null}</span>
      <span className="session-header-more-name">{label}</span>
    </button>
  );
}

const WINDOW_ICONS: Record<string, ReactNode> = { locate: ICON_LOCATE, popout: ICON_NEW_TAB };

interface HiddenPillRowsProps {
  /** `.session-panel-title-meta`, where the pills live. */
  metaRef: RefObject<HTMLElement | null>;
  /** Pill kinds hidden because even their letters did not fit, in row order. */
  kinds: string[];
  /** Keeps a kind's pill on the row so its flyout has an anchor. */
  pin: (kind: string) => void;
  onAfterAction?: () => void;
}

/** Kebab rows for the pills the title row had no room for, even as letters. */
export function HiddenPillRows({ metaRef, kinds, pin, onAfterAction }: HiddenPillRowsProps) {
  if (kinds.length === 0) return null;
  return (
    <>
      {kinds.map((kind) => <PillRow key={kind} kind={kind} metaRef={metaRef} pin={pin} onAfterAction={onAfterAction} />)}
      <div className="task-kebab-divider" />
    </>
  );
}

const PILL_ROW_NAMES: Record<string, string> = { embedded: 'Embedded', cron: 'Cron', trigger: 'Trigger', worker: 'Worker', leader: 'Leader' };

function PillRow({ kind, metaRef, pin, onAfterAction }: { kind: string; metaRef: RefObject<HTMLElement | null>; pin: (kind: string) => void; onAfterAction?: () => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const el = metaRef.current?.querySelector<HTMLElement>(TITLE_PILL_SELECTOR[kind] ?? `[data-header-pill="${kind}"]`);
    if (!el) return;
    const read = () => setText((el.textContent ?? '').replace(/\s+/g, ' ').trim());
    read();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(el, { subtree: true, characterData: true, childList: true });
    return () => mo.disconnect();
  }, [metaRef, kind]);
  const name = PILL_ROW_NAMES[kind] ?? kind;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const value = text && norm(text) !== norm(name) ? text : '';
  // The Embedded badge is not clickable; its row is a fact, not an action.
  const info = kind === 'embedded';
  return (
    <button
      type="button"
      className={`task-kebab-item${info ? ' task-kebab-info' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (info) return;
        onAfterAction?.();
        // The pill comes back onto the row first (its flyout anchors to it), then
        // takes the click on the next frame, once it has a box.
        pin(kind);
        const sel = TITLE_PILL_SELECTOR[kind] ?? `[data-header-pill="${kind}"]`;
        requestAnimationFrame(() => requestAnimationFrame(() => metaRef.current?.querySelector<HTMLElement>(sel)?.click()));
      }}
      data-testid={`session-header-kebab-pill-${kind}`}
    >
      <span className="session-header-more-name">{name}</span>
      {value && <span className="session-header-more-value">{value}</span>}
    </button>
  );
}
