/**
 * DraftTaskMenuPopover: the ONE settings menu of a draft column's launch bar,
 * opened from the bar's More button or from any decision chip above it
 * (DraftDecisionRow owns the anchor, the open mode and the focus rules). It
 * edits the task the launch will create (pin tier, priority, start / due, start
 * unread) before anything exists server-side.
 *
 * History: until 2026-09-24 this was a "⋮" in the draft HEADER. Walnut's own
 * decisions (the background parse) then became visible chips next to the folder
 * and project pills, and a menu in another corner of the column read as a
 * second, unrelated place; so the menu now opens from the chip being questioned.
 *
 * Same rows as the board's task kebab (TaskActionMenuItems, one definition),
 * with the draft's opt-in props: icon + label priority buttons (the chip's own
 * words), a lit tier or priority that ACCEPTS on click instead of unpinning, a
 * trailing "Don't pin", "Use Walnut's pick" rows, and the chip's date format.
 * Every edit is one per-field patch (DraftTaskFieldPatch): the owner marks that
 * field the user's and never touches `metaTouched`.
 *
 * Menus rules (web/src/AGENTS.md): portalled to <body>, placed by
 * useMenuPlacement (upward, like the folder picker and project flyout beside it),
 * root pointerdown stopped so the strip's column drag never starts, no native
 * select. The inline calendars grow the menu: the clicked date row stays where
 * it was and the menu grows down from its top, capped to the viewport (C25b).
 */

