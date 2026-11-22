/**
 * TodoProjectsMiniBar: the Projects view's two list verbs (spec 5.6). Filters,
 * sort and date live in the filter row, the footer and Display, so this bar
 * keeps only Running (jump to the next live session) and Collapse/Expand.
 */
import { memo } from 'react';
import * as ICONS from '../common/Icons';
import { TaskStateIcon } from '../common/TaskStateIcon';

export interface TodoProjectsMiniBarProps {
  runningCount: number;
  onJumpRunning(): void;
  allCollapsed: boolean;
  onCollapseExpandAll(): void;
}

export const TodoProjectsMiniBar = memo(function TodoProjectsMiniBar({
  runningCount, onJumpRunning, allCollapsed, onCollapseExpandAll,
}: TodoProjectsMiniBarProps) {
  const label = allCollapsed ? 'Expand all projects' : 'Collapse all projects';
  return (
    <div className="todo-minibar">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        title={label}
        aria-label={label}
        onClick={onCollapseExpandAll}
      >
        <span className="todo-minibar-icon" aria-hidden="true">{allCollapsed ? ICONS.ICON_EXPAND : ICONS.ICON_COLLAPSE}</span>
        {allCollapsed ? 'Expand all' : 'Collapse all'}
      </button>
      {runningCount > 0 && (
        <>
          <span className="todo-minibar-sep" />
          <button
            type="button"
            className="btn btn-sm btn-ghost todo-minibar-running"
            title="Jump to the next task with a running session"
            onClick={onJumpRunning}
          >
            {/* It counts the tasks whose session runs: Working, in its own icon. */}
            <TaskStateIcon state="working" size={12} decorative />
            Running ({runningCount})
          </button>
        </>
      )}
    </div>
  );
});
