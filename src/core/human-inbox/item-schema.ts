import { z } from 'zod';
import type { InboxLetterItem, LetterRecord } from './types.js';

const safeText = (max: number) => z.string().max(max).transform(v => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true });
const sourceId = (max: number) => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Source identifiers cannot contain control characters');
export const inboxSourceSchema = z.object({ kind: z.literal('mail'), account: sourceId(1024), message: sourceId(4096) }).strict();
export const inboxActionSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('op'), intent: z.enum(['mark_read', 'find_task', 'create_task', 'attach_task']) }).strict(),
  z.object({ id, kind: z.literal('reply_ai'), label: safeText(200).pipe(z.string().trim().min(1)), question: safeText(4000).pipe(z.string().trim().min(1)) }).strict(),
]);
export const inboxItemSchema = z.object({
  id, subject: safeText(1000).pipe(z.string().trim().min(1)), summary: safeText(16000),
  source: inboxSourceSchema,
  display: z.object({
    sender: z.object({ name: safeText(300).optional(), address: safeText(500).optional() }).strict().optional(),
    sentAt: timestamp.optional(), accountLabel: safeText(300).optional(), accountHint: safeText(1000).optional(),
  }).strict().optional(),
  readObservation: z.object({ read: z.boolean(), observedAt: timestamp }).strict().optional(),
  actions: z.array(inboxActionSchema).max(8),
}).strict().superRefine((item, ctx) => {
  const seen = new Set<string>();
  for (const action of item.actions) {
    const key = action.kind === 'op' ? action.intent : `reply_ai:${action.id}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate item action intent' });
    seen.add(key);
  }
});
const receiptSchema = z.object({
  actionId: id, requestId: id, requestIds: z.array(id).optional(), planId: id, planVersion: z.number().int().positive(), revision: z.number().int().positive(), updatedAt: timestamp,
  status: z.enum(['pending', 'success', 'failure']), intent: z.enum(['mark_read', 'find_task', 'create_task', 'attach_task', 'reply_ai']),
  source: inboxSourceSchema, input: z.object({ goal: safeText(8000).optional(), title: safeText(300).optional(), project: safeText(300).optional(), selectedTaskId: z.string().optional(), retryStart: z.boolean().optional(), markReadAgain: z.boolean().optional() }).strict(),
  stage: z.enum(['accepted', 'marking_read', 'creating', 'starting', 'sending', 'delivering', 'finished']),
  taskId: z.string().max(128).optional(), taskCreated: z.boolean().optional(), messageId: id.optional(), startAttemptId: z.string().optional(), startedAt: timestamp.optional(),
  execution: z.enum(['starting', 'running', 'unconfirmed', 'not_started']).optional(), delivery: z.enum(['queued', 'deferred', 'skipped', 'failed', 'unconfirmed']).optional(),
  reason: safeText(500).optional(), code: safeText(100).optional(), recovery: z.array(z.enum(['check_status', 'retry_mark_read', 'retry_create', 'retry_start', 'open_task', 'mark_read_again'])),
  attempts: z.array(z.object({ requestId: id, status: z.enum(['pending', 'success', 'failure']), updatedAt: timestamp, execution: z.enum(['starting', 'running', 'unconfirmed', 'not_started']).optional(), reason: safeText(500).optional() })).optional(),
}).strict();
export const inboxItemsSchema = z.array(inboxItemSchema).max(100);
export const inboxPrepareSchema = z.object({
  actionId: id, goal: safeText(8000).optional(), title: safeText(300).optional(), project: safeText(300).optional(),
  selectedTaskId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(), retryStart: z.boolean().optional(), markReadAgain: z.boolean().optional(),
}).strict();
export const inboxExecuteSchema = z.object({ actionId: id, requestId: id, confirmed: z.boolean().optional(), planId: id, planVersion: z.number().int().positive() }).strict();

export function allLetterItems(letter: Pick<LetterRecord, 'items' | 'thread'>): InboxLetterItem[] {
  return [...(letter.items ?? []), ...(letter.thread ?? []).flatMap(e => e.items ?? [])];
}
export function assertItemIds(items: InboxLetterItem[], existing?: Pick<LetterRecord, 'items' | 'thread' | 'actions'>): void {
  const used = new Set(existing?.actions?.map(a => a.id));
  const old = existing ? allLetterItems(existing) : [];
  for (const item of [...old, ...items]) {
    for (const value of [item.id, ...item.actions.map(a => a.id)]) {
      if (used.has(value)) throw new Error(`Duplicate item or action id: ${value}`);
      used.add(value);
    }
  }
}
export function validateNewItems(raw: unknown, existing?: Pick<LetterRecord, 'items' | 'thread' | 'actions'>): InboxLetterItem[] | undefined {
  if (raw === undefined) return undefined;
  const items = inboxItemsSchema.parse(raw);
  assertItemIds(items, existing);
  return items;
}

/** Keep malformed persisted items visible, but never interpret them as runnable actions. */
export function normalizeItems(raw: unknown): InboxLetterItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 100).map((value, index) => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const { receipts, unavailableReason, ...definition } = record;
    const parsed = inboxItemSchema.safeParse(definition);
    const item: InboxLetterItem = parsed.success ? parsed.data : {
      id: typeof record.id === 'string' ? record.id : `invalid-${index}`,
      subject: typeof record.subject === 'string' ? record.subject.slice(0, 1000) : 'Email unavailable',
      summary: typeof record.summary === 'string' ? record.summary.slice(0, 16000) : '',
      source: { kind: 'mail', account: '', message: '' }, actions: [], unavailableReason: 'Invalid saved email item',
    };
    if (typeof unavailableReason === 'string') item.unavailableReason = unavailableReason.slice(0, 500);
    if (Array.isArray(receipts)) {
      item.receipts = receipts.flatMap(rawReceipt => { const parsedReceipt = receiptSchema.safeParse(rawReceipt); return parsedReceipt.success ? [parsedReceipt.data] : []; });
      if (item.receipts.length !== receipts.length) item.unavailableReason = 'Invalid saved execution receipt';
    }
    return item;
  });
}
export function disableDuplicateItems(letter: LetterRecord): LetterRecord {
  const seen = new Map<string, InboxLetterItem>();
  const legacyIds = new Set(letter.actions?.map(a => a.id));
  for (const item of allLetterItems(letter)) {
    for (const value of [item.id, ...item.actions.map(a => a.id)]) {
      const previous = seen.get(value);
      if (previous || legacyIds.has(value)) {
        item.unavailableReason = 'Duplicate saved item or action id';
        if (previous) previous.unavailableReason = item.unavailableReason;
      }
      seen.set(value, item);
    }
  }
  return letter;
}
