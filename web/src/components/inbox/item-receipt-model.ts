import type { InboxItemAction, InboxItemReceipt, InboxLetterItem, InboxCurrentTaskStatus } from '@/api/human-inbox-items';

export const PHASE_TEXT: Record<string, string> = {
  TODO: 'To do', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs action', WAITING: 'Waiting', COMPLETE: 'Completed',
};
export function askAILabel(label: string): string {
  return /^Ask AI:/i.test(label) ? label : `Ask AI: ${label}`;
}
export function itemActions(item: InboxLetterItem): InboxItemAction[] {
  if (item.unavailableReason || item.source?.kind !== 'mail' || !item.source.account || !item.source.message) return [];
  const actions = Array.isArray(item.actions) ? item.actions : [];
  if (new Set(actions.map(a => a.id)).size !== actions.length) return [];
  const intents = actions.filter(a => a.kind === 'op').map(a => a.intent);
  if (new Set(intents).size !== intents.length) return [];
  const supported = actions.filter(a => a.kind === 'reply_ai' && typeof a.label === 'string' && typeof a.question === 'string'
    || a.kind === 'op' && ['mark_read', 'find_task', 'attach_task', 'create_task'].includes(a.intent));
  if (supported.length !== actions.length) return [];
  const attach = supported.find(a => a.kind === 'op' && a.intent === 'attach_task');
  return supported.filter(a => !(a.kind === 'op' && a.intent === 'find_task' && attach));
}
export function actionText(action: InboxItemAction): string {
  return action.kind === 'reply_ai' ? askAILabel(action.label) : action.intent === 'mark_read' ? 'Mark read'
    : action.intent === 'create_task' ? 'Create and start task' : 'Find task';
}
export function mergeReceipts(previous: readonly InboxItemReceipt[], incoming: readonly InboxItemReceipt[]): InboxItemReceipt[] {
  const rows = new Map(previous.map(r => [r.requestId, r]));
  for (const next of incoming) {
    const old = rows.get(next.requestId);
    if (!old || next.revision > old.revision) rows.set(next.requestId, next);
  }
  return [...rows.values()].sort((a, b) => a.revision - b.revision || a.requestId.localeCompare(b.requestId));
}
export function latestReceipt(receipts: readonly InboxItemReceipt[], lane: 'read' | 'task' | 'ai') {
  return [...receipts].reverse().find(r => lane === 'read' ? r.intent === 'mark_read'
    : lane === 'ai' ? r.intent === 'reply_ai' : r.intent === 'create_task' || r.intent === 'attach_task');
}
export function retryTaskAction(item: InboxLetterItem, receipt?: InboxItemReceipt): InboxItemAction | undefined {
  if (!receipt || receipt.status !== 'failure' || !receipt.recovery.some(r => r === 'retry_start' || r === 'retry_create')) return;
  return itemActions(item).find(a => a.kind === 'op' && (receipt.intent === 'create_task'
    ? a.intent === 'create_task' : a.intent === 'attach_task' || a.intent === 'find_task'));
}
export function receiptText(r?: InboxItemReceipt): string {
  if (!r) return '';
  if (r.intent === 'mark_read') return r.status === 'success' ? `Marked read at ${timeText(r.updatedAt)}` : r.status === 'pending'
    ? (r.stage === 'finished' ? 'Read status unconfirmed' : 'Working…') : 'Could not mark read';
  if (r.intent === 'reply_ai') return r.delivery === 'deferred' ? 'Waiting for permission'
    : r.delivery === 'skipped' ? 'Saved. This letter has no available agent.'
    : r.status === 'failure' ? 'Could not send to the agent' : r.status === 'pending' ? 'Delivery unconfirmed' : 'Sent to the agent';
  if (r.taskCreated === false) return r.status === 'failure' ? 'Task creation was not confirmed. Review before retrying.' : 'Creating task…';
  if (r.delivery) return r.delivery === 'queued' ? 'Work queued' : r.delivery === 'deferred' ? 'Waiting for permission'
    : r.delivery === 'unconfirmed' ? 'Attachment unconfirmed' : 'Could not attach';
  if (r.execution === 'running') return r.startedAt ? `Started at ${timeText(r.startedAt)}` : 'Started (time unavailable)';
  if (r.execution === 'unconfirmed') return r.taskId && r.intent === 'create_task' ? 'Task created. Start unconfirmed.' : 'Start unconfirmed';
  if (r.execution === 'not_started') return r.taskId ? r.intent === 'attach_task' ? 'Not started. Could not attach.' : 'Task created. Could not start.' : 'Not started';
  if (r.execution === 'starting' || r.stage === 'starting') return 'Starting…';
  return r.status === 'failure' ? 'Could not complete this action' : 'Working…';
}
export function mailDateText(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? timeText(value) : 'Date unavailable';
}
export function readHistoryText(receipt: InboxItemReceipt | undefined, previous = false): string {
  return receipt?.status === 'success' && previous ? `Marked read previously at ${timeText(receipt.updatedAt)}` : receiptText(receipt);
}
export function timeText(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Time unavailable';
  return new Date(value).toLocaleString();
}
export function currentTaskText(current?: InboxCurrentTaskStatus, stale = false): string {
  if (!current || current.status === 'unavailable') return 'Current task status unavailable';
  if (stale && current.status === 'running') return `Current task status unavailable · Last observed Running at ${timeText(current.observedAt)}`;
  const labels: Record<string, string> = { running: 'Running', starting: 'Starting', idle: 'Idle', stopped: 'Stopped',
    error: 'Error', waiting_permission: 'Waiting for permission', waiting_user: 'Waiting for you', waiting: 'Waiting', completed: 'Completed', deleted: 'Target deleted' };
  return `${labels[current.status]} · ${stale ? 'Last observed' : 'Checked'} ${timeText(current.observedAt)}`;
}
export function accountIdentity(item: InboxLetterItem): string {
  return JSON.stringify([item.display?.accountLabel || 'Account label unavailable', item.display?.accountHint || '']);
}
export function ambiguousAccounts(items: readonly InboxLetterItem[]): ReadonlySet<string> {
  const seen = new Map<string, Set<string>>();
  for (const item of items) {
    const key = accountIdentity(item);
    const accounts = seen.get(key) ?? new Set<string>();
    accounts.add(item.source?.account); seen.set(key, accounts);
  }
  return new Set([...seen].filter(([, accounts]) => accounts.size > 1).map(([key]) => key));
}
export function accountText(item: InboxLetterItem, ambiguous: ReadonlySet<string>): string {
  const label = item.display?.accountLabel || 'Account label unavailable';
  const hint = item.display?.accountHint;
  return [label, hint, ambiguous.has(accountIdentity(item)) ? item.source?.account : undefined].filter(Boolean).join(' · ');
}
