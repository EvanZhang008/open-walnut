/**
 * The open asks around a task, read from the store, for the write checks and the status question
 * (same-ask.ts holds the rule and the pure parts).
 *
 * A task's tree: the tasks above it (its leader chain), every task below it, and its teammates
 * beside it (teamKeysOf: under the same top-level task, or in a project the same lead or VP leads;
 * never Main's whole org); for Main or a lead, its team (user-status.ts briefTeam), because their own
 * asks reach the user as letters and Threads, never as a Needs you of their own. An ask is open while
 * it is shown: a task's Needs you (its own question, a Board choice, its decision letter) or an open
 * decision letter of its own.
 *
 * Every read here stays inside the task's incoming-item area (router/same-area.ts): a task in an
 * area sees only tasks of that area, a task in none sees only tasks in none, so a status question,
 * a fold or a refusal never carries another area's ask or title.
 */
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import { briefTeam } from './user-status.js';
import { sameTaskArea } from './router/same-area.js';
import {
  FOLDABLE_SOURCES, answeredAskMessage, answerFor, answersOf, findSameAsk, SameAskError, sameAskMessage, sameAskReasonOf, type RelativeAsk, type TreeAsk,
} from './same-ask.js';

/** How far a leader chain is walked (subtask-limits.ts caps sessions at 3 levels below a top-level task). */
const MAX_HOPS = 12;
/** At most this many asks ride the status question. */
const QUESTION_ASKS_MAX = 8;

const open = (t: Pick<Task, 'phase' | 'status'>): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';
const projectKey = (p: string | undefined) => (p ?? '').trim().toLowerCase();

/**
 * The teams a task is in, as keys: `root:<id>`, the top-level task it is under (itself when it has
 * no leader; the walk stops below Main, a VP or a lead), and `lead:<id>` for each open lead or VP
 * that leads it: one it is under, or one whose projects (Task.project, org_leads) hold its project.
 * Two tasks share a team when they share a key. Main is no team: its org is every project. Pure.
 */
export function teamKeysOf(task: Task, byId: ReadonlyMap<string, Task>, leads: readonly Task[]): string[] {
  let root = task;
  const keys: string[] = [];
  for (let hops = 0; root.parent_task_id && hops < MAX_HOPS; hops++) {
    const up = byId.get(root.parent_task_id);
    if (!up || up.id === task.id) break;
    if (up.org_role) {
      if (up.org_role === 'lead' && open(up)) keys.push(`lead:${up.id}`);
      break;
    }
    root = up;
  }
  keys.push(`root:${root.id}`);
  // Its own project only: a subtask filed in another project is that project's, and its top-level
  // task's tree (the root key) already holds it with its own family.
  const projects = new Set([projectKey(task.project)].filter(Boolean));
  for (const l of leads) {
    if (keys.includes(`lead:${l.id}`)) continue;
    if ([l.project, ...(l.org_leads ?? [])].some((p) => projects.has(projectKey(p)))) keys.push(`lead:${l.id}`);
  }
  return keys;
}

/** A task that is in a team: open, not Main, a VP or a lead (never Needs you), not a plugin's own. */
const member = (t: Task): boolean => open(t) && !t.org_role && !t.plugin_only;

