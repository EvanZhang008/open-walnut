/**
 * TaskBatchMenu — the multi-select action bar's "Group" control, rendered as a
 * split button: the left half groups the selection; the right caret opens a side
 * dropdown of batch operations (set priority / pin to tier / set date) that fan
 * out across EVERY selected task. The dropdown reuses the very same panel rows as
 * the per-task ⋮ kebab (TaskActionMenuItems) so there is one definition of these
 * actions — no separate batch menu to drift out of sync.
 */

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import type { FocusTier } from '@/api/focus';
import { TaskActionMenuItems, MoveToProjectSection } from './TaskKebabMenu';
import * as ICONS from '../common/Icons';
import { MenuCaret } from '@/components/controls';

interface TaskBatchMenuProps {
  /** Number of selected tasks (drives the label + group-enabled state). */
  count: number;
  /** Whether the selection can be grouped — true once ≥2 tasks are picked (a
   *  group has no project scope rule; any tasks can be grouped). */
  canGroup: boolean;
  onGroup: () => void;
  /** Apply to every selected task. */
  onSetPriorityAll: (priority: string) => void;
  onPinAllToTier: (tier: FocusTier) => void;
  onSetDateAll: (date: string | null) => void;
  onSetStartDateAll: (date: string | null) => void;
  /** Move every selected task to a project ('' = Inbox). */
  onMoveAllToProject: (project: string) => void;
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

export function TaskBatchMenu({ count, canGroup, onGroup, onSetPriorityAll, onPinAllToTier, onSetDateAll, onSetStartDateAll, onMoveAllToProject, onCompleteAll, onReopenAll, doneCount, onDeleteAll }: TaskBatchMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), []);
  // Placed like every other menu (web/src/AGENTS.md "Menus & overlays"): measured, flipped to the
  // side with room, clamped to the window and capped with its own scroll. The bar sits right under
  // the task panel's toolbar, so it opens down; it follows the button while the page scrolls.
  const menuPos = useMenuPlacement(open, caretRef, menuRef, { onAnchorLost: close });

  // The overlay stack: Escape closes this menu only (the selection stays), and a press outside
  // closes it. The Project picker's list is its own portal (MoveToProjectSection).
  useOverlayLayer({ passOutsideClick: true, open, refs: [menuRef, wrapRef], exemptSelectors: ['.task-kebab-project-flyout'], onClose: close });

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
          className="btn btn-sm"
          title="Mark the selected tasks complete"
          onClick={onCompleteAll}
        >
          <span className="task-selection-action-icon">{ICONS.ICON_PHASE_COMPLETE}</span>
          Complete
        </button>
      )}
      {doneCount > 0 && (
        <button
          className="btn btn-sm"
          title="Reopen the selected tasks"
          onClick={onReopenAll}
        >
          <span className="task-selection-action-icon">{ICONS.ICON_PHASE_TODO}</span>
          Reopen
        </button>
      )}

      <button
        className="btn btn-sm btn-primary task-selection-group-btn"
        disabled={!canGroup}
        title={count < 2 ? 'Select at least 2 same-project tasks' : 'Put these tasks into a folder'}
        onClick={onGroup}
      >
        ⑂ Folder
      </button>

      <button
        className="btn btn-sm btn-danger"
        title="Delete the selected tasks"
        onClick={onDeleteAll}
      >
        <span className="task-selection-action-icon">{ICONS.ICON_TRASH}</span>
        Delete
      </button>

      {/* Overflow — a labelled button, not a bare caret, so it reads as "opens a menu". */}
      <button
        ref={caretRef}
        className="btn btn-sm"
        disabled={count < 1}
        title="More batch actions (pin tier, priority, date)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        More
        <MenuCaret />
      </button>

      {/* Portalled to <body>, as the row kebab's: no ancestor's clip or layer caps it, and a press
          inside it never reaches a row's drag sensors. */}
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu task-batch-dropdown wn-overlay wn-menu"
          role="menu"
          style={menuPlacementStyle(menuPos)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="task-kebab-section-label wn-menu-heading">
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
            onSetStartDate={(d) => onSetStartDateAll(d)}
            afterAction={close}
          />

          {/* Move every selected task to a project — same picker as the kebab. */}
          <MoveToProjectSection
            current={null}
            onMove={onMoveAllToProject}
            afterAction={close}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
