/**
 * One row of the Ask Walnut drawer's list (AskWalnutDrawer), and the state dot Home's rows and
 * Main's row wear. The side panel's shape (`detail`) draws two lines instead: the ask's status
 * under its title, with a red dot only when it needs the person.
 */
import type { Task } from '@open-walnut/core';
import { askActivityAt, askState, printedStamp, type AskState, type HeldList } from '@open-walnut/ask-list';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import type { DrawerRow } from './AskWalnutDrawer';

/** A row as the shared snapshot reads it: the stamp the list SORTS by (the
 *  shared `askActivityAt`: the last message sent into the ask). */
export function heldRowView(row: DrawerRow): { id: string; activityAt?: string } {
  const at = row.task ? askActivityAt(row.task) : undefined;
  return at ? { id: row.id, activityAt: at } : { id: row.id };
}

export function DrawerItem({ row, held, selected, onPick, detail }: {
  row: DrawerRow; held: HeldList | undefined; selected: boolean; onPick: () => void;
  /** The side panel's two-line row: the ask's status under its title, a red dot when it needs the person. */
  detail?: { line: string; needs: boolean };
}) {
  // The stamp the row sorts by, so the times read in order down the list (it
  // used to print `updated_at` over a birth-ordered list, which put a "1d ago"
  // among the "1w ago" rows); while the order is held, the stamp it had then.
  const stamp = printedStamp(held, heldRowView(row));
  return (
    <button
      type="button"
      className={`ask-walnut-drawer-item${selected ? ' is-selected' : ''}`}
      data-testid="ask-walnut-drawer-item"
      data-task-id={row.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onPick}
      title={row.title}
      {...(detail ? { 'data-needs': detail.needs ? 'true' : 'false' } : {})}
    >
      {detail ? (
        <>
          <span className={`ask-walnut-drawer-needs${detail.needs ? ' is-on' : ''}`} aria-label={detail.needs ? 'Needs you' : undefined} />
          <span className="ask-walnut-drawer-item-text">
            <span className="ask-walnut-drawer-item-title">{row.title}</span>
            {detail.line && <span className="ask-walnut-drawer-item-line">{detail.line}</span>}
          </span>
        </>
      ) : (
        <>
          {row.task ? <TaskDot task={row.task} /> : <span className="ask-walnut-drawer-dot task-circle-session" aria-hidden="true" />}
          <span className="ask-walnut-drawer-item-title">{row.title}</span>
        </>
      )}
      {stamp.kind === 'time' && <span className="ask-walnut-drawer-item-time">{timeAgo(stamp.at)}</span>}
      {stamp.kind === 'new' && (
        <span className="ask-walnut-drawer-item-time is-new" data-testid="ask-walnut-drawer-item-new">New</span>
      )}
    </button>
  );
}

/** The shared ask state as the board's circle classes (same colours): blue =
 *  a conversation that is not running, pulsing blue = running a turn, green =
 *  done, grey = no session yet. */
const STATE_CLASS: Record<AskState, string> = {
  idle: 'task-circle-session',
  running: 'task-circle-running',
  done: 'task-circle-done',
  todo: 'task-circle-todo',
};

/** The row's state as a dot: the shared `askState` fed the live session status
 *  (the phone gets the same rule from GET /api/v1/asks). Its own component
 *  because the live status is a store subscription. */
export function TaskDot({ task }: { task: Task }) {
  const live = useSessionStatus(resolveTaskSessionId(task));
  const state = askState(task, live);
  return <span className={`ask-walnut-drawer-dot ${STATE_CLASS[state]}`} data-ask-state={state} aria-hidden="true" />;
}
