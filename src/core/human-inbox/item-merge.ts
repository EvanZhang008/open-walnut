import type { InboxItemReceipt, InboxLetterItem, LetterRecord } from './types.js';
import { allLetterItems } from './item-schema.js';

export function mergeItemReceipts(older: InboxItemReceipt[] = [], incoming: InboxItemReceipt[] = []): InboxItemReceipt[] {
  const records = new Map(older.map(r => [r.requestId, r]));
  for (const receipt of incoming) {
    const previous = records.get(receipt.requestId);
    if (!previous || receipt.revision > previous.revision) records.set(receipt.requestId, receipt);
  }
  return [...records.values()].sort((a, b) => a.revision - b.revision);
}
/** Replica content can be older than already received execution facts. */
export function mergeLetterItemFacts(previous: LetterRecord | undefined, incoming: LetterRecord): LetterRecord {
  if (!previous) return incoming;
  const items = new Map(allLetterItems(previous).map(i => [i.id, i]));
  const merge = (item: InboxLetterItem): InboxLetterItem => {
    const old = items.get(item.id);
    if (!old || JSON.stringify(old.source) !== JSON.stringify(item.source)) return item;
    return { ...item, receipts: mergeItemReceipts(old.receipts, item.receipts) };
  };
  // The caller still hashes the incoming row after storing the merged facts.
  return {
    ...incoming,
    ...(incoming.items ? { items: incoming.items.map(merge) } : {}),
    ...(incoming.thread ? { thread: incoming.thread.map(entry => entry.items
      ? { ...entry, items: entry.items.map(merge) } : entry) } : {}),
  };
}
