/**
 * The first-level pin choices of a task menu (2026-11-11, the user: "default only put the focus
 * satellite ... make them smoothly not super super lot of line", "remove the parked ... the vt we
 * can still keep as it is from plugin", "don't need unpin also, another click of the selected one
 * is unpin"). ONE row, always:
 *
 *   Pin to  [Focus] [Satellite] [VT ...]  More ▾      the chips scroll sideways, never wrap
 *
 * The chips are the user's shortcuts (pin-shortcuts.ts, kept with usePageView); every other
 * tier sits behind More, a portalled flyout (one portal, two views: the tiers, and Customize,
 * where each tier is switched on or off the row). Parked is offered nowhere here and there is
 * no Unpin choice: clicking the lit tier, on the row or in More, unpins. The menu's height
 * never changes because the user opened More, customized, or has many custom tiers.
 *
 * This file only draws and routes. What a pick DOES (the atomic, undoable pin write, and the
 * unpin of a lit tier) stays in TaskActionMenuItems, which hands it in as `onChoose`, so the
 * draft and batch menus keep their own legacy row with the same handler and the same button
 * (PinTierButton).
 *
 * The flyout reuses `.task-kebab-project-flyout`, which every host menu's outside-click, scroll
 * and keyboard closers already exempt. Its Escape is its own: a window capture listener runs
 * before the hosts' document capture listeners and stops there, so one Escape closes the flyout
 * and the menu stays.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { usePageView } from '@/utils/view-memory';
import {
  DEFAULT_PIN_SHORTCUTS, firstLevelPinChoices, isPinShortcutList, normalizePinShortcuts,
  pinMoreEntries, pinShortcutEntries, togglePinShortcut,
} from './pin-shortcuts';
import '@/styles/session-kebab-groups.css';

export interface PinChoice {
  value: string;
  label: string;
  icon: ReactNode;
  /** The tier's color (the chip's text and lit border). */
  color: string;
}

/** One tier button: the legacy Pin row (draft, batch) and the first-level row share it. */
export function PinTierButton({ choice, isCurrent, testId, onClick }: {
  choice: PinChoice;
  isCurrent: boolean;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={`task-kebab-tier-btn${isCurrent ? ' active' : ''}`}
      style={{ color: choice.color }}
      title={isCurrent ? `Unpin from ${choice.label}` : choice.label}
      aria-pressed={isCurrent || undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span className="task-kebab-tier-btn-icon">{choice.icon}</span>
      <span className="task-kebab-tier-btn-label">{choice.label}</span>
    </button>
  );
}

export function PinShortcutChoices({ choices, current, onChoose }: {
  /** Every tier, in menu order (built-ins, then custom and plugin tiers). Parked is dropped here. */
  choices: PinChoice[];
  /** The tier the task is pinned to; null when not pinned. */
  current: string | null;
  /** Pick a tier; `isCurrent` = the lit one, which unpins (the host's undoable write; it closes the menu). */
  onChoose: (value: string, isCurrent: boolean) => void;
}) {
  const [stored, setStored] = usePageView<string[]>('task-menu', 'pin-shortcuts', () => [...DEFAULT_PIN_SHORTCUTS], isPinShortcutList);
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setCustomizing(false); }, []);

  const all = firstLevelPinChoices(choices);
  const strip = pinShortcutEntries(stored, all);
  const more = pinMoreEntries(stored, all);
  const hiddenCurrent = current !== null ? more.find((c) => c.value === current) ?? null : null;
  // The row scrolls sideways, so a lit tier past its edge (a long plugin tier name, the third
  // shortcut on a phone) would show cut off: bring it fully into the row, without moving the menu.
  const stripRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = stripRef.current;
    const lit = row?.querySelector<HTMLElement>('.task-kebab-tier-btn.active');
    if (!row || !lit) return;
    const left = lit.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    const right = left + lit.getBoundingClientRect().width;
    if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
    else if (left < row.scrollLeft) row.scrollLeft = left;
  }, [current, strip.length]);

  return (
    <div className="task-pin-shortcuts" data-testid="kebab-group-pin">
      <span className="task-kebab-tier-label">Pin to</span>
      <div ref={stripRef} className="task-pin-strip task-kebab-tier-options" role="group" aria-label="Pin shortcuts">
        {strip.map((c) => (
          <PinTierButton
            key={c.value}
            choice={c}
            isCurrent={current === c.value}
            testId={`kebab-pin-${c.value}`}
            onClick={() => onChoose(c.value, current === c.value)}
          />
        ))}
      </div>
      <button
        ref={moreRef}
        type="button"
        className={`task-pin-more${open ? ' open' : ''}${hiddenCurrent ? ' has-current' : ''}`}
        data-testid="kebab-pin-more"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={hiddenCurrent ? `More pin choices (pinned to ${hiddenCurrent.label})` : 'More pin choices'}
        title={hiddenCurrent ? `More pin choices (pinned to ${hiddenCurrent.label})` : 'More pin choices'}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
      >
        {/* The dot's slot is always there, so the button keeps one width. */}
        <span className="task-pin-more-dot" aria-hidden="true" style={hiddenCurrent ? { background: hiddenCurrent.color } : undefined} />
        {/* A phone draws the caret alone, so Focus and Satellite both fit whole beside it. */}
        <span className="task-pin-more-text">More</span>
        <span className="task-pin-more-caret" aria-hidden="true">▾</span>
      </button>
      <PinMoreFlyout
        open={open}
        anchorRef={moreRef}
        customizing={customizing}
        setCustomizing={setCustomizing}
        more={more}
        all={all}
        stored={normalizePinShortcuts(stored)}
        current={current}
        onChoose={onChoose}
        onToggle={(value) => setStored((prev) => togglePinShortcut(prev, value))}
        onClose={close}
      />
    </div>
  );
}

