import { readItemLedger } from './item-ledger.js';

/** Suppress only the launch failure already represented by an exact item receipt. */
export async function inboxOwnsStartFailure(taskId: string, sessionId?: string | null): Promise<boolean> {
  const ledger = await readItemLedger();
  const receipts = Object.values(ledger.receipts).filter(receipt => receipt.taskId === taskId && receipt.execution !== 'running');
  if (!receipts.length) return false;
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => undefined);
  const attempt = task?.last_start;
  if (!task || task.id !== taskId || !attempt || attempt.state === 'started' || sessionId && attempt.session_id !== sessionId) return false;
  return receipts.some(receipt => ledger.plans[receipt.planId]?.plan.ops.some(op =>
    op.tool === 'task_start' && op.args.start_attempt_id === attempt.id) === true);
}