import { useEffect, useLayoutEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { TaskPriority } from '@open-walnut/core';
import { TaskActionMenuItems } from '@/components/tasks/TaskKebabMenu';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import type { QuickStartTaskMeta } from './SessionPathSelector';
import type { DraftTaskField, DraftTaskFieldPatch } from './draft-column';
import { formatDraftDate } from './draft-decisions';

/** Why the menu closed: DraftDecisionRow picks where focus goes from it. */
export type DraftMenuCloseReason =
  | 'select' | 'escape' | 'outside' | 'toggle' | 'scroll' | 'typing' | 'anchor-lost';

interface Props {
  open: boolean;
  /** The chip or More button the menu hangs from. Changing it re-anchors the
   *  open menu in place (no close, no remount). */
  anchorEl: HTMLElement | null;
  /** Owned by DraftDecisionRow: its outside-click closer tests against it. */
  menuRef: RefObject<HTMLDivElement | null>;
  meta: QuickStartTaskMeta;
  /** The row shows a tier chip (the tier is decided). False: nothing is lit and
   *  the heading says which tier an undecided draft lands in. */
  tierDecided: boolean;
  priorityVisible: boolean | 'unknown';
  /** Fields offering "Use Walnut's pick", with the label to show. */
  walnutPicks?: Partial<Record<DraftTaskField, string>>;
  onChange: (patch: DraftTaskFieldPatch) => void;
  onReturnToWalnut?: (field: DraftTaskField) => void;
  onClose: (reason: DraftMenuCloseReason) => void;
  /** The anchor stopped being placeable (useMenuPlacement onAnchorLost). */
  onAnchorLost: () => void;
  /** Bumped on every keyboard open: focus moves into the tier row. */
  focusNonce: number;
}

export function DraftTaskMenuPopover({
  open, anchorEl, menuRef, meta, tierDecided, priorityVisible, walnutPicks,
  onChange, onReturnToWalnut, onClose, onAnchorLost, focusNonce,
}: Props) {
  // A fresh ref OBJECT per anchor: useMenuPlacement re-places (and re-decides
  // the side) when its ref identity changes, so a re-anchor moves the open menu.
  const anchorRef = useMemo(() => ({ current: anchorEl }), [anchorEl]);
  // Left edge on the anchor, clamped (not flipped) at the viewport's right edge,
  // like the engine settings popover from the same composer: the menu stays over
  // THIS column instead of spilling left across the task list.
  const pos = useMenuPlacement(open && !!anchorEl, anchorRef, menuRef, {
    onAnchorLost, preferSide: 'up', align: 'start', edgeOverflow: 'clamp',
  });
  const placed = pos !== null;

  // Placed upward, the menu's bottom edge sits on its anchor, so an inline
  // calendar growing the menu would push the clicked Start / Due row up by the
  // calendar's height. Once a date row is clicked the menu keeps the TOP it had
  // then and grows down over the anchor, capped to the viewport and scrolling
  // inside: the row stays put and its calendar opens right under it (C25b).
  const [frozenTop, setFrozenTop] = useState<number | null>(null);
  useEffect(() => { setFrozenTop(null); }, [open, anchorEl]);
  const onClickCapture = (e: ReactMouseEvent) => {
    const toggle = (e.target as Element).closest?.('.task-kebab-date-toggle');
    const menu = menuRef.current;
    if (!toggle || !menu || frozenTop !== null) return;
    setFrozenTop(menu.getBoundingClientRect().top);
  };
  // Reveal the opened calendar, but never by more than the row's own height:
  // the row the user just clicked must not run away from the pointer.
  useLayoutEffect(() => {
    if (frozenTop === null) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const menu = menuRef.current;
        const block = menu?.querySelector<HTMLElement>('.task-kebab-date.open');
        const row = block?.querySelector<HTMLElement>('.task-kebab-date-toggle');
        if (!menu || !block || !row) return;
        const over = block.getBoundingClientRect().bottom - menu.getBoundingClientRect().bottom;
        if (over > 0) menu.scrollTop += Math.min(over, row.offsetHeight - 2);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [frozenTop, menuRef]);
  const style = menuPlacementStyle(pos);
  if (pos && frozenTop !== null) {
    style.top = frozenTop;
    style.maxHeight = Math.max(window.innerHeight - frozenTop - 8, 48);
  }

  // Keyboard open: focus the lit tier, else the first tier (C40). Waits for the
  // first measured placement so focus never lands on the off-screen shell.
  useEffect(() => {
    if (!open || !placed || !focusNonce) return;
    const menu = menuRef.current;
    const target = menu?.querySelector<HTMLElement>('.task-kebab-tier-btn.active')
      ?? menu?.querySelector<HTMLElement>('.task-kebab-tier-btn');
    target?.focus({ preventScroll: true });
  }, [open, placed, focusNonce, menuRef]);

  const walnutPick = useMemo(() => {
    if (!walnutPicks || !onReturnToWalnut) return undefined;
    const out: Partial<Record<DraftTaskField, { label: string; onPick: () => void }>> = {};
    for (const [field, label] of Object.entries(walnutPicks) as [DraftTaskField, string][]) {
      out[field] = { label, onPick: () => onReturnToWalnut(field) };
    }
    return out;
  }, [walnutPicks, onReturnToWalnut]);

  if (!open || !anchorEl) return null;
  const hasTier = tierDecided && !!meta.pinTier;
  return createPortal(
    <div
      ref={menuRef}
      className="task-kebab-menu draft-task-menu"
      data-testid="draft-task-menu"
      role="dialog"
      aria-label="Task settings"
      style={style}
      onClickCapture={onClickCapture}
      // The strip's columns are reorderable; a pointerdown inside this portal
      // still bubbles through React's tree to the column, so kill it here.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="task-kebab-item task-kebab-info draft-task-menu-title" aria-hidden="true">
        <span>The task this launch creates</span>
      </div>
      <TaskActionMenuItems
        task={{
          priority: (meta.priority ?? 'none') as TaskPriority,
          start_date: meta.startDate,
          due_date: meta.dueDate,
        }}
        // Undecided (no tier chip): nothing lit, even though the launch meta
        // holds the default Focus; the heading says so instead (C65).
        isPinned={hasTier}
        pinnedTier={tierDecided ? (meta.pinTier ?? null) : undefined}
        isDone={false}
        tierHeading={tierDecided ? undefined : 'Pin to (default Focus)'}
        // One synchronous patch per pick: the tier rides the create, never the
        // row kebab's pin + delayed tier.
        onPinWithTier={(tier) => onChange({ pinTier: tier })}
        onUnpinTask={() => onChange({ pinTier: undefined })}
        onSetTier={(tier) => onChange({ pinTier: tier })}
        onSetPriority={priorityVisible === true
          ? (p) => onChange({ priority: p as QuickStartTaskMeta['priority'] })
          : undefined}
        onSetStartDate={(date) => onChange({ startDate: date ?? undefined })}
        onSetDate={(date) => onChange({ dueDate: date ?? undefined })}
        afterAction={() => onClose('select')}
        formatDate={(iso) => formatDraftDate(iso)}
        showPriorityLabels
        litClickAccepts
        walnutPick={walnutPick}
      />
      <div className="task-kebab-divider" />
      <button
        type="button"
        className={`task-kebab-item draft-task-menu-unread${meta.unread ? ' task-kebab-item-active' : ''}`}
        aria-pressed={!!meta.unread}
        title="Start this task marked unread"
        // Toggles in place; the menu stays open (C42).
        onClick={(e) => { e.stopPropagation(); onChange({ unread: !meta.unread }); }}
      >
        <span className="task-kebab-icon">●</span>
        <span>Start unread</span>
      </button>
    </div>,
    document.body,
  );
}
