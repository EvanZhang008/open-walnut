/**
 * The open asks around a task, read from the store, for the write checks and the status question
 * (same-ask.ts holds the rule and the pure parts).
 *
 * A task's tree: the tasks above it (its leader chain) and every task below it; for Main or a lead,
 * also its team (user-status.ts briefTeam), because their own asks reach the user as letters and
 * Threads, never as a Needs you of their own. An ask is open while it is shown: a task's Needs you
 * (its own question, a Board choice, its decision letter) or an open decision letter of its own.
 */
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import { briefTeam } from './user-status.js';
import {
  FOLDABLE_SOURCES, findSameAsk, SameAskError, sameAskMessage, sameAskReasonOf, type TreeAsk,
} from './same-ask.js';

/** How far a leader chain is walked (subtask-limits.ts caps sessions at 3 levels below a top-level task). */
const MAX_HOPS = 12;
/** At most this many asks ride the status question. */
const QUESTION_ASKS_MAX = 8;

const open = (t: Pick<Task, 'phase' | 'status'>): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/** The tasks around `taskId`, each with where it stands to it. Never the task itself. Pure. */
export function treeAround(taskId: string, everything: readonly Task[]): Array<{ task: Task; relation: TreeAsk['relation'] }> {
  const byId = new Map(everything.map((t) => [t.id, t] as const));
  const self = byId.get(taskId);
  if (!self) return [];
  const out = new Map<string, { task: Task; relation: TreeAsk['relation'] }>();
  let cur = self.parent_task_id ? byId.get(self.parent_task_id) : undefined;
  for (let hops = 0; cur && hops < MAX_HOPS && cur.id !== taskId; hops++) {
    out.set(cur.id, { task: cur, relation: 'ancestor' });
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  const childrenOf = new Map<string, Task[]>();
  for (const t of everything) if (t.parent_task_id) (childrenOf.get(t.parent_task_id) ?? childrenOf.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
  const queue = [...(childrenOf.get(taskId) ?? [])];
  while (queue.length) {
    const t = queue.shift()!;
    if (t.id === taskId || out.has(t.id)) continue;
    out.set(t.id, { task: t, relation: 'descendant' });
    queue.push(...(childrenOf.get(t.id) ?? []));
  }
  if (self.org_role === 'main' || self.org_role === 'lead') {
    for (const t of briefTeam(self, everything)) if (!out.has(t.id)) out.set(t.id, { task: t, relation: 'team' });
  }
  return [...out.values()];
}

/** An open decision letter, as the tree reads it. */
export interface OpenLetter { id: string; subject: string; taskId?: string }

/**
 * The open asks in the tree. `forWrite`: the asks a new ask from `taskId` is checked against: every
 * open decision letter in the tree (the first letter of a decision is where the user answers it),
 * and the status asks of the tasks below it and in its team, never of those above it (the deeper
 * ask is the one shown: an ancestor's folds under it, same-ask.ts). Otherwise every one, for the
 * status question. Pure.
 */
export function treeAsksOf(
  taskId: string, everything: readonly Task[], letters: readonly OpenLetter[], forWrite: boolean,
): TreeAsk[] {
  const around = treeAround(taskId, everything);
  const relationOf = new Map(around.map((a) => [a.task.id, a.relation] as const));
  const out: TreeAsk[] = [];
  for (const { task, relation } of around) {
    const s = task.user_status;
    if (!open(task) || !s || s.state !== 'needs' || !s.ask || !s.source || !FOLDABLE_SOURCES.has(s.source)) continue;
    if (forWrite && relation === 'ancestor') continue;
    out.push({ taskId: task.id, title: task.title, ask: s.ask, where: 'status', relation });
  }
  for (const l of letters) {
    const relation = l.taskId ? relationOf.get(l.taskId) : undefined;
    if (!relation) continue;
    const task = around.find((a) => a.task.id === l.taskId)!.task;
    if (!open(task)) continue;
    out.push({ taskId: task.id, title: task.title, ask: l.subject, where: 'letter', letterId: l.id, relation });
  }
  // The deepest first: a task below, then its team, then above.
  const rank: Record<TreeAsk['relation'], number> = { descendant: 0, team: 1, ancestor: 2 };
  return out.sort((a, b) => rank[a.relation] - rank[b.relation]);
}

async function readOpenLetters(): Promise<OpenLetter[]> {
  const { listLetters } = await import('./human-inbox/store.js');
  const { isOpenDecision } = await import('./human-inbox/duplicate-letter.js');
  const { letters } = await listLetters({ archived: false });
  return letters.filter(isOpenDecision).map((l) => ({ id: l.id, subject: l.subject, taskId: l.sender?.taskId }));
}

/** The tree's open asks, read from the store; the inbox only when the task has a tree at all. */
async function readTree(taskId: string, forWrite: boolean): Promise<{ self?: Task; asks: TreeAsk[] }> {
  const { listTasks } = await import('./task-manager.js');
  const everything = await listTasks();
  const self = everything.find((t) => t.id === taskId);
  if (!treeAround(taskId, everything).length) return { self, asks: [] };
  const letters = await readOpenLetters().catch(() => []);
  return { self, asks: treeAsksOf(taskId, everything, letters, forWrite) };
}

/**
 * Refuse a new ask of the user from `taskId` that its tree already holds (409 `same_ask`), unless
 * `input.same_ask_reason` says why it is a different decision. Never throws anything else: a tree
 * Walnut cannot read lets the ask through.
 */
export async function refuseSameAsk(
  taskId: string | undefined, text: string | undefined, what: 'letter' | 'report' | 'thread',
  input?: { same_ask_reason?: unknown; sameAskReason?: unknown } | null,
): Promise<void> {
  if (!taskId || !text?.trim()) return;
  const reason = sameAskReasonOf(input);
  let hit: TreeAsk | null = null;
  try {
    hit = findSameAsk(text, (await readTree(taskId, true)).asks);
  } catch (err) {
    log.task.debug('same-ask: tree unreadable, ask let through', { taskId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!hit) return;
  if (reason) {
    log.task.info('same-ask: asked again on purpose', { taskId, sameAsTaskId: hit.taskId, what, reason });
    return;
  }
  log.task.info('same-ask: refused', { taskId, sameAsTaskId: hit.taskId, where: hit.where, what });
  throw new SameAskError(sameAskMessage(hit, what), hit);
}

const WHO: Record<TreeAsk['relation'], string> = { descendant: 'your subtask', team: 'your team', ancestor: 'above you' };

/**
 * The turn-end status question's part on the tree's open asks (status-question.ts): '' when none.
 * The session reads who already asks what, and answers FOR_USER_ASK_SAME.
 */
export async function sameAskQuestionFor(taskId: string): Promise<string> {
  let asks: TreeAsk[];
  let self: Task | undefined;
  try {
    ({ self, asks } = await readTree(taskId, false));
  } catch {
    return '';
  }
  const fold = self?.user_status?.sameAsk;
  if (!asks.length && !fold) return '';
  const lines = asks.slice(0, QUESTION_ASKS_MAX).map((a) => `- [${a.taskId}] ${a.title.replace(/\s+/g, ' ').slice(0, 80)} (${WHO[a.relation]}${a.where === 'letter' ? ', a decision letter' : ''}): "${a.ask.replace(/\s+/g, ' ').slice(0, 200)}"`);
  const who = fold ? `[${fold.id}] ${fold.title.replace(/\s+/g, ' ').slice(0, 80)}` : '';
  const folded = !fold ? ''
    : fold.answered
      ? `\nThe user answered your ask through ${who}, which asked the same: get the answer from that task (task_send) and do not ask the user again.`
      : `\nWalnut shows your ask as the same as the one of ${who}, so the user sees it there only.`;
  return `\n\nThe user already has these asks open from this task's tree, and sees each decision once, from the task closest to the work:\n${lines.join('\n') || '- (none open now)'}${folded}\n`
    + 'Do not ask the user again what one of these asks: if it is the decision your FOR_USER_ASK is about, the task that asks it carries the answer (task_send it if you need the answer too).\n'
    + 'FOR_USER_ASK_SAME: needs-you only: the id of the listed task whose ask is the same decision as yours, or "different" when yours is another decision. Otherwise none.';
}
