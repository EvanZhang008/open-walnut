/**
 * One subject is one thread, kept by one task (2026-11-23, the user, after one issue got three
 * threads in a row on his task tree: "one thread is one issue, why does it repeat"; "not only the
 * instruction, change the code"; "it should be maintained by a single task ... so that it wouldn't
 * cause a single thread to appear in all different places, like in VP, in leaders, and in the
 * subtask"). What his data showed (64 threads on one task and its subtasks):
 *   - a leader task opened 12 threads in one second, each a copy of a subject its subtask already
 *     kept a thread on (each named that subtask in `tasks`): `copiesTaskBelow`;
 *   - a node opened a second thread on a subject it had opened one on the day before, in nearly
 *     the same words: `strongMatch`, over the open threads of its tree and team.
 * A refused thread_create names the open threads and takes `separate_reason` (the reason
 * thread-supersede.ts takes) when the subject really is another. A status line's new subject
 * (FOR_USER_THREAD_NEW) cannot be asked back: one that repeats an open title opens nothing.
 * Words alone miss a subject told in other words, so this is a brake, not a proof: the rule in
 * words is the status question's line format (sessions/status-threads.ts keptBlock), and merge_into joins what got through.
 */
import type { Task } from '../types.js';
import type { OrgThread, ThreadWriter } from './threads-model.js';

/** `of`: the telling words of the new title; `theirs`: of the open thread's title. */
export interface SubjectCandidate { id: string; title: string; taskId: string; taskTitle: string; shared: number; of: number; theirs: number; updatedAt: string }
/** `below`: a task under the one asking (its subtask, however deep). */
export interface TreeThreads { task: Pick<Task, 'id' | 'title'>; threads: readonly OrgThread[]; below?: boolean }

/** At most this many tasks around it are read, and this many open threads named in a refusal. */
const TREE_TASKS_MAX = 40;
const NAMED_MAX = 6;
/** An open thread older than this is not asked about. */
const RECENT_MS = 14 * 24 * 3_600_000;

const COMMON = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'what', 'when', 'where', 'which', 'your', 'you', 'his', 'her', 'are', 'was', 'has', 'have', 'not', 'need', 'needs', 'about', 'after', 'before', 'still', 'now', 'new', 'one', 'all', 'can', 'should', 'will']);
/** CJK pairs that say nothing about a subject (need, problem, task, this, today ...). */
const COMMON_PAIRS = new Set(['\u9700\u8981', '\u95ee\u9898', '\u4efb\u52a1', '\u4e00\u4e2a', '\u8fd9\u4e2a', '\u90a3\u4e2a', '\u6ca1\u6709', '\u5df2\u7ecf', '\u53ef\u4ee5', '\u4ec0\u4e48', '\u8fdb\u884c', '\u73b0\u5728', '\u4eca\u5929', '\u6628\u5929', '\u5b8c\u6210', '\u6211\u4eec', '\u4f60\u7684', '\u5904\u7406', '\u4e00\u4e0b', '\u8fd8\u662f', '\u662f\u5426', '\u8981\u4e0d', '\u4e0d\u8981']);

/**
 * The telling words of a title, by the place they stand in: each Latin word of 3+ letters (common
 * ones out), number or id is a place of its own, and a run of CJK characters is one place holding
 * its pairs of characters. Pure.
 */
function subjectPlaces(text: string): string[][] {
  const out: string[][] = [];
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9_\-.]*[a-z0-9]|[0-9]{2,}/g) ?? []) {
    if (/^[0-9.\-]+$/.test(w) ? w.replace(/\D/g, '').length >= 2 : w.length >= 3 && !COMMON.has(w)) out.push([w]);
  }
  for (const run of lower.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
    const pairs: string[] = [];
    for (let i = 0; i + 1 < run.length; i++) if (!COMMON_PAIRS.has(run.slice(i, i + 2))) pairs.push(run.slice(i, i + 2));
    if (pairs.length) out.push(pairs);
  }
  return out;
}

/** The words a title is compared by: Latin words of 3+ letters (common ones out), numbers and ids, pairs of CJK characters. Pure. */
export function subjectWords(text: string): Set<string> {
  return new Set(subjectPlaces(text).flat());
}

/**
 * In how many places of `title` a telling word of `other` stands. A name of four CJK characters is
 * three pairs in ONE place: two titles that share only their area's name ("the model proxy: ...")
 * share one place, however many pairs that is (review 2026-11-24). Pure.
 */
