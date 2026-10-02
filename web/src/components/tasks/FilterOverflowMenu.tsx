/**
 * FilterOverflowMenu: one filter-row chip (`FilterChipView`, shared by the
 * row and this menu) and the small portalled `.fb-overflow-menu` that lists
 * the chips the row's two lines could not hold (spec 5.4, G33). Every row in
 * the menu behaves like the row's chip: the body opens the chip menu, the x
 * removes the filter.
 */
import { useRef, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHEVRON_DOWN, ICON_CLOSE } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer, type OverlayCloseReason } from '@/hooks/useOverlayLayer';
import { MISSING_VALUE_TITLE } from './filter-bar-model';
import type { FilterChip, FilterDim } from './filter-bar-types';

export type RemoveHow = 'pointer' | 'keyboard';

/** Blocked and Time window chips show only the value (G26). */
export function chipShowsDim(dim: FilterDim): boolean {
  return dim !== 'blocked' && dim !== 'time';
}

export function chipFullText(chip: FilterChip): string {
  return `${chip.label}: ${chip.value}`;
}

export interface FilterChipViewProps {
  chip: FilterChip;
  menuOpen: boolean;
  onOpenMenu(anchor: HTMLElement): void;
  onRemove(how: RemoveHow): void;
}

export function FilterChipView({ chip, menuOpen, onOpenMenu, onRemove }: FilterChipViewProps) {
  const bodyRef = useRef<HTMLButtonElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();
    e.stopPropagation();
    onRemove('keyboard');
  };
  const full = chipFullText(chip);
  return (
    <div className="fb-chip" data-chip-dim={chip.dim}>
      <button
        ref={bodyRef}
        type="button"
        className="fb-chip-body"
        // Explicit tab stop: WebKit skips plain buttons on Tab (F09).
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${full}, change`}
        title={chip.missing ? MISSING_VALUE_TITLE : `${chip.label}: ${chip.title}`}
        onClick={() => { if (bodyRef.current) onOpenMenu(bodyRef.current); }}
        onKeyDown={onKey}
      >
        {chipShowsDim(chip.dim) && <span className="fb-chip-dim">{`${chip.label}: `}</span>}
        <span className={`fb-chip-val${chip.missing ? ' is-missing' : ''}`} title={chip.title}>{chip.value}</span>
        <span className="fb-chip-caret" aria-hidden="true">{ICON_CHEVRON_DOWN}</span>
      </button>
      <button
        type="button"
        className="fb-chip-x"
        tabIndex={0}
        aria-label={`Remove ${chip.label} filter`}
        title="Remove"
        onClick={(e) => onRemove(e.detail > 0 ? 'pointer' : 'keyboard')}
        onKeyDown={onKey}
      >
        {ICON_CLOSE}
      </button>
    </div>
  );
}

export interface FilterOverflowMenuProps {
  anchorRef: RefObject<HTMLElement | null>;
  chips: readonly FilterChip[];
  chipMenuDim: FilterDim | null;
  onOpenChipMenu(dim: FilterDim, anchor: HTMLElement): void;
  onRemove(chip: FilterChip, how: RemoveHow): void;
  onClose(reason: OverlayCloseReason): void;
}

export function FilterOverflowMenu({ anchorRef, chips, chipMenuDim, onOpenChipMenu, onRemove, onClose }: FilterOverflowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(true, anchorRef, ref, { align: 'start', minHeight: 80, onAnchorLost: () => onClose('outside') });
  useOverlayLayer({
    open: true,
    refs: [ref, anchorRef],
    exemptSelectors: ['.fb-chip-menu'],
    onClose: (reason) => {
      onClose(reason);
      if (reason === 'escape') anchorRef.current?.focus({ preventScroll: true });
    },
  });
  return createPortal(
    <div
      ref={ref}
      className="fb-overflow-menu tp-pop"
      role="dialog"
      aria-label="More active filters"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {chips.map((chip) => (
        <FilterChipView
          key={chip.dim}
          chip={chip}
          menuOpen={chipMenuDim === chip.dim}
          onOpenMenu={(anchor) => onOpenChipMenu(chip.dim, anchor)}
          onRemove={(how) => onRemove(chip, how)}
        />
      ))}
    </div>,
    document.body,
  );
}