/** Its leader chain, by id. */
function ancestorsOf(task: Task, byId: ReadonlyMap<string, Task>): Set<string> {
  const out = new Set<string>();
  let cur = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
  for (let hops = 0; cur && hops < MAX_HOPS && cur.id !== task.id; hops++) {
    out.add(cur.id);
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  return out;
}

/**
 * Every task's teammates beside it: in one of its teams, never itself, a task above it or one
 * below it (those are its leader chain and its subtasks, which fold by depth). `only` keeps the
 * members it is given (the ones that ask the user), the first made first. Pure.
 */
export function teammatesIndex(everything: readonly Task[], only: (t: Task) => boolean = () => true): (task: Task) => Task[] {
  const byId = new Map(everything.map((t) => [t.id, t] as const));
  const leads = everything.filter((t) => t.org_role === 'lead' && open(t));
  const keysOf = new Map<string, string[]>();
  const keys = (t: Task) => keysOf.get(t.id) ?? keysOf.set(t.id, teamKeysOf(t, byId, leads)).get(t.id)!;
  const byKey = new Map<string, Task[]>();
  for (const t of everything) {
    if (!member(t) || !only(t)) continue;
    for (const k of keys(t)) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  return (task) => {
    if (!member(task)) return [];
    const above = ancestorsOf(task, byId);
    const seen = new Map<string, Task>();
    for (const k of keys(task)) {
      for (const t of byKey.get(k) ?? []) {
        if (t.id === task.id || above.has(t.id) || seen.has(t.id) || ancestorsOf(t, byId).has(task.id)) continue;
        if (!sameTaskArea(task, t)) continue;
        seen.set(t.id, t);
      }
    }
    // The first made first (one with no time last), as same-ask.ts ranks them.
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    return [...seen.values()].sort((a, b) => cmp(a.created_at || '\uffff', b.created_at || '\uffff') || cmp(a.id, b.id));
  };
}

/** A task's own question shown to the user now, foldable (a session's question, a Board choice). */
const shownAsk = (t: Task): boolean => {
  const s = t.user_status;
  return !!s && s.state === 'needs' && !!s.ask && !!s.source && FOLDABLE_SOURCES.has(s.source);
};

/** An ask a lead, VP or Main answered for the user, which the task still holds (same-ask.ts answeredAbove). */
const answeredAsk = (t: Task): boolean => !!t.user_status?.answeredFor?.ask;

/**
 * The status sync's read of teammates: for each task, the asks beside it, the first made first:
 * the ones shown to the user now, and the ones a lead, VP or Main answered there. Pure.
 */
export function relativeAsksIndex(everything: readonly Task[]): (task: Task) => RelativeAsk[] {
  const of = teammatesIndex(everything, (t) => shownAsk(t) || answeredAsk(t));
  return (task) => of(task).map((t) => shownAsk(t)
    ? { id: t.id, title: t.title, ask: t.user_status!.ask!, createdAt: t.created_at }
    : { id: t.id, title: t.title, ask: t.user_status!.answeredFor!.ask, createdAt: t.created_at, answered: true as const });
}

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
  } else {
    for (const t of teammatesIndex(everything)(self)) if (!out.has(t.id)) out.set(t.id, { task: t, relation: 'team' });
  }
  return [...out.values()].filter((a) => sameTaskArea(self, a.task));
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
  const rank: Record<TreeAsk['relation'], number> = { descendant: 0, team: 1, ancestor: 2, elsewhere: 3 };
  return out.sort((a, b) => rank[a.relation] - rank[b.relation]);
}

async function readOpenLetters(): Promise<OpenLetter[]> {
  const { listLetters } = await import('./human-inbox/store.js');
  const { isOpenDecision } = await import('./human-inbox/duplicate-letter.js');
  const { letters } = await listLetters({ archived: false });
  return letters.filter(isOpenDecision).map((l) => ({ id: l.id, subject: l.subject, taskId: l.sender?.taskId }));
}

/** The tree's open asks, read from the store; the inbox only when the task has a tree at all. */
async function readTree(taskId: string, forWrite: boolean): Promise<{ self?: Task; asks: TreeAsk[]; everything: Task[] }> {
  const { listTasks } = await import('./task-manager.js');
  const everything = await listTasks();
  const self = everything.find((t) => t.id === taskId);
  if (!treeAround(taskId, everything).length) return { self, asks: [], everything };
  const letters = await readOpenLetters().catch(() => []);
  return { self, asks: treeAsksOf(taskId, everything, letters, forWrite), everything };
}

/**
 * Refuse a new ask of the user from `taskId` that its tree already holds (409 `same_ask`), unless
 * `input.same_ask_reason` says why it is a different decision. Never throws anything else: a tree
 * Walnut cannot read lets the ask through.
 */
