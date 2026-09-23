/**
 * DraftTaskMenu — the "⋮" in a DRAFT column's header: the task settings the
 * launch will create the task with (pin tier, priority, start / due dates,
 * start-unread), edited on the draft's launch meta before anything exists
 * server-side.
 *
 * Why it exists: the draft column lost its always-visible tier row on
 * 2026-09-15 (a segmented Focus / Satellite / Backlog / Wait control plus a More
 * menu was "complicated for people" on a surface whose job is "type, start").
 * That left ONE way to set a tier before launching: open the folder picker and
 * use its footer. The user then asked for the same ⋮ every task row has — the
 * settings stay one click away without a row of controls on the default view.
 *
 * Same rows as the board's task kebab (TaskActionMenuItems, one definition), so
 * a tier picked here looks and lands exactly like one picked on a task row. A
 * BOUND draft (task-row ▶) does not use this: its task already exists, so the
 * header renders the real task's kebab (TaskQuickActions) and every edit is a
 * live write to that task.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TaskPriority } from '@open-walnut/core';
import { TaskActionMenuItems } from '@/components/tasks/TaskKebabMenu';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { DEFAULT_META } from './task-meta-constants';
import type { QuickStartTaskMeta } from './SessionPathSelector';

interface Props {
  meta: QuickStartTaskMeta;
  /** Updater form, like every other meta edit on the draft — rapid clicks fold
   *  onto the freshest row instead of a props snapshot. */
  onMetaChange: (updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => void;
}

/** True when any setting this menu draws differs from a fresh launcher's
 *  defaults — the trigger lights up so the user can see a draft carries edits. */
export function draftMetaEdited(meta: QuickStartTaskMeta): boolean {
  return meta.pinTier !== DEFAULT_META.pinTier
    || !!meta.unread !== !!DEFAULT_META.unread
    || (meta.priority ?? 'none') !== (DEFAULT_META.priority ?? 'none')
    || !!meta.startDate || !!meta.dueDate;
}

export function DraftTaskMenu({ meta, onMetaChange }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Measured placement, portalled to <body>: the draft header is a stacking
  // context (same as a real session panel's), so an in-place menu would paint
  // under the composer overlay — see TaskQuickActions for the history.
  const pos = useMenuPlacement(open, btnRef, menuRef, { onAnchorLost: close });

  // Dismissal rules mirror TaskQuickActions: outside mousedown, Escape, and an
  // outside scroll only once the trigger leaves the viewport (the menu's own
  // scroll never closes it). The date rows are INLINE calendars, so there is no
  // portalled picker to exempt here.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      const r = btnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) close();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, close]);

  // `undefined` pinTier is "don't pin" on the client (launchQuickStart sends it
  // as the explicit null the server needs) — the menu shows it as no lit tier.
  const edited = draftMetaEdited(meta);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`task-kebab-btn draft-task-menu-btn${edited ? ' active' : ''}`}
        // The row kebab is hover-revealed (opacity 0 at rest); a header control
        // has no row to hover, so it is always visible — as in the session header.
        style={{ opacity: 1, ...(edited ? { color: 'var(--accent)' } : {}) }}
        aria-label="Task settings"
        aria-expanded={open}
        title="Task settings — pin tier, dates, priority"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        ⋮
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu draft-task-menu"
          data-testid="draft-task-menu"
          style={menuPlacementStyle(pos)}
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
            isPinned={!!meta.pinTier}
            pinnedTier={meta.pinTier}
            isDone={false}
            // Picking a tier IS the pin on a draft: the tier rides the create
            // (`focus_tier` + `pinned`), so it is one synchronous meta write —
            // never the row kebab's pin + delayed tier, whose second half could
            // land after a quick Start had already launched the old meta.
            onPinWithTier={(tier) => onMetaChange((m) => ({ ...m, pinTier: tier }))}
            onUnpinTask={() => onMetaChange((m) => ({ ...m, pinTier: undefined }))}
            onSetTier={(tier) => onMetaChange((m) => ({ ...m, pinTier: tier }))}
            onSetPriority={(p) => onMetaChange((m) => ({ ...m, priority: p as QuickStartTaskMeta['priority'] }))}
            onSetStartDate={(date) => onMetaChange((m) => ({ ...m, startDate: date ?? undefined }))}
            onSetDate={(date) => onMetaChange((m) => ({ ...m, dueDate: date ?? undefined }))}
            afterAction={close}
          />
          <div className="task-kebab-divider" />
          <button
            type="button"
            className={`task-kebab-item${meta.unread ? ' task-kebab-item-active' : ''}`}
            aria-pressed={!!meta.unread}
            title="Start this task marked unread"
            onClick={(e) => { e.stopPropagation(); onMetaChange((m) => ({ ...m, unread: !m.unread })); }}
          >
            <span className="task-kebab-icon">●</span>
            <span>{meta.unread ? 'Starts unread' : 'Start marked unread'}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
