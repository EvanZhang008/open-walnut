/**
 * DisplayViewsFlyout: the Display menu's "More views" list (spec 3.3, 6.5).
 *
 * Every view the user did not keep on the tab bar: the built-in tiers, the
 * custom tiers (unbounded, so never inline: web/src AGENTS.md menu rule 2),
 * Recent and Projects. Its own portal, placed by useMenuPlacement beside the
 * row that opened it (right side, left when there is no room), scrolling inside.
 * A pick switches the view and closes only this flyout; the Display menu stays.
 * Escape closes it first (it is the top overlay layer), and its root stops
 * pointerdown so dnd-kit never drags the task row behind.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHECK } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import type { TabBarTab } from './tab-bar-model';

export const DISPLAY_VIEWS_FLYOUT_CLASS = 'dm-views-flyout';
/** The flyout's top padding: its first row lines up with the row that opened it. */
const FLYOUT_PAD = 4;
/** Views that are not tiers: a divider sits above the first of them (F12). */
const NON_TIER_VIEWS: ReadonlySet<string> = new Set(['recent', 'tasks']);

export function DisplayViewsFlyout({ anchorRef, views, active, onPick, onClose }: {
  anchorRef: RefObject<HTMLElement | null>;
  views: readonly TabBarTab[];
  active: string;
  onPick(id: string): void;
  onClose(reason: 'escape' | 'outside' | 'pick'): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // F12: beside the Display menu (its right edge, not the row's), top level with
  // the row that opened it, so the flyout never covers the menu.
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const row = anchorRef.current;
    const menu = row?.closest('.dm-menu');
    if (!row || !menu) return;
    setPoint({ x: Math.round(menu.getBoundingClientRect().right + 4), y: Math.round(row.getBoundingClientRect().top - FLYOUT_PAD) });
  }, [anchorRef]);
  const placement = useMenuPlacement(true, anchorRef, ref, {
    align: 'left', gap: 0, minHeight: 120, anchorPoint: point, onAnchorLost: () => onClose('outside'),
  });
  useOverlayLayer({ open: true, refs: [ref, anchorRef], onClose });
  useLayoutEffect(() => {
    const rows = ref.current?.querySelectorAll<HTMLElement>('.dm-flyout-item');
    const current = ref.current?.querySelector<HTMLElement>('.dm-flyout-item[aria-checked="true"]');
    (current ?? rows?.[0])?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('.dm-flyout-item') ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1
      : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
  };
  return createPortal(
    <div
      ref={ref}
      className={`${DISPLAY_VIEWS_FLYOUT_CLASS} tp-pop`}
      role="menu"
      aria-label="More views"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {views.map((view, i) => [
        NON_TIER_VIEWS.has(view.id) && i > 0 && !NON_TIER_VIEWS.has(views[i - 1].id)
          ? <div key={`sep-${view.id}`} className="dm-flyout-sep" role="separator" />
          : null,
        <button
          key={view.id}
          type="button"
          role="menuitemradio"
          aria-checked={view.id === active}
          className="dm-flyout-item"
          data-view-option={view.id}
          title={view.title}
          tabIndex={-1}
          onClick={() => { onPick(view.id); onClose('pick'); }}
        >
          <span className="dm-check" aria-hidden="true">{view.id === active ? ICON_CHECK : null}</span>
          <span className="dm-view-label">{view.label}</span>
        </button>,
      ])}
    </div>,
    document.body,
  );
}