export function sharedPlaces(title: string, other: string): number {
  const theirs = subjectWords(other);
  return subjectPlaces(title).filter((place) => place.some((w) => theirs.has(w))).length;
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** A word in this many of the tree's open threads (or a sixth of them) says nothing about one subject there: a date, the product's name. */
const EVERYWHERE_MIN = 4;

/**
 * The open threads of the tree that share a telling word with `title`, most shared first, then the
 * newest. `of`: how many telling words the title has. Pure.
 */
export function sameSubjectCandidates(title: string, tree: readonly TreeThreads[], now: number): SubjectCandidate[] {
  return candidatesIn(subjectIndex(tree, now), title);
}

/** The open threads of a tree with their telling words, read once for many titles (candidatesIn). */
export interface SubjectIndex {
  rows: ReadonlyArray<{ t: OrgThread; task: TreeThreads['task']; words: Set<string>; theirs: number }>;
  seenIn: ReadonlyMap<string, number>;
  everywhere: number;
}

/** The index sameSubjectCandidates reads, built once (a node comparing many titles with its own threads). Pure. */
export function subjectIndex(tree: readonly TreeThreads[], now: number): SubjectIndex {
  const rows: Array<{ t: OrgThread; task: TreeThreads['task']; words: Set<string> }> = [];
  for (const { task, threads } of tree) {
    for (const t of threads) {
      if (!t.closed && now - Date.parse(t.updatedAt) <= RECENT_MS) rows.push({ t, task, words: subjectWords(t.title) });
    }
  }
  const seenIn = new Map<string, number>();
  for (const r of rows) for (const w of r.words) seenIn.set(w, (seenIn.get(w) ?? 0) + 1);
  const everywhere = Math.max(EVERYWHERE_MIN, Math.ceil(rows.length / 6));
  return { rows: rows.map((r) => ({ ...r, theirs: [...r.words].filter((w) => (seenIn.get(w) ?? 0) < everywhere).length })), seenIn, everywhere };
}

/** sameSubjectCandidates over an index. Pure. */
export function candidatesIn(index: SubjectIndex, title: string): SubjectCandidate[] {
  const { rows, seenIn, everywhere } = index;
  const mine = new Set([...subjectWords(title)].filter((w) => (seenIn.get(w) ?? 0) < everywhere));
  const out: SubjectCandidate[] = [];
  for (const r of rows) {
    const shared = sharedCount(mine, r.words);
    if (shared) out.push({ id: r.t.id, title: r.t.title, taskId: r.task.id, taskTitle: r.task.title, shared, of: mine.size, theirs: r.theirs, updatedAt: r.t.updatedAt });
  }
  return out.sort((a, b) => b.shared - a.shared || b.updatedAt.localeCompare(a.updatedAt));
}

/** A title of this many telling words or fewer needs one more shared word: "Mac app build fails" is not "iOS app build fails". */
const SHORT_TITLE = 5;

/**
 * The open thread a new title clearly repeats: three telling words shared (four when either title is
 * short), and half of its own (review 2026-11-23: three shared words called "Mac app build icon
 * missing" the same as "Mac app build fails"). Not half of the other's too: that lost a true repeat in
 * one error told once by a place name and once by its short code in a longer title. Pure.
 */
export function strongMatch(candidates: readonly SubjectCandidate[]): SubjectCandidate | undefined {
  return candidates.find((c) => c.shared >= (Math.min(c.of, c.theirs) <= SHORT_TITLE ? 4 : 3) && c.shared * 2 >= c.of);
}

/** Why a new thread was refused, naming the open ones it may repeat. Pure. */
export function sameSubjectRefusal(candidates: readonly SubjectCandidate[], ownTaskId: string): string {
  const named = candidates.slice(0, NAMED_MAX).map((c) => `${c.id} "${c.title}"${c.taskId === ownTaskId ? '' : ` (on task "${c.taskTitle}", ${c.taskId})`}`);
  const more = candidates.length > NAMED_MAX ? ` and ${candidates.length - NAMED_MAX} more (thread_list)` : '';
  return `One subject is one thread, and yours reads like one open on this task or the tasks around it: ${named.join('; ')}${more}. `
    + 'If yours is the subject of one of them, write there instead: thread_update on yours (merge_into joins two of yours), '
    + 'or task_send the task that holds it. If it is another subject, call thread_create again with separate_reason saying how it differs.';
}

/**
 * The task's own threads and those of the tasks above, below and beside it (its team) that keep
 * threads: the ones `named` (a thread's tasks) always, then up to TREE_TASKS_MAX by relation and newest
 * change. 2026-11-24, the thread monitor's [copy]: his VP has 59 open tasks below it, and the one its
 * thread named came 47th in tree order, past the cap, so the copy rule never read it.
 */
export async function treeOpenThreads(taskId: string, named: readonly string[] = []): Promise<TreeThreads[]> {
  const { listTasks } = await import('../task-manager.js');
  const { treeAround } = await import('../same-ask-tree.js');
  const { keepsThreads } = await import('./keeps-threads.js');
  const { readThreads } = await import('./threads-store.js');
  const everything = await listTasks();
  const self = everything.find((t) => t.id === taskId);
  if (!self) return [];
  // Above and below it first, then its team (a lead's team, a task's teammates): one subject may be
  // opened by the lead, a task and its subtask (2026-11-23, the user: "it should be maintained by a
  // single task ... it wouldn't cause a single thread to appear in all different places").
  const rank = { ancestor: 0, descendant: 1, team: 2 } as Record<string, number>;
  // A finished task's leftover threads hold no subject open any more (review 2026-11-23).
  const wanted = new Set(named);
  const live = treeAround(taskId, everything).filter((a) => a.task.phase !== 'COMPLETE' && (keepsThreads(a.task) || !!a.task.org_role));
  const around = [
    ...live.filter((a) => wanted.has(a.task.id)),
    ...live.filter((a) => !wanted.has(a.task.id))
      .sort((a, b) => (rank[a.relation] ?? 3) - (rank[b.relation] ?? 3) || (b.task.updated_at ?? '').localeCompare(a.task.updated_at ?? ''))
      .slice(0, TREE_TASKS_MAX),
  ];
  // Below it: its subtasks, and for Main or a lead the tasks of its team.
  const isBelow = (relation: string) => relation === 'descendant' || (relation === 'team' && !!self.org_role);
  const out: TreeThreads[] = [];
  for (const { task, below } of [{ task: self, below: false }, ...around.map((a) => ({ task: a.task, below: isBelow(a.relation) }))]) {
    const threads = (await readThreads(task.id).catch(() => null))?.threads ?? [];
    if (threads.some((t) => !t.closed)) out.push({ task: { id: task.id, title: task.title }, threads, ...(below ? { below } : {}) });
  }
  return out;
}

/**
 * The new subjects of a status answer, sorted: `fresh` repeat no open thread of the tree (they open
 * one), `own` repeat an open thread of the task itself (the line is that thread's), `elsewhere` one
 * of another task (it keeps it; the line opens nothing). Never throws.
 */
export async function newSubjectsOnly<T extends { title: string }>(taskId: string, opened: readonly T[]): Promise<{ fresh: T[]; own: Array<{ item: T; id: string }>; elsewhere: Array<{ item: T; id: string; taskId: string }> }> {
  const out = { fresh: [] as T[], own: [] as Array<{ item: T; id: string }>, elsewhere: [] as Array<{ item: T; id: string; taskId: string }> };
  const tree = await treeOpenThreads(taskId).catch(() => [] as TreeThreads[]);
  const now = Date.now();
  for (const item of opened) {
    const match = tree.length ? strongMatch(sameSubjectCandidates(item.title, tree, now)) : undefined;
    if (!match) out.fresh.push(item);
    else if (match.taskId === taskId) out.own.push({ item, id: match.id });
    else out.elsewhere.push({ item, id: match.id, taskId: match.taskId });
  }
  return out;
}

/** Why a thread that copies a subject of a task below was refused. Pure. */
export function copyRefusal(below: Pick<Task, 'id' | 'title'>, theirs: readonly OrgThread[]): string {
  const named = theirs.slice(0, NAMED_MAX).map((t) => `${t.id} "${t.title}"`);
  const more = theirs.length > NAMED_MAX ? ` and ${theirs.length - NAMED_MAX} more` : '';
  return `One subject is kept by one task: "${below.title}" (${below.id}) keeps its own Threads (${named.join('; ')}${more}). The user `
    + 'reads them there, and each that waits on him also on your Threads, named by that task. Do not open a copy on yours: '
    + `have that task write its thread (task_send ${below.id}), or say where it stands in your chat reply. If yours is a subject `
    + `none of its threads covers, call thread_create again with a separate_reason that names ${below.id} and says how yours differs from its threads.`;
}

/**
 * A separate_reason lets a thread that names a task below through only when it is about that task:
 * it names the task (its id, or the first 8 characters of it) and says something (10 characters or
 * more). 2026-11-23, the thread monitor's [copy]: a lead opened a card asking him to review its
 * subtask's change, naming the subtask, which kept the subject in its own threads, with a
 * separate_reason about another card of its own ("the design-rule decision is a separate card"). Pure.
 */
export function reasonCoversTask(reason: unknown, taskId: string): boolean {
  if (typeof reason !== 'string' || reason.trim().length < 10) return false;
  return reason.includes(taskId) || reason.includes(taskId.slice(0, 8));
}

/** Why handing him a thread was refused: a task around already asks its subject. Pure. */
export function sameSubjectAskRefusal(c: SubjectCandidate): string {
  return `Not handed to the user: "${c.taskTitle}" (${c.taskId}) already asks him this subject on its thread ${c.id} "${c.title}", and he sees `
    + 'that card on every node above it. One decision is asked in one place: write your thread without asking (state answered or working, '
    + `with your own result), or have that task take its ask off (task_send ${c.taskId}). If yours is another decision, send this again with `
    + 'separate_reason saying how it differs.';
}

/**
 * A node handing him a thread (thread_update to needs) while a task around it already asks him on a
 * thread of its own that this one clearly repeats (strongMatch): 409 `same_subject`, unless
 * `separate_reason` says how it differs. Two cards asking one decision are never hidden behind one
 * another at the read (a pointer could hide an ask he never answered); the second ask is refused at
 * the write, where its writer can say it is another one. The user's own writes are never asked.
 */
export async function refuseSameSubjectAsk(taskId: string, title: string, tasks: readonly string[], by: ThreadWriter, input: { separate_reason?: unknown }): Promise<void> {
  if (by === 'human' || (typeof input.separate_reason === 'string' && input.separate_reason.trim().length >= 10)) return;
  const asking = (await treeOpenThreads(taskId, tasks))
    .filter((b) => b.task.id !== taskId)
    .map((b) => ({ ...b, threads: b.threads.filter((t) => t.state === 'needs') }));
  const hit = strongMatch(sameSubjectCandidates(title, asking, Date.now()));
  if (!hit) return;
  const { ThreadError } = await import('./threads-model.js');
  throw new ThreadError('same_subject', 409, sameSubjectAskRefusal(hit));
}

/**
 * thread_create by a node: 409 `same_subject` when it names a task below that keeps open threads of
 * its own (a copy of that task's subject), or when its title clearly repeats an open thread of its
 * tree or team; unless `separate_reason` says why its subject is another, or it names that thread
 * as replaced (`supersedes`). The user's own opens are never asked.
 */
export async function refuseSameSubjectThread(taskId: string, title: string, by: ThreadWriter, input: { separate_reason?: unknown; supersedes?: readonly string[]; tasks?: readonly string[] }): Promise<void> {
  if (by === 'human') return;
  const reasoned = typeof input.separate_reason === 'string' && input.separate_reason.trim().length >= 10;
  // Nothing named below and a reason given: no tree to read.
  if (reasoned && !input.tasks?.length) return;
  const tree = await treeOpenThreads(taskId, input.tasks ?? []);
  const { ThreadError } = await import('./threads-model.js');
  // It names a task below that keeps open threads: that task does the work, so it keeps the subject,
  // its questions to him included (they show on this node's Threads from there). Not narrowed to titles
  // that share a word: in his data 5 of the 12 copies shared none with the subtask's threads (the
  // subtask's findings reported as the leader's own), review 2026-11-23. Its threads nearest the title first.
  const named = new Set(input.tasks ?? []);
  const below = tree.find((b) => b.task.id !== taskId && b.below && named.has(b.task.id) && !reasonCoversTask(input.separate_reason, b.task.id));
  if (below) {
    const near = sameSubjectCandidates(title, [below], Date.now()).map((c) => c.id);
    const open = below.threads.filter((t) => !t.closed);
    const rank = (t: OrgThread) => { const i = near.indexOf(t.id); return i < 0 ? near.length : i; };
    throw new ThreadError('same_subject', 409, copyRefusal(below.task, [...open].sort((a, b) => rank(a) - rank(b))));
  }
  if (reasoned) return;
  // A thread it says this one replaces (thread-supersede.ts) is that subject's end, not a repeat of it.
  const replaced = new Set(input.supersedes ?? []);
  const candidates = sameSubjectCandidates(title, tree, Date.now()).filter((c) => !replaced.has(c.id));
  if (strongMatch(candidates)) throw new ThreadError('same_subject', 409, sameSubjectRefusal(candidates.filter((c) => c.shared >= 2), taskId));
}
