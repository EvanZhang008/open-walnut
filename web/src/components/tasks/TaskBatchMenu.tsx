/**
 * TaskBatchMenu — the multi-select action bar's "Group" control, rendered as a
 * split button: the left half groups the selection; the right caret opens a side
 * dropdown of batch operations (set priority / pin to tier / set date) that fan
 * out across EVERY selected task. The dropdown reuses the very same panel rows as
 * the per-task ⋮ kebab (TaskActionMenuItems) so there is one definition of these
 * actions — no separate batch menu to drift out of sync.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { FocusTier } from '@/api/focus';
import { TaskActionMenuItems } from './TaskKebabMenu';
import * as ICONS from '../common/Icons';

interface TaskBatchMenuProps {
  /** Number of selected tasks (drives the label + group-enabled state). */
  count: number;
  /** Whether the selection can be grouped — true once ≥2 tasks are picked (a
   *  group has no category/project scope rule; any tasks can be grouped). */
  canGroup: boolean;
  onGroup: () => void;
  /** Apply to every selected task. */
  onSetPriorityAll: (priority: string) => void;
  onPinAllToTier: (tier: FocusTier) => void;
  onSetDateAll: (date: string | null) => void;
  /** Mark every selected task COMPLETE. */
  onCompleteAll: () => void;
  /** Reopen (phase → TODO) every selected task. Only offered when the selection
   *  actually contains done tasks — otherwise it's a no-op row. */
  onReopenAll: () => void;
  /** How many of the selected tasks are already done (drives Complete/Reopen rows). */
  doneCount: number;
  /** Delete every selected task (confirms first — the handler owns the dialog). */
  onDeleteAll: () => void;
}

export function TaskBatchMenu({ count, canGroup, onGroup, onSetPriorityAll, onPinAllToTier, onSetDateAll, onCompleteAll, onReopenAll, doneCount, onDeleteAll }: TaskBatchMenuProps) {
  const [open, setOpen] = useState(false);
  // Fixed-position coords for the dropdown. The selection bar is position:sticky at the
  // bottom of the .todo-panel-list scroll container (overflow:auto), so a plain
  // position:absolute dropdown anchored to it gets clipped by that scroll box (verified:
  // ~137px of a 280px-tall menu cut off in a short panel). Mirror the kebab's escape
  // hatch: render the dropdown position:fixed with coords measured from the caret, so it
  // floats above all clipping ancestors. It opens UPWARD (the bar lives at the bottom).
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen && caretRef.current) {
        const r = caretRef.current.getBoundingClientRect();
        // Anchor the menu's bottom just above the caret, right-aligned to it. The left-edge
        // clamp happens in useLayoutEffect once the menu's real width is known.
        setMenuPos({ bottom: window.innerHeight - r.top + 6, right: window.innerWidth - r.right });
      }
      return !wasOpen;
    });
  }, []);

  // After the menu mounts, its real width is known — clamp `right` so the (right-aligned)
  // menu can't push its left edge off-screen inside the narrow Todo panel (8px gutter).
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !menuPos) return;
    const w = menuRef.current.offsetWidth;
    const maxRight = Math.max(8, window.innerWidth - w - 8);
    if (menuPos.right > maxRight) setMenuPos((p) => (p ? { ...p, right: maxRight } : p));
  }, [open, menuPos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // A scroll/resize moves the button out from under the position:fixed menu, so the
    // menu has to react. It must NOT blanket-close though: clicking the button itself
    // scrolls it into view (a scroll on .todo-panel fires in the SAME tick as the
    // opening click), which made a plain `setOpen(false)` here close the menu
    // instantly — it never appeared at all. Instead REPOSITION to follow the button,
    // and only close once the button has actually left the viewport.
    const onScrollOrResize = () => {
      const btn = caretRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > window.innerHeight;
      if (offscreen) { setOpen(false); return; }
      setMenuPos({ bottom: window.innerHeight - r.top + 6, right: window.innerWidth - r.right });
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  return (
    <div className="task-batch-menu" ref={wrapRef}>
      {/* The three primary verbs sit ON the bar, not behind a caret. They used to
          live inside the dropdown behind a split-button's right half, which can only
          ever be a few px wide — it rendered as a bare dot with no affordance, so the
          most common batch actions were effectively invisible. Complete/Reopen and
          Delete are one click now; only the secondary attribute setters (pin tier /
          priority / date) stay in the overflow menu. */}
      {doneCount < count && (
        <button
          className="task-selection-action-btn"
          title="Mark the selected tasks complete"
          onClick={onCompleteAll}
        >
          <span className="task-selection-action-icon">{ICONS.ICON_PHASE_COMPLETE}</span>
          Complete
        </button>
      )}
      {doneCount > 0 && (
        <button
          className="task-selection-action-btn"
          title="Reopen the selected tasks"
          onClick={onReopenAll}
        >
          <span className="task-selection-action-icon">{ICONS.ICON_PHASE_TODO}</span>
          Reopen
        </button>
      )}

      <button
        className="task-selection-group-btn"
        disabled={!canGroup}
        title={count < 2 ? 'Select at least 2 tasks' : 'Group these tasks together'}
        onClick={onGroup}
      >
        ⑂ Group
      </button>

      <button
        className="task-selection-action-btn task-selection-action-danger"
        title="Delete the selected tasks"
        onClick={onDeleteAll}
      >
        <span className="task-selection-action-icon">{ICONS.ICON_TRASH}</span>
        Delete
      </button>

      {/* Overflow — a labelled button, not a bare caret, so it reads as "opens a menu". */}
      <button
        ref={caretRef}
        className="task-selection-action-btn task-batch-more"
        disabled={count < 1}
        title="More batch actions (pin tier, priority, date)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        More
        <span className="task-batch-more-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="task-kebab-menu task-batch-dropdown"
          role="menu"
          style={menuPos ? { position: 'fixed', bottom: menuPos.bottom, right: menuPos.right, zIndex: 9999 } : undefined}
        >
          <div className="task-kebab-section-label">
            {count} task{count === 1 ? '' : 's'} selected
          </div>

          {/* Same rows as the per-task kebab — applied to every selected task. */}
          <TaskActionMenuItems
            task={null}
            isPinned={false}
            isDone={false}
            batchMode
            onSetPriority={(p) => onSetPriorityAll(p)}
            onSetTier={(t) => onPinAllToTier(t)}
            onSetDate={(d) => onSetDateAll(d)}
            afterAction={close}
          />
        </div>
      )}
    </div>
  );
}
