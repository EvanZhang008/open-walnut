/**
 * "Transfer harness/host…" in a task's kebab and in the session panel's ⋮ menu: one row,
 * defined once. A task with no session has nothing to move, so it has no row.
 */
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';
import { canOpenTransfer, openTransferDialog, TRANSFER_LABEL } from './transfer-events';

export function TransferMenuItem({ task, afterAction }: { task: Task; afterAction: () => void }) {
  if (!resolveTaskSessionId(task) || !canOpenTransfer()) return null;
  return (
    <button
      type="button"
      className="task-kebab-item"
      data-testid="task-kebab-transfer"
      title="Move this task's work to another harness (engine) or host"
      onClick={(e) => {
        e.stopPropagation();
        afterAction();
        openTransferDialog(task.id);
      }}
    >
      <span className="task-kebab-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8h13l-3-3M20 16H7l3 3" />
        </svg>
      </span>
      <span>{TRANSFER_LABEL}</span>
    </button>
  );
}
