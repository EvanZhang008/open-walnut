/**
 * The rollup line (spec 7.1): `14 open · 23 done` by lane kind (G7) with a thin
 * progress bar, `, 1 task still open` as a filter button, the workers of the
 * open cards (G33: running, waiting on you, idle, error, no session; the
 * waiting and error parts red; running sets the Running chip, waiting and
 * error set Needs you), and, first, a red button when the leader itself needs
 * the user. While the task store loads it says `Loading the team...`.
 */
import type { KanbanFilterApi, KanbanFilterKey, KanbanMode } from './kanban-contract';
import type { KanbanBoardVM, KanbanWorkerKey } from './kanban-model';

export interface KanbanRollupProps {
  board: KanbanBoardVM;
  filter: KanbanFilterApi;
  mode: KanbanMode;
  onOpenTask(taskId: string): void;
}

const WORKER_CHIP: Partial<Record<KanbanWorkerKey, KanbanFilterKey>> = { running: 'running', waiting: 'needs', error: 'needs' };

/** `The leader needs you: approve Bash` from the leader's red status line. */
export function leaderReason(text: string): string {
  return text.replace(/^Needs you:\s*/, '').trim() || 'look at it';
}

export function KanbanRollup({ board, filter, mode, onOpenTask }: KanbanRollupProps) {
  const { rollup, leader } = board;
  const pick = (chip: KanbanFilterKey) => filter.setChip(filter.chip === chip ? null : chip);
  return (
    <div className={`kanban-rollup-row is-${mode}`}>
      {leader?.needsYou && (
        <button
          type="button"
          className="kanban-rollup-leader"
          data-testid="kanban-rollup-leader"
          title={leader.status.tooltip || leader.status.text}
          onClick={() => onOpenTask(leader.taskId)}
        >The leader needs you: {leaderReason(leader.status.text)}</button>
      )}
      <span className="kanban-rollup" data-testid="kanban-rollup">
        {board.loading ? 'Loading the team...' : rollup.text}
        {!board.loading && rollup.stillOpenText && (
          <>
            {', '}
            <button
              type="button"
              className={`kanban-rollup-still-open${filter.chip === 'still-open' ? ' is-active' : ''}`}
              data-testid="kanban-rollup-still-open"
              aria-pressed={filter.chip === 'still-open'}
              title="Show the cards in a done lane whose task is still open"
              onClick={() => (filter.chip === 'still-open' ? filter.setChip(null) : filter.showStillOpen())}
            >{rollup.stillOpenText}</button>
          </>
        )}
      </span>
      {!board.loading && rollup.open + rollup.done > 0 && (
        <span
          className="kanban-progress"
          data-testid="kanban-progress"
          role="progressbar"
          aria-label="Done"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rollup.percent}
          title={`${rollup.percent}% done`}
        >
          <span className="kanban-progress-fill" style={{ width: `${rollup.percent}%` }} />
        </span>
      )}
      {rollup.workers.length > 0 && (
        <span className="kanban-workers" data-testid="kanban-workers">
          {mode === 'wide' && <span className="kanban-workers-label">Workers: </span>}
          {rollup.workers.map((w, i) => {
            const chip = WORKER_CHIP[w.key];
            const red = w.key === 'waiting' || w.key === 'error';
            const cls = `kanban-workers-seg${red ? ' is-red' : ''}`;
            return (
              <span key={w.key} className="kanban-workers-item">
                {i > 0 && <span className="kanban-workers-sep" aria-hidden> · </span>}
                {chip ? (
                  <button
                    type="button"
                    className={`${cls} is-button`}
                    data-testid={`kanban-workers-${w.key}`}
                    aria-pressed={filter.chip === chip}
                    title={chip === 'running' ? 'Show the running workers' : `${w.text}: open prompts. Needs you (${board.chips.needs}) also counts errors and hand backs`}
                    onClick={() => pick(chip)}
                  >{w.text}</button>
                ) : (
                  <span className={cls} data-testid={`kanban-workers-${w.key}`}>{w.text}</span>
                )}
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}
