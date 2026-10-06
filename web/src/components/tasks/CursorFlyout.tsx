/**
 * The picker a context-menu SETTING row opens.
 *
 * The context menu has already closed by the time a setting's picker shows (running a row closes
 * it), so there is no element left to hang the picker on. It anchors at the viewport point the
 * right-click landed on instead, and {@link useCursorFlyout} owns the state that outlives the menu:
 * the target the menu was opened for, the point, and the dismissals (Escape, a press outside, any
 * scroll, a resize). Both the folder menu's Project row and the project menu's Sort row use it, so
 * the two cannot drift.
 *
 * {@link OptionPickerFlyout} is the short-list picker (Sort). It wears the project flyout's classes
 * on purpose: the outside-press and scroll closers everywhere already exempt
 * `.task-kebab-project-flyout`, and one look across every picker a menu can open.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

export interface CursorPoint { x: number; y: number }

export interface CursorFlyoutHandle<T> {
  /** The open picker's target and anchor, or null. The point is stable while open (it is state). */
  state: { payload: T; point: CursorPoint } | null;
  open: (payload: T, point: CursorPoint) => void;
  close: () => void;
  /** `useMenuPlacement` wants a trigger ref; a cursor anchor has none, so this stays empty by design. */
  noTrigger: RefObject<HTMLElement | null>;
}

const insideFlyout = (target: EventTarget | null) =>
  !!(target as HTMLElement | null)?.closest?.('.task-kebab-project-flyout');

export function useCursorFlyout<T>(): CursorFlyoutHandle<T> {
  const [state, setState] = useState<{ payload: T; point: CursorPoint } | null>(null);
  const noTrigger = useRef<HTMLElement | null>(null);
  const picking = state !== null;

  // The picker outlives the menu that opened it, so it owns its own dismissal. A scroll closes it
  // outright: a cursor anchor is a frozen viewport point.
  useEffect(() => {
    if (!picking) return;
    const close = () => setState(null);
    const onDown = (e: MouseEvent) => { if (!insideFlyout(e.target)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const onScroll = (e: Event) => { if (!insideFlyout(e.target)) close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [picking]);

  return {
    state,
    open: (payload, point) => setState({ payload, point }),
    close: () => setState(null),
    noTrigger,
  };
}

export interface FlyoutOption<V extends string> { value: V; label: string }

/** A short, fixed list (no filter box): the current option carries a check and holds the focus. */
export function OptionPickerFlyout<V extends string>({ anchorPoint, anchorRef, options, current, ariaLabel, onPick, onClose }: {
  anchorPoint: CursorPoint;
  anchorRef: RefObject<HTMLElement | null>;
  options: ReadonlyArray<FlyoutOption<V>>;
  current: V | undefined;
  ariaLabel: string;
  onPick: (value: V) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(true, anchorRef, listRef, {
    minHeight: 120,
    anchorPoint,
    align: 'left',
    onAnchorLost: onClose,
  });
  // Keyboard reaches the list the way it reached the row: focus lands on the current option, the
  // arrows walk the rest. Without it the menu's close dropped focus on <body> and the picker it had
  // just opened was unreachable without a mouse.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    (list.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.querySelector<HTMLElement>('button'))
      ?.focus({ preventScroll: true });
  }, [placement !== null]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };
  return createPortal(
    <div
      ref={listRef}
      className="task-kebab-project-flyout"
      role="listbox"
      aria-label={ariaLabel}
      style={menuPlacementStyle(placement)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      // Portal events bubble through the React tree into the sortable row's drag sensors.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={current === option.value}
          data-option={option.value}
          className={`task-kebab-project-opt${current === option.value ? ' active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            // Re-picking the current option is a dismiss, not a write.
            if (option.value !== current) onPick(option.value);
            onClose();
          }}
        >
          <span className="task-kebab-project-check">{current === option.value ? '✓' : ''}</span>
          <span className="task-kebab-project-opt-name">{option.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
