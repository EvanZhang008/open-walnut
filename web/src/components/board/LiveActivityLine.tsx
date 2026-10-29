/**
 * A running task's live action in one line (core/live-activity.ts): the tool it runs now and
 * for how long, the turn's length and cost, or "No tool call for 12 min" when it went quiet.
 * Written by the program from the session's stream, never by the model. Renders nothing when
 * no turn of the task runs. Used by the Board's Status view and the Org page's team rows.
 */
import { memo } from 'react';
import { formatLiveActivity } from '@open-walnut/live-activity';
import { useLiveActivity, useNow } from '@/stores/live-activity-store';
import '@/styles/live-activity.css';

export const LiveActivityLine = memo(function LiveActivityLine({ taskId, prefix, className }: {
  taskId: string;
  /** Names the worker when the line is a team's (Org page). */
  prefix?: string;
  className?: string;
}) {
  const act = useLiveActivity(taskId);
  const now = useNow(!!act);
  if (!act) return null;
  const line = formatLiveActivity(act, now);
  return (
    <span
      className={`live-activity${line.quiet ? ' is-quiet' : ''}${className ? ` ${className}` : ''}`}
      data-testid="live-activity"
      data-task-id={taskId}
      data-kind={act.kind}
      {...(line.quiet ? { 'data-quiet': 'true' } : {})}
      title={`Read from its session just now: ${line.text}`}
    >
      <span className="live-activity-dot" aria-hidden="true" />
      {prefix && <span className="live-activity-who">{prefix}: </span>}
      <span className="live-activity-action">{line.action}</span>
      {line.turn && <span className="live-activity-meta"> · {line.turn}</span>}
      {line.cost && <span className="live-activity-meta"> · {line.cost}</span>}
    </span>
  );
});
