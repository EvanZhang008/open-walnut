/**
 * THE status icon of a task, everywhere a task's status is drawn (Home rows, the task table, the
 * session header, Focus cards, subtask and leader pills, search results, the Org pages, the Board).
 * Seven states, each its own shape so it reads without colour; only Working moves (its dot breathes,
 * CSS only, still under reduced motion); only Needs you is red. Beside small text (a count, a chip,
 * a pill) it is the same shape at `size={12}`: there is no separate dot form, so a task reads the same
 * everywhere. The shapes: ./task-state-shapes.ts. Styles: styles/task-state.css. Which state:
 * utils/task-icon-state.ts. Guard: tests/web/task-state-icon-guard.test.ts.
 */
import { useId } from 'react';
import { TASK_ICON_WORDS, type TaskIconState } from '@/utils/task-icon-state';
import { shapeElements } from './task-state-shapes';

export interface TaskStateIconProps {
  state: TaskIconState;
  /** Pixels; 14 beside 13px text (the default), 12 beside small text. */
  size?: number;
  /** Hover text; none when left out, so the control around it keeps its own. */
  title?: string;
  /** Hidden from assistive tech, where the control around it already names the state. */
  decorative?: boolean;
  className?: string;
  testId?: string;
}

export function TaskStateIcon({ state, size = 14, title, decorative = false, className, testId }: TaskStateIconProps) {
  // One mask id per icon: a list draws many icons, and a mask id shared between them would cut
  // through the first one's mask only (React's id with its punctuation dropped, valid in url(#...)).
  const cut = `tsi-cut-${useId().replace(/[^\w-]/g, '')}`;
  const word = TASK_ICON_WORDS[state];
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': word };
  // The wrapper is the icon (its class, state, name and hover text); the SVG inside draws the shape
  // and sizes it, and Working's centre sits over the ring as its own element.
  return (
    <span className={`task-state-icon${className ? ` ${className}` : ''}`} data-state={state} data-testid={testId} title={title} {...a11y}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
        {shapeElements(state, cut)}
      </svg>
      {state === 'working' && <i className="tsi-pulse" />}
    </span>
  );
}
