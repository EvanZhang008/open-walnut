/**
 * The live facts behind a task's Action needed items (action-needed.ts), read on the server once
 * per status pass (user-status-sync.ts): its pending approvals, its sessions' live prompt, its open
 * decision letters. Each fact turns into an item here, so the item's shape has one writer.
 */
import type { ActionItem } from './action-needed.js';
import { detailOf, promptKind } from './action-needed.js';
import type { AskOption } from './user-status.js';
import type { ApprovalView } from './approvals/types.js';
import type { LetterRecord } from './human-inbox/types.js';
import type { SessionRecord } from './types.js';
import { USER_KIND_LEAD_WORDS } from './human-inbox/walnut-letters/thread-words.js';

const one = (s: unknown, max = 200): string => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A pending approval's item. */
export function approvalItem(a: Pick<ApprovalView, 'id' | 'what' | 'createdAt' | 'mode' | 'guard' | 'requester' | 'detail' | 'detailRole'>): ActionItem {
  const summary = one(a.what) || 'Approve a step';
  return {
    kind: 'approval', id: a.id, summary, at: a.createdAt,
    // Only a detail said for the person; a technical one (a command's context, a diff) stays in Details.
    ...(a.detailRole === 'summary' ? detailOf(a.detail, summary) : {}),
    ...(a.requester?.sessionId ? { sessionId: a.requester.sessionId } : {}),
    ...(a.mode === 'biometric' || a.guard ? { proof: true as const } : {}),
  };
}

/** Task id -> its pending approvals' items, oldest first. Only approvals a task's session asked. */
export function approvalItemsByTask(approvals: readonly ApprovalView[]): Map<string, ActionItem[]> {
  const out = new Map<string, ActionItem[]>();
  for (const a of [...approvals].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    const tid = a.requester?.taskId;
    if (a.status !== 'pending' || !tid || a.testRun) continue;
    out.set(tid, [...(out.get(tid) ?? []), approvalItem(a)]);
  }
  return out;
}

type Pending = NonNullable<SessionRecord['pendingPermission']>;

/** A session's live prompt as an item: an AskUserQuestion with its first question and, when it asks
 *  one question, its options; any other tool as a permission with what it would run. */
export function promptItem(sessionId: string, p: Pick<Pending, 'requestId' | 'toolName' | 'input' | 'receivedAt'>): ActionItem {
  const kind = promptKind(p.toolName);
  const input = (p.input ?? {}) as Record<string, unknown>;
  if (kind === 'question') {
    const qs = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
    const q = qs[0] ?? {};
    const options: AskOption[] = qs.length === 1 && Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).map((o, i) => ({ id: String(i), label: one(o?.label, 80) })).filter((o) => o.label).slice(0, 6) : [];
    const more = qs.length > 1 ? ` (+${qs.length - 1} more)` : '';
    return {
      kind, id: p.requestId, summary: (one(q.question) || 'Answer its question') + more, at: p.receivedAt, sessionId, blocking: true,
      ...(options.length ? { options } : {}), ...(qs.length === 1 && q.multiSelect === true ? { multi: true as const } : {}),
      ...(qs.length === 1 && typeof q.question === 'string' && q.question.length <= 2000 ? { question: q.question } : {}),
    };
  }
  const what = one(input.description, 160) || one(input.command, 160) || one(input.file_path, 160) || one(input.url, 160);
  const tool = p.toolName || 'a tool';
  return { kind, id: p.requestId, summary: what ? `Allow ${tool}: ${what}` : `Allow ${tool}?`, at: p.receivedAt, sessionId, blocking: true };
}

/** The kind words a decision letter starts with, in every language Walnut writes them: built from
 *  USER_KIND_LEAD_WORDS itself, so a reworded or new language is stripped too. The reason after them stays. */
const KIND_LEAD = (() => {
  const KIND = '\uE000', WHY = '\uE001';
  const leads = Object.values(USER_KIND_LEAD_WORDS).map((words) => words(KIND, WHY).split(WHY)[0]!.trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(KIND, '[^)\\uFF09]*?'));
  return new RegExp(`^\\s*(?:${leads.join('|')})\\s*`);
})();

/** An open decision letter's item: its subject and its buttons. */
export function letterItem(l: Pick<LetterRecord, 'id' | 'subject' | 'createdAt' | 'actions'> & { textPreview?: string }): ActionItem {
  const options = (l.actions ?? []).map((a) => ({ id: a.id, label: one(a.label, 80) })).filter((o) => o.label).slice(0, 6);
  const summary = one(l.subject) || 'A letter waits for your answer';
  // Its preview without the kind words Walnut leads a decision with (thread-words.ts USER_KIND_LEAD_WORDS).
  const preview = (l.textPreview ?? '').replace(KIND_LEAD, '');
  return { kind: 'letter', id: l.id, summary, ...detailOf(preview, summary), at: new Date(l.createdAt).toISOString(), ...(options.length ? { options } : {}) };
}
