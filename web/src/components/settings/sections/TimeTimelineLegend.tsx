import { useState } from 'react';
import { formatDuration, groupLegend, taskColor, type LegendRow } from './time-timeline';

/**
 * The timeline's key: which colour is which task, biggest first.
 *
 * Every row is exactly ONE line, whatever the title (a real day carried titles
 * long enough to wrap three times). Rows under two minutes collapse into a single
 * "Quick touches" row and the tail sits behind "+N more" — both expandable, so
 * nothing is hidden, only ranked. See groupLegend for the reasoning.
 */
export function TimeTimelineLegend({ rows, agentMs, onPick, pickedTaskId }: {
  rows: LegendRow[];
  /** Agent runtime for the day, or 0 when the lane is hidden. */
  agentMs: number;
  onPick: (taskId: string | null) => void;
  pickedTaskId: string | null;
}) {
  const [showMore, setShowMore] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const groups = groupLegend(rows);
  const visible = showMore ? [...groups.main, ...groups.hidden] : groups.main;

  return (
    <aside className="tt-legend" data-testid="time-timeline-legend">
      <div className={`tt-legend-list${showMore || showQuick ? ' is-expanded' : ''}`}>
        {visible.map((row) => (
          <Row
            key={row.taskId || '__none__'}
            row={row}
            picked={pickedTaskId === row.taskId}
            onPick={onPick}
          />
        ))}

        {groups.hidden.length > 0 && (
          <button
            className="tt-legend-more"
            data-testid="time-timeline-legend-more"
            onClick={() => setShowMore((v) => !v)}
          >
            {showMore
              ? 'Show fewer'
              : `+${groups.hidden.length} more · ${formatDuration(groups.hiddenMs)}`}
          </button>
        )}

        {groups.quick.length > 0 && (
          <>
            <button
              className="tt-legend-quick"
              data-testid="time-timeline-legend-quick"
              title="Tasks you touched for under two minutes"
              onClick={() => setShowQuick((v) => !v)}
            >
              <i className="tt-swatch tt-swatch-quick" />
              <span className="tt-legend-name">
                Quick touches · {groups.quick.length} {groups.quick.length === 1 ? 'task' : 'tasks'}
              </span>
              <span className="tt-legend-ms">{formatDuration(groups.quickMs)}</span>
            </button>
            {showQuick && groups.quick.map((row) => (
              <Row
                key={row.taskId || '__none__'}
                row={row}
                picked={pickedTaskId === row.taskId}
                onPick={onPick}
                quiet
              />
            ))}
          </>
        )}
      </div>

      {agentMs > 0 && (
        <div className="tt-legend-row tt-legend-static" data-testid="time-timeline-legend-agents">
          <i className="tt-swatch tt-swatch-agent" />
          <span className="tt-legend-name">Agent turns</span>
          <span className="tt-legend-ms">{formatDuration(agentMs)}</span>
        </div>
      )}
    </aside>
  );
}

function Row({ row, picked, onPick, quiet }: {
  row: LegendRow;
  picked: boolean;
  onPick: (taskId: string | null) => void;
  quiet?: boolean;
}) {
  return (
    <button
      className={`tt-legend-row${picked ? ' is-picked' : ''}${quiet ? ' is-quiet' : ''}`}
      // NOT `data-task-id`: the time tracker bills any signal inside a
      // div[data-task-id] to that task, so a legend row carrying it would charge
      // the task you merely read about here.
      data-time-task-id={row.taskId}
      title={`${row.title} — ${formatDuration(row.ms)}`}
      onClick={() => onPick(picked ? null : row.taskId)}
    >
      <i className="tt-swatch" style={{ background: taskColor(row.taskId) }} />
      <span className="tt-legend-name">{row.title}</span>
      <span className="tt-legend-ms">{formatDuration(row.ms)}</span>
    </button>
  );
}
