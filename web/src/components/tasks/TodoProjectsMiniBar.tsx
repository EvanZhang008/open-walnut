/**
 * TodoProjectsMiniBar: the Projects view's two list verbs (spec 5.6). Filters,
 * sort and date live in the filter row, the footer and Display, so this bar
 * keeps only Running (jump to the next live session) and Collapse/Expand.
 */
import { memo } from 'react';
import * as ICONS from '../common/Icons';

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
        className="todo-minibar-btn"
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
            className="todo-minibar-btn todo-minibar-running"
            title="Jump to the next task with a running session"
            onClick={onJumpRunning}
          >
            <span className="todo-minibar-running-dot" />
            Running ({runningCount})
          </button>
        </>
      )}
    </div>
  );
});