function PinMoreFlyout({ open, anchorRef, customizing, setCustomizing, more, all, stored, current, onChoose, onToggle, onClose }: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  customizing: boolean;
  setCustomizing: (v: boolean) => void;
  /** The tiers not on the row. */
  more: PinChoice[];
  /** Every tier the first level offers, for Customize. */
  all: PinChoice[];
  stored: string[];
  current: string | null;
  onChoose: (value: string, isCurrent: boolean) => void;
  onToggle: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, ref, { minHeight: 120, onAnchorLost: onClose });

  useEffect(() => {
    if (!open) return;
    // Capture phase, so the host menu's own pointerdown guard cannot hide a click elsewhere in
    // it: that click closes the flyout, and the menu row still runs.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    // On window, capture: it runs before every host's document capture listener and stops there.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  // Keyboard users land on the first row once the flyout is placed, and again on a view switch.
  const placed = placement !== null;
  useEffect(() => {
    if (open && placed) ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open, placed, customizing]);

  if (!open || typeof document === 'undefined') return null;

  const body = customizing ? (
    <>
      <div className="task-pin-flyout-title">Show on the menu</div>
      {all.map((c) => {
        const shown = stored.includes(c.value);
        return (
          <button
            key={c.value}
            type="button"
            className={`task-kebab-project-opt task-pin-opt${shown ? ' active' : ''}`}
            data-testid={`kebab-pin-show-${c.value}`}
            aria-pressed={shown}
            title={shown ? `Hide ${c.label} from the menu` : `Show ${c.label} on the menu`}
            onClick={(e) => { e.stopPropagation(); onToggle(c.value); }}
          >
            <span className="task-pin-opt-icon" style={{ color: c.color }}>{c.icon}</span>
            <span className="task-kebab-project-opt-name">{c.label}</span>
          </button>
        );
      })}
      <div className="task-pin-flyout-sep" />
      <button
        type="button"
        className="task-kebab-project-opt task-pin-opt"
        data-testid="kebab-pin-customize-done"
        onClick={(e) => { e.stopPropagation(); setCustomizing(false); }}
      >
        <span className="task-kebab-project-opt-name">Done</span>
      </button>
    </>
  ) : (
    <>
      {more.map((c) => {
        const isCurrent = current === c.value;
        return (
          <button
            key={c.value}
            type="button"
            className={`task-kebab-project-opt task-pin-opt${isCurrent ? ' active' : ''}`}
            data-testid={`kebab-pin-option-${c.value}`}
            aria-pressed={isCurrent || undefined}
            title={isCurrent ? `Unpin from ${c.label}` : c.label}
            onClick={(e) => { e.stopPropagation(); onChoose(c.value, isCurrent); }}
          >
            <span className="task-pin-opt-icon" style={{ color: c.color }}>{c.icon}</span>
            <span className="task-kebab-project-opt-name">{c.label}</span>
          </button>
        );
      })}
      {more.length === 0 && <div className="task-kebab-project-empty">Every tier is on the menu</div>}
      <div className="task-pin-flyout-sep" />
      <button
        type="button"
        className="task-kebab-project-opt task-pin-opt"
        data-testid="kebab-pin-customize"
        onClick={(e) => { e.stopPropagation(); setCustomizing(true); }}
      >
        <span className="task-kebab-project-opt-name">Customize menu…</span>
      </button>
    </>
  );

  return createPortal(
    <div
      ref={ref}
      className="task-kebab-project-flyout task-pin-flyout"
      data-testid="task-pin-flyout"
      role="dialog"
      aria-label={customizing ? 'Choose the pin shortcuts' : 'More pin choices'}
      style={menuPlacementStyle(placement)}
      onClick={(e) => e.stopPropagation()}
      // Portal events bubble through the React tree to the sortable row: no drag from here.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {body}
    </div>,
    document.body,
  );
}
