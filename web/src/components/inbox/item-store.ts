import { queryItem, itemError, type InboxItemExecutionResponse, type InboxItemReceipt, type InboxLetterItem } from '@/api/human-inbox-items';
import { mergeReceipts } from './item-receipt-model';

export interface ItemSnapshot extends InboxItemExecutionResponse {
  loaded: boolean;
  stale: boolean;
  error?: string;
  submitting: Readonly<Record<string, boolean>>;
  pollExpired: boolean;
  uncertain: Readonly<Record<string, string>>;
}
const rows = new Map<string, ItemSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const reads = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const starts = new Map<string, number>();
const watched = new Map<string, number>();
export function itemKey(letter: string, item: string) { return JSON.stringify([letter, item]); }
export function getItemSnapshot(key: string): ItemSnapshot {
  let row = rows.get(key);
  // Mounted readers keep their identities; evict only unused records from old letters.
  if (!row && rows.size > 1000) for (const candidate of rows.keys()) {
    if (!watched.get(candidate) && !reads.has(candidate) && !listeners.get(candidate)?.size) {
      rows.delete(candidate); listeners.delete(candidate); watched.delete(candidate); starts.delete(candidate);
      if (rows.size <= 800) break;
    }
  }
  if (!row) {
    row = { itemId: JSON.parse(key)[1], receipts: [], restrictions: [], loaded: false, stale: false, submitting: {}, pollExpired: false, uncertain: {} };
    rows.set(key, row);
  }
  return row;
}
export function subscribeItem(key: string, fn: () => void) {
  const set = listeners.get(key) ?? new Set();
  set.add(fn); listeners.set(key, set);
  return () => { set.delete(fn); };
}
function put(key: string, patch: Partial<ItemSnapshot>) {
  rows.set(key, { ...getItemSnapshot(key), ...patch });
  for (const fn of listeners.get(key) ?? []) fn();
}
export function ingestItem(key: string, item: Pick<InboxLetterItem, 'receipts' | 'readObservation'>) {
  const old = getItemSnapshot(key);
  put(key, { receipts: mergeReceipts(old.receipts, item.receipts ?? []),
    ...(item.readObservation && (!old.readObservation || item.readObservation.observedAt > old.readObservation.observedAt)
      ? { readObservation: item.readObservation } : {}) });
}
export function mergeItemResponse(key: string, next: InboxItemExecutionResponse) {
  const old = getItemSnapshot(key);
  const uncertain = { ...old.uncertain };
  for (const [lane, requestId] of Object.entries(uncertain)) {
    if (next.receipts.some(r => r.requestId === requestId || r.requestIds?.includes(requestId))) delete uncertain[lane];
  }
  put(key, { receipts: mergeReceipts(old.receipts, next.receipts), restrictions: next.restrictions, uncertain,
    loaded: true, error: Object.keys(uncertain).length ? 'Status unconfirmed. Check status before trying again.' : undefined, stale: false,
    ...(next.currentTask && (!old.currentTask || next.currentTask.observedAt >= old.currentTask.observedAt)
      ? { currentTask: next.currentTask } : {}),
    ...(next.readObservation && (!old.readObservation || next.readObservation.observedAt >= old.readObservation.observedAt)
      ? { readObservation: next.readObservation } : {}) });
  schedulePending(key);
}
export function mergeItemReceipts(key: string, receipts: InboxItemReceipt[]) {
  put(key, { receipts: mergeReceipts(getItemSnapshot(key).receipts, receipts) });
  schedulePending(key);
}
export function setItemSubmitting(key: string, lane: string, value: boolean): boolean {
  const old = getItemSnapshot(key);
  if (value && old.submitting[lane]) return false;
  put(key, { submitting: { ...old.submitting, [lane]: value } });
  return true;
}
export function noteItemUnconfirmed(key: string, message = 'Status unconfirmed. Check status before trying again.', lane?: string, requestId?: string) {
  put(key, { error: message, stale: true,
    ...(lane && requestId ? { uncertain: { ...getItemSnapshot(key).uncertain, [lane]: requestId } } : {}) });
}
export function refreshItem(key: string): Promise<void> {
  const pending = reads.get(key);
  if (pending) return pending;
  const [letterId, itemId] = JSON.parse(key) as [string, string];
  const read = queryItem(letterId, itemId).then(result => mergeItemResponse(key, result)).catch(error => {
    const failure = itemError(error);
    put(key, { loaded: true, stale: true, error: failure.code === 'unsupported' || failure.code === 'primary_unavailable'
      ? failure.message : 'Status unavailable. Check again.',
      ...(['unsupported', 'primary_unavailable', 'item_unavailable', 'source_unavailable'].includes(failure.code)
        ? { restrictions: [{ code: failure.code, message: failure.message }] } : {}) });
  }).finally(() => { reads.delete(key); });
  reads.set(key, read);
  return read;
}
function schedulePending(key: string) {
  if (!watched.get(key) || timers.has(key) || typeof document !== 'undefined' && document.hidden) return;
  if (!getItemSnapshot(key).receipts.some(r => r.status === 'pending')) {
    starts.delete(key);
    if (getItemSnapshot(key).pollExpired) put(key, { pollExpired: false });
    return;
  }
  const start = starts.get(key) ?? Date.now(); starts.set(key, start);
  const elapsed = Date.now() - start;
  if (elapsed >= 30_000) { put(key, { pollExpired: true }); return; }
  const delay = elapsed < 2_000 ? 1_000 : elapsed < 6_000 ? 2_000 : 5_000;
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    if (typeof document !== 'undefined' && document.hidden) return;
    void refreshItem(key).then(() => schedulePending(key));
  }, delay));
}
export function watchItem(key: string): () => void {
  watched.set(key, (watched.get(key) ?? 0) + 1);
  starts.delete(key); put(key, { pollExpired: false });
  void refreshItem(key);
  return () => {
    const count = (watched.get(key) ?? 1) - 1; watched.set(key, count);
    if (!count && timers.has(key)) { clearTimeout(timers.get(key)!); timers.delete(key); starts.delete(key); }
  };
}
export function refreshWatchedItems(letterId?: string, taskId?: string) {
  if (typeof document !== 'undefined' && document.hidden) return;
  for (const [key, count] of watched) {
    if (!count || letterId && JSON.parse(key)[0] !== letterId) continue;
    if (taskId && !getItemSnapshot(key).receipts.some(r => r.taskId === taskId) && getItemSnapshot(key).currentTask?.taskId !== taskId) continue;
    void refreshItem(key);
  }
}
export function resetItemStore() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear(); starts.clear(); rows.clear(); reads.clear(); watched.clear(); listeners.clear();
}