export async function refuseSameAsk(
  taskId: string | undefined, text: string | undefined, what: 'letter' | 'report' | 'thread',
  input?: { same_ask_reason?: unknown; sameAskReason?: unknown } | null,
  /** The parts of the ask beside `text` (a letter's numbered items), checked against what was answered. */
  parts: readonly string[] = [],
): Promise<void> {
  if (!taskId || !text?.trim()) return;
  const reason = sameAskReasonOf(input);
  let hit: TreeAsk | null = null;
  let everything: Task[] = [];
  try {
    const { listTasks } = await import('./task-manager.js');
    everything = await listTasks();
    hit = findSameAsk(text, (await readTree(taskId, true)).asks);
  } catch (err) {
    log.task.debug('same-ask: tree unreadable, ask let through', { taskId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (reason) {
    if (hit) log.task.info('same-ask: asked again on purpose', { taskId, sameAsTaskId: hit.taskId, what, reason });
    return;
  }
  if (hit) {
    log.task.info('same-ask: refused', { taskId, sameAsTaskId: hit.taskId, where: hit.where, what });
    throw new SameAskError(sameAskMessage(hit, what), hit);
  }
  // Answered already for the user by a lead, VP or Main: the whole ask, or one part of it again.
  const self = everything.find((t) => t.id === taskId);
  const answers = answersOf(self);
  if (answers.length) {
    for (const ask of [text, ...parts]) {
      const answer = answerFor(answers, ask);
      if (!answer) continue;
      log.task.info('same-ask: refused, answered above', { taskId, by: answer.by, what });
      throw new SameAskError(answeredAskMessage(answer, what), { taskId, title: self?.title ?? taskId, ask: answer.ask, where: 'status', relation: 'ancestor' });
    }
  }
  await refuseSignInAsk(taskId, text, what, everything);
}

/**
 * A sign-in ask (sign-in-ask.ts) is put on the user once: never while a sign-in letter is open or a
 * checker says sign-in works, and never beside another task's sign-in ask, whatever its team.
 */
async function refuseSignInAsk(taskId: string, text: string, what: 'letter' | 'report' | 'thread', everything: readonly Task[]): Promise<void> {
  const { isSignInAsk, loginCommandWords, readSignInState, signInRefusal } = await import('./sign-in-ask.js');
  const { getConfig } = await import('./config-manager.js');
  const words = loginCommandWords((await getConfig().catch(() => ({}) as { ssh_login_hint?: string })).ssh_login_hint);
  if (!isSignInAsk(text, words)) return;
  const why = signInRefusal(await readSignInState());
  const dummy = { taskId, title: '', ask: text, where: 'status' as const, relation: 'elsewhere' as const };
  if (why) {
    log.task.info('same-ask: sign-in ask refused, the sign-in state is known', { taskId, what });
    throw new SameAskError(why, dummy);
  }
  const self = everything.find((t) => t.id === taskId) ?? { id: taskId };
  const other = everything.find((t) => t.id !== taskId && sameTaskArea(self, t) && t.phase !== 'COMPLETE' && t.status !== 'done'
    && t.user_status?.state === 'needs' && t.user_status.source === 'session' && isSignInAsk(t.user_status.ask, words));
  if (!other) return;
  const hit: TreeAsk = { taskId: other.id, title: other.title, ask: other.user_status!.ask!, where: 'status', relation: 'elsewhere' };
  log.task.info('same-ask: sign-in ask refused, another task asks it', { taskId, sameAsTaskId: other.id, what });
  throw new SameAskError(sameAskMessage(hit, what), hit);
}

const WHO: Record<TreeAsk['relation'], string> = { descendant: 'your subtask', team: 'your team', ancestor: 'above you', elsewhere: 'another team' };

/**
 * The turn-end status question's part on the tree's open asks (status-question.ts): '' when none.
 * The session reads who already asks what, and answers FOR_USER_ASK_SAME.
 */
export async function sameAskQuestionFor(taskId: string): Promise<string> {
  let asks: TreeAsk[];
  let self: Task | undefined;
  let everything: Task[] = [];
  try {
    ({ self, asks, everything } = await readTree(taskId, false));
  } catch {
    return '';
  }
  // A stored fold names its task only when that task is known and in the same area (one stored
  // before the area mark, or naming a task gone from the store, is left out).
  const stored = self?.user_status?.sameAsk;
  const foldTask = stored ? everything.find((t) => t.id === stored.id) : undefined;
  const fold = stored && self && foldTask && sameTaskArea(self, foldTask) ? stored : undefined;
  const above = self?.user_status?.answeredFor;
  if (!asks.length && !fold && !above) return '';
  const lines = asks.slice(0, QUESTION_ASKS_MAX).map((a) => `- [${a.taskId}] ${a.title.replace(/\s+/g, ' ').slice(0, 80)} (${WHO[a.relation]}${a.where === 'letter' ? ', a decision letter' : ''}): "${a.ask.replace(/\s+/g, ' ').slice(0, 200)}"`);
  const who = fold ? `[${fold.id}] ${fold.title.replace(/\s+/g, ' ').slice(0, 80)}` : '';
  const folded = !fold ? ''
    : fold.answered
      ? `\nThe user answered your ask through ${who}, which asked the same: get the answer from that task (task_send) and do not ask the user again.`
      : `\nWalnut shows your ask as the same as the one of ${who}, so the user sees it there only.${fold.team ? ' If your pick differs from its, tell it (task_send) so its ask carries both views.' : ''}`;
  const answered = above
    ? `\n${above.byTitle.replace(/\s+/g, ' ').slice(0, 80)} answered your ask for the user ("${above.ask.replace(/\s+/g, ' ').slice(0, 160)}"), and Walnut took it off the user's Needs you: act on that answer and do not ask it again.`
    : '';
  return `\n\nThe user already has these asks open from this task's tree, and sees each decision once, from the task closest to the work:\n${lines.join('\n') || '- (none open now)'}${folded}${answered}\n`
    + 'Do not ask the user again what one of these asks: if it is the decision your FOR_USER_ASK is about, the task that asks it carries the answer (task_send it if you need the answer too).\n'
    + 'FOR_USER_ASK_SAME: needs-you only: the id of the listed task whose ask is the same decision as yours, or "different" when yours is another decision. Otherwise none.';
}
