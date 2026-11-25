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
import { askDecisionQuestion } from './ask-decision.js';
import { askMatter, matterIndex, matterKeysInText, matterNamedIn, matterWords, sharedMatter } from './ask-matter.js';
import {
  FOLDABLE_SOURCES, askKey, outletVerb, type AskOutlet, answeredAskMessage, answerFor, answersOf, findSameAsk, SameAskError, sameAskMessage, sameAskReasonOf, type AnswerDecision, type RelativeAsk, type TreeAsk,
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
export function teamKeysOf(task: Task, byId: ReadonlyMap<string, Task>, leads: readonly Task[], isOpen: (t: Task) => boolean = open): string[] {
  let root = task;
  const keys: string[] = [];
  for (let hops = 0; root.parent_task_id && hops < MAX_HOPS; hops++) {
    const up = byId.get(root.parent_task_id);
    if (!up || up.id === task.id) break;
    if (up.org_role) {
      if (up.org_role === 'lead' && isOpen(up)) keys.push(`lead:${up.id}`);
      break;
    }
    root = up;
  }
  keys.push(`root:${root.id}`);
  // Its own project only: a subtask filed in another project is that project's, and its top-level
  // task's tree (the root key) already holds it with its own family.
  const own = projectKey(task.project);
  for (const l of own ? leadsByProject(leads).get(own) ?? [] : []) {
    if (!keys.includes(`lead:${l.id}`)) keys.push(`lead:${l.id}`);
  }
  return keys;
}

/**
 * The leads of each project key, in the order `leads` lists them, built once per `leads` array:
 * teamKeysOf runs for every task of the board, so a scan of every lead's projects per task made one
 * read of the board cost tasks x leads x projects (2026-11-20: 7,900 tasks held the event loop for
 * seconds at a time, every Threads read of every node). Callers never edit `leads` in place.
 */
const leadIndexes = new WeakMap<readonly Task[], { size: number; byProject: Map<string, Task[]> }>();
function leadsByProject(leads: readonly Task[]): ReadonlyMap<string, readonly Task[]> {
  const cached = leadIndexes.get(leads);
  if (cached && cached.size === leads.length) return cached.byProject;
  const byProject = new Map<string, Task[]>();
  for (const l of leads) {
    for (const p of new Set([l.project, ...(l.org_leads ?? [])].map(projectKey).filter(Boolean))) {
      (byProject.get(p) ?? byProject.set(p, []).get(p)!).push(l);
    }
  }
  leadIndexes.set(leads, { size: leads.length, byProject });
  return byProject;
}

/** A task that is in a team: open, not Main, a VP or a lead (never Needs you), not a plugin's own. */
const member = (t: Task, isOpen: (t: Task) => boolean = open): boolean => isOpen(t) && !t.org_role && !t.plugin_only;

/**
 * Membership options. `allOpen`: every task counts as open, for the readers that must still see a
 * finished task's answered decision (withTaskAsks, resolveDecisionOwner). They used to pass a copy
 * of every finished task marked open, about 7,000 object copies per call on a real board.
 */
export interface TreeOptions { allOpen?: boolean }
const everyOpen = (): boolean => true;

/**
 * The id and children index of one task list, and its teammates index per openness, built once
 * per list: one pass over the board reads the tree of every node with the same list
 * (thread-popup.ts poppedIndex, user-status-sync.ts), and each read rebuilt them all
 * (2026-11-24: withTaskAsks was a quarter of the server's CPU in a memory burst after a restart).
 * Keyed by the array itself, like leadsByProject: callers never edit a task list in place.
 */
interface TreeIndex {
  byId: Map<string, Task>;
  childrenOf?: Map<string, Task[]>;
  teammates: Map<boolean, (task: Task) => Task[]>;
  /** treeAround's answers for this list, by task id and allOpen (frozen rows). */
  around: Map<string, ReadonlyArray<Readonly<{ task: Task; relation: TreeAsk['relation'] }>>>;
}
const treeIndexes = new WeakMap<readonly Task[], { size: number; index: TreeIndex }>();
function treeIndexOf(everything: readonly Task[]): TreeIndex {
  const hit = treeIndexes.get(everything);
  if (hit && hit.size === everything.length) return hit.index;
  const index: TreeIndex = { byId: new Map(everything.map((t) => [t.id, t] as const)), teammates: new Map(), around: new Map() };
  treeIndexes.set(everything, { size: everything.length, index });
  return index;
}

/** The list's tasks by id, shared with the tree reads of the same list. Never edit it. */
export function tasksByIdOf(everything: readonly Task[]): ReadonlyMap<string, Task> {
  return treeIndexOf(everything).byId;
}

/** The list's tasks by parent id (list order), shared with the tree reads of the same list. Never edit it. */
export function tasksByParentOf(everything: readonly Task[]): ReadonlyMap<string, readonly Task[]> {
  const index = treeIndexOf(everything);
  if (!index.childrenOf) {
    const built = new Map<string, Task[]>();
    for (const t of everything) if (t.parent_task_id) (built.get(t.parent_task_id) ?? built.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
    index.childrenOf = built;
  }
  return index.childrenOf;
}

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
export function teammatesIndex(everything: readonly Task[], only: (t: Task) => boolean = () => true, opts: TreeOptions = {}): (task: Task) => Task[] {
  return buildTeammates(everything, only, opts.allOpen ? everyOpen : open, new Map(everything.map((t) => [t.id, t] as const)));
}

function buildTeammates(everything: readonly Task[], only: (t: Task) => boolean, isOpen: (t: Task) => boolean, byId: ReadonlyMap<string, Task>): (task: Task) => Task[] {
  const leads = everything.filter((t) => t.org_role === 'lead' && isOpen(t));
  const keysOf = new Map<string, string[]>();
  const keys = (t: Task) => keysOf.get(t.id) ?? keysOf.set(t.id, teamKeysOf(t, byId, leads, isOpen)).get(t.id)!;
  const byKey = new Map<string, Task[]>();
  for (const t of everything) {
    if (!member(t, isOpen) || !only(t)) continue;
    for (const k of keys(t)) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  return (task) => {
    if (!member(task, isOpen)) return [];
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
 * the ones shown to the user now, and the ones a lead, VP or Main answered there. `onThreads`
 * (threads_reply_tag): the decisions a teammate waiting on him carries on needs threads of its own
 * (org/thread-held-decision.ts threadRelatives), read when asked. Pure.
 */
export function relativeAsksIndex(everything: readonly Task[], onThreads?: (t: Task) => RelativeAsk[]): (task: Task) => RelativeAsk[] {
  const of = teammatesIndex(everything, (t) => shownAsk(t) || answeredAsk(t) || (!!onThreads && t.user_status?.state === 'needs'));
  const own = (t: Task): RelativeAsk[] => shownAsk(t)
    ? [{ id: t.id, title: t.title, ask: t.user_status!.ask!, createdAt: t.created_at, ...(t.user_status!.decision ? { decision: t.user_status!.decision } : {}) }]
    : answeredAsk(t) ? [{ id: t.id, title: t.title, ask: t.user_status!.answeredFor!.ask, createdAt: t.created_at, answered: true as const }] : [];
  return (task) => of(task).flatMap((t) => (onThreads ? [...own(t), ...onThreads(t)] : own(t)));
}

/** The tasks around `taskId`, each with where it stands to it. Never the task itself. Pure. */
export function treeAround(taskId: string, everything: readonly Task[], opts: TreeOptions = {}): Array<Readonly<{ task: Task; relation: TreeAsk['relation'] }>> {
  // Pure in the list, the task and allOpen: one pass over the board asks the same trees again for
  // every node it reads (2026-11-24: nodeView and treeAround were 10 to 20% of the server's CPU in
  // the memory bursts after a restart, the whole org walked for Main on every call).
  const index = treeIndexOf(everything);
  const key = `${taskId}\u0000${opts.allOpen ? 1 : 0}`;
  let rows = index.around.get(key);
  if (!rows) index.around.set(key, rows = Object.freeze(treeAroundNow(taskId, everything, index, opts).map((r) => Object.freeze(r))));
  return rows.slice();
}

function treeAroundNow(taskId: string, everything: readonly Task[], index: TreeIndex, opts: TreeOptions): Array<{ task: Task; relation: TreeAsk['relation'] }> {
  const byId = index.byId;
  const self = byId.get(taskId);
  if (!self) return [];
  const out = new Map<string, { task: Task; relation: TreeAsk['relation'] }>();
  let cur = self.parent_task_id ? byId.get(self.parent_task_id) : undefined;
  for (let hops = 0; cur && hops < MAX_HOPS && cur.id !== taskId; hops++) {
    out.set(cur.id, { task: cur, relation: 'ancestor' });
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  const childrenOf = tasksByParentOf(everything);
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
    const allOpen = !!opts.allOpen;
    let teammates = index.teammates.get(allOpen);
    if (!teammates) index.teammates.set(allOpen, teammates = buildTeammates(everything, () => true, allOpen ? everyOpen : open, byId));
    for (const t of teammates(self)) if (!out.has(t.id)) out.set(t.id, { task: t, relation: 'team' });
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
  const { awaitsUserDecision } = await import('./human-inbox/open-decision.js');
  const { letters } = await listLetters({ archived: false });
  return letters.filter(awaitsUserDecision).map((l) => ({ id: l.id, subject: l.subject, taskId: l.sender?.taskId }));
}

/** How long another team's report on a matter counts as its latest word (matterReportsOf). */
export const MATTER_REPORT_MS = 24 * 60 * 60_000;

/** An open decision letter with its words (subject and body), for the matter check. */
export interface OpenLetterText extends OpenLetter { text: string }

/**
 * The asks of other teams about the matter `keys` (ask-matter.ts): a task outside the tree, in the
 * same area, whose shown ask or open decision letter is about one of the keys: that task's own
 * matter, or one its words name. The first made first. Pure.
 */
export function matterAsksOf(
  taskId: string, keys: ReadonlySet<string>, everything: readonly Task[], letters: readonly OpenLetterText[],
  own: (taskId: string) => readonly string[],
): TreeAsk[] {
  if (!keys.size) return [];
  const self = everything.find((t) => t.id === taskId);
  if (!self) return [];
  const near = new Set([taskId, ...treeAround(taskId, everything).map((a) => a.task.id)]);
  const others = new Map(everything.filter((t) => !near.has(t.id) && open(t) && !t.plugin_only && sameTaskArea(self, t)).map((t) => [t.id, t] as const));
  const out: Array<TreeAsk & { at: string }> = [];
  for (const t of others.values()) {
    const s = t.user_status;
    if (!s || s.state !== 'needs' || !s.ask || !s.source || !FOLDABLE_SOURCES.has(s.source)) continue;
    const matter = sharedMatter(keys, own(t.id)) ?? matterNamedIn(keys, s.ask);
    if (matter) out.push({ taskId: t.id, title: t.title, ask: s.ask, where: 'status', relation: 'elsewhere', matter, at: t.created_at ?? '' });
  }
  for (const l of letters) {
    const t = l.taskId ? others.get(l.taskId) : undefined;
    if (!t) continue;
    const matter = sharedMatter(keys, own(t.id)) ?? matterNamedIn(keys, l.text);
    if (matter) out.push({ taskId: t.id, title: t.title, ask: l.subject, where: 'letter', letterId: l.id, relation: 'elsewhere', matter, at: t.created_at ?? '' });
  }
  // A letter first (the user answers a decision where it was first written), then the older task.
  return out.sort((a, b) => (a.where === b.where ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : a.where === 'letter' ? -1 : 1))
    .map(({ at: _at, ...a }) => a);
}

/** Another team's latest word on a matter: what its task said it did or found. */
export interface MatterReport { taskId: string; title: string; matter: string; said: string; at: string }

/**
 * Other teams' tasks about the matter `keys` (their own matter, never one their words only name)
 * that said something on it within MATTER_REPORT_MS and do not ask the user about it: their status
 * line now, or their result when they finished. A new ask must read these first: that task may
 * have done what the ask wants of the user, or found it is not needed. 2026-11-18: a leader asked
 * the user to switch traffic back by hand while the task imported for that alarm was watching the
 * automatic switch back, which finished an hour later. The newest first. Pure.
 */
export function matterReportsOf(
  taskId: string, keys: ReadonlySet<string>, everything: readonly Task[], own: (taskId: string) => readonly string[], nowMs = Date.now(),
): MatterReport[] {
  if (!keys.size) return [];
  const self = everything.find((t) => t.id === taskId);
  if (!self) return [];
  const near = new Set([taskId, ...treeAround(taskId, everything).map((a) => a.task.id)]);
  const out: MatterReport[] = [];
  for (const t of everything) {
    if (near.has(t.id) || t.plugin_only || !sameTaskArea(self, t)) continue;
    const matter = sharedMatter(keys, own(t.id).filter((k) => k !== t.id.toLowerCase()));
    if (!matter || t.user_status?.state === 'needs') continue;
    // One that waits on this tree (folded under its ask, or waiting on it) has no news for it.
    if (near.has(t.user_status?.sameAsk?.id ?? '') || [...near].some((id) => (t.user_status?.waitingOn ?? '').includes(id))) continue;
    const result = t.result_report;
    const said = open(t) ? t.user_status?.now : result?.result ?? t.user_status?.now;
    const at = open(t) ? t.user_status?.at : result?.at ?? t.user_status?.at;
    const ms = Date.parse(at ?? '');
    if (!said?.trim() || !Number.isFinite(ms) || nowMs - ms > MATTER_REPORT_MS) continue;
    out.push({ taskId: t.id, title: t.title, matter, said: said.trim(), at: at! });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Per letter id: its subject and body, lower case, for the matter check (a letter's words do not change). */
const letterWords = new Map<string, string>();

/** The open decision letters from `senders`, with their words. */
export async function readOpenLetterTexts(letters: readonly OpenLetter[], senders: ReadonlySet<string>): Promise<OpenLetterText[]> {
  const { getLetter } = await import('./human-inbox/store.js');
  const out: OpenLetterText[] = [];
  for (const l of letters) {
    if (!l.taskId || !senders.has(l.taskId)) continue;
    let text = letterWords.get(l.id);
    if (text === undefined) {
      const detail = await getLetter(l.id, { inlineMaxBytes: 64_000 }).catch(() => null);
      if (!detail) { out.push({ ...l, text: l.subject }); continue; }
      text = `${l.subject}\n${typeof detail.body === 'string' ? detail.body : detail.textPreview ?? ''}`.slice(0, 64_000);
      if (letterWords.size > 2000) letterWords.clear();
      letterWords.set(l.id, text);
    }
    out.push({ ...l, text });
  }
  return out;
}

/**
 * The tree's open asks, read from the store, and other teams' asks about the same matter as
 * `matterText` (with the task's own matter). The inbox only when there is something to compare.
 */
async function readTree(taskId: string, forWrite: boolean, matterText?: string): Promise<{ self?: Task; asks: TreeAsk[]; everything: Task[]; reports: MatterReport[] }> {
  const { listTasks } = await import('./task-manager.js');
  const everything = await listTasks();
  const self = everything.find((t) => t.id === taskId);
  const index = matterIndex(everything);
  const keys = self ? askMatter(taskId, matterText, index) : new Set<string>();
  // Its own id names it, never another matter.
  keys.delete(taskId.toLowerCase());
  const around = treeAround(taskId, everything);
  if (!around.length && !keys.size) return { self, asks: [], everything, reports: [] };
  const letters = await readOpenLetters().catch(() => []);
  const asks = around.length ? treeAsksOf(taskId, everything, letters, forWrite) : [];
  if (!keys.size) return { self, asks, everything, reports: [] };
  const near = new Set([taskId, ...around.map((a) => a.task.id)]);
  const senders = new Set(letters.map((l) => l.taskId).filter((id): id is string => !!id && !near.has(id)));
  const texts = await readOpenLetterTexts(letters, senders).catch(() => []);
  const matter = matterAsksOf(taskId, keys, everything, texts, index.own);
  const asking = new Set(matter.map((a) => a.taskId));
  const reports = matterReportsOf(taskId, keys, everything, index.own).filter((r) => !asking.has(r.taskId));
  return { self, asks: [...asks, ...matter], everything, reports };
}

/** When a person last wrote in the task, read from its sessions (SessionRecord.humanInputAt), or undefined. */
async function personInputAtOf(task: Task): Promise<string | undefined> {
  try {
    const { listSessionsForTasks } = await import('./session-tracker.js');
    const sids = new Set([task.session_id, ...(task.session_ids ?? [])].filter((x): x is string => !!x));
    let at: string | undefined;
    for (const rec of await listSessionsForTasks(new Set([task.id]), sids)) if (rec.humanInputAt && (!at || rec.humanInputAt > at)) at = rec.humanInputAt;
    return at;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a new ask of the user from `taskId` that its tree already holds (409 `same_ask`), unless
 * `input.same_ask_reason` says why it is a different decision. Never throws anything else: a tree
 * Walnut cannot read lets the ask through.
 */
export async function refuseSameAsk(
  taskId: string | undefined, text: string | undefined, what: AskOutlet,
  input?: { same_ask_reason?: unknown; sameAskReason?: unknown } | null,
  /** The parts of the ask beside `text` (a letter's numbered items), checked against what was answered. */
  parts: readonly string[] = [],
  /** The decision the ask carries as it will be stored (a report: ask-decision.ts), so an answer to it
   *  holds or gives way as it does on the status (a new fact named since asks it again). */
  decision?: (AnswerDecision & { credentialAsk?: import('./human-inbox/credential-ask.js').CredentialAsk }) | null,
): Promise<void> {
  if (!taskId || !text?.trim()) return;
  const reason = sameAskReasonOf(input);
  let hit: TreeAsk | null = null;
  let everything: Task[] = [];
  let reports: MatterReport[] = [];
  try {
    const { listTasks } = await import('./task-manager.js');
    everything = await listTasks();
    const matterText = [text, ...parts, decision?.more ?? ''].join('\n');
    const tree = await readTree(taskId, true, matterText);
    hit = findSameAsk(text, tree.asks);
    reports = tree.reports;
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
    // A withdrawal holds until the user writes in the task after it (same-ask.ts answerHolds).
    const personAt = answers.some((a) => a.withdrawn) ? await personInputAtOf(self!) : undefined;
    for (const ask of [text, ...parts]) {
      const answer = answerFor(answers, ask, Date.now(), { ...decision, ...(ask !== text ? { id: undefined, key: undefined, said: undefined } : {}), ...(personAt ? { personAt } : {}) });
      if (!answer) continue;
      log.task.info('same-ask: refused, answered above', { taskId, by: answer.by, what });
      throw new SameAskError(answeredAskMessage(answer, what), { taskId, title: self?.title ?? taskId, ask: answer.ask, where: 'status', relation: 'ancestor' });
    }
  }
  if (!decision?.credentialAsk || (decision.credentialAsk.host === '__local__' && decision.credentialAsk.kind !== 'login-cookie')) await refuseSignInAsk(taskId, text, what, everything);
  // Another team works on this matter and said something on it lately: read that first. Only for a
  // new ask: the one this task already shows, written again, was checked when it was new.
  const standing = self?.status_report?.state === 'needs' ? self.status_report : null;
  const same = !!standing && (decision?.id ? standing.ask_id === decision.id : askKey(standing.ask) === askKey(text));
  const report = same ? undefined : reports[0];
  if (report) {
    log.task.info('same-ask: refused, another team reported on the matter', { taskId, reporter: report.taskId, matter: report.matter, what });
    throw new SameAskError(matterReportMessage(report, what), { taskId: report.taskId, title: report.title, ask: report.said, where: 'status', relation: 'elsewhere', matter: report.matter });
  }
}

/** The refusal's words when another team reported on the matter of a new ask. */
export function matterReportMessage(r: MatterReport, what: AskOutlet): string {
  const verb = outletVerb(what);
  return `${verb} yet: "${r.title.replace(/\s+/g, ' ').slice(0, 100)}" (${r.taskId}), in another team, works on ${matterWords(r.matter)} too, and said at ${r.at.slice(0, 16).replace('T', ' ')} UTC: "${r.said.replace(/\s+/g, ' ').slice(0, 300)}". `
    + 'Read what it found (task_get, task_history) or ask it (task_send) before you ask the user: it may have done what you want of the user already, found it is not needed, or own the decision. '
    + 'If your ask still stands after that, send it again with same_ask_reason: one line saying what you checked there and why the user must still decide or act.';
}

/**
 * A sign-in ask (sign-in-ask.ts) is put on the user once: never while a sign-in letter is open or a
 * checker says sign-in works, and never beside another task's sign-in ask, whatever its team.
 */
async function refuseSignInAsk(taskId: string, text: string, what: AskOutlet, everything: readonly Task[]): Promise<void> {
  const { isSignInAsk, loginCommandWords, readSignInState, signInRefusal } = await import('./sign-in-ask.js');
  const { getConfig } = await import('./config-manager.js');
  const words = loginCommandWords((await getConfig().catch(() => ({}) as { ssh_login_hint?: string })).ssh_login_hint);
  if (!isSignInAsk(text, words)) return;
  const why = signInRefusal(await readSignInState(), taskId);
  const dummy = { taskId, title: '', ask: text, where: 'status' as const, relation: 'elsewhere' as const };
  if (why) {
    log.task.info('same-ask: sign-in ask refused, the sign-in state is known', { taskId, what });
    throw new SameAskError(why, dummy);
  }
  const self = everything.find((t) => t.id === taskId) ?? { id: taskId };
  const { resolveCredentialAsk } = await import('./human-inbox/credential-ask.js');
  let other: Task | undefined;
  for (const candidate of everything) {
    if (candidate.id === taskId || !sameTaskArea(self, candidate) || candidate.phase === 'COMPLETE' || candidate.status === 'done'
      || candidate.user_status?.state !== 'needs' || candidate.user_status.source !== 'session' || !isSignInAsk(candidate.user_status.ask, words)) continue;
    const scope = await resolveCredentialAsk({ subject: '', markdown: candidate.user_status.ask });
    if (scope && (scope.host !== '__local__' || scope.kind === 'login-cookie')) continue;
    other = candidate;
    break;
  }
  if (!other) return;
  const hit: TreeAsk = { taskId: other.id, title: other.title, ask: other.user_status!.ask!, where: 'status', relation: 'elsewhere' };
  log.task.info('same-ask: sign-in ask refused, another task asks it', { taskId, sameAsTaskId: other.id, what });
  throw new SameAskError(sameAskMessage(hit, what), hit);
}

/**
 * A letter or a thread turn of any kind (a report, a completion, a reply) that asks the user to
 * sign in, anywhere in its words (signInLineOf), goes the same way as a sign-in ask: refused while
 * another letter already asks it, or while sign-in works. 2026-11-15: while one task's open letter
 * asked the user to sign in, a second task's weekly report said "re-measuring needs <the login
 * command> first"; only a decision letter's subject was checked, so the user was asked twice.
 */
export async function refuseSignInLetter(
  taskId: string | undefined, subject: string | undefined, body: string | undefined,
  input?: { same_ask_reason?: unknown; sameAskReason?: unknown; credentialAsk?: import('./human-inbox/credential-ask.js').CredentialAsk } | null,
): Promise<void> {
  // Typed asks use the credential-scoped store lock, not the old machine-wide sign-in guess.
  if (!taskId || (input?.credentialAsk && (input.credentialAsk.host !== '__local__' || input.credentialAsk.kind === 'login-cookie'))) return;
  try {
    const { signInLineOf, loginCommandWords } = await import('./sign-in-ask.js');
    const { getConfig } = await import('./config-manager.js');
    const words = loginCommandWords((await Promise.resolve().then(getConfig).catch(() => ({}) as { ssh_login_hint?: string })).ssh_login_hint);
    const line = signInLineOf(subject, body, words);
    if (!line) return;
    if (sameAskReasonOf(input)) { log.task.info('same-ask: sign-in asked again on purpose', { taskId }); return; }
    let everything: Task[] = [];
    try { everything = await (await import('./task-manager.js')).listTasks(); } catch { /* the letter check alone */ }
    await refuseSignInAsk(taskId, line, 'letter', everything);
  } catch (err) {
    // Only the refusal stops the letter; a check that cannot run lets it through.
    if (err instanceof SameAskError) throw err;
    log.task.debug('same-ask: sign-in letter check failed, letter let through', { taskId, error: err instanceof Error ? err.message : String(err) });
  }
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
  let reports: MatterReport[] = [];
  try {
    // Its own matter, and the one its standing ask names (another team's ask about it is the same ask).
    const { getTask } = await import('./task-manager.js');
    const me = await getTask(taskId).catch(() => null);
    const standing = me?.status_report?.state === 'needs' ? [me.status_report.ask, me.status_report.ask_more].filter(Boolean).join('\n') : '';
    ({ self, asks, everything, reports } = await readTree(taskId, false, standing));
    // Other teams' news matters to an ask: a task asking nothing is not told it.
    if (!standing) reports = [];
  } catch {
    return '';
  }
  // Its own decision first: the id it keeps across rewordings (ask-decision.ts).
  const own = askDecisionQuestion(self?.status_report);
  // A stored fold names its task only when that task is known and in the same area (one stored
  // before the area mark, or naming a task gone from the store, is left out).
  const stored = self?.user_status?.sameAsk;
  const foldTask = stored ? everything.find((t) => t.id === stored.id) : undefined;
  const fold = stored && self && foldTask && sameTaskArea(self, foldTask) ? stored : undefined;
  const above = self?.user_status?.answeredFor;
  if (!asks.length && !fold && !above && !reports.length) return own;
  const lines = asks.slice(0, QUESTION_ASKS_MAX).map((a) => `- [${a.taskId}] ${a.title.replace(/\s+/g, ' ').slice(0, 80)} (${WHO[a.relation]}${a.matter ? `, about ${matterWords(a.matter)}` : ''}${a.where === 'letter' ? `, a decision letter ${a.letterId}` : ''}): "${a.ask.replace(/\s+/g, ' ').slice(0, 200)}"`);
  const said = reports.slice(0, 3).map((r) => `- [${r.taskId}] ${r.title.replace(/\s+/g, ' ').slice(0, 80)} (another team, works on ${matterWords(r.matter)}), at ${r.at.slice(5, 16).replace('T', ' ')} UTC: "${r.said.replace(/\s+/g, ' ').slice(0, 200)}"`);
  const reported = said.length
    ? '\nOther teams work on the same matter and said lately (read it before you ask the user anything about it: it may be done already or not needed, and the user is not told two different things):\n' + said.join('\n')
    : '';
  const who = fold ? `[${fold.id}] ${fold.title.replace(/\s+/g, ' ').slice(0, 80)}` : '';
  const folded = !fold ? ''
    : fold.answered
      ? `\nThe user answered your ask through ${who}, which asked the same: get the answer from that task (task_send) and do not ask the user again.`
      : `\nWalnut shows your ask as the same as the one of ${who}, so the user sees it there only.${fold.team ? ' If your pick differs from its, tell it (task_send) so its ask carries both views.' : ''}`;
  const answered = above
    ? `\n${above.byTitle.replace(/\s+/g, ' ').slice(0, 80)} answered your ask for the user ("${above.ask.replace(/\s+/g, ' ').slice(0, 160)}"), and Walnut took it off the user's Needs you: act on that answer and do not ask it again.`
    : '';
  return `${own}\n\nThe user already has these asks open from this task's tree or about its matter, and sees each decision once, from the task closest to the work:\n${lines.join('\n') || '- (none open now)'}${folded}${answered}${reported}\n`
    + 'Do not ask the user again what one of these asks: if it is the decision your FOR_USER_ASK is about, the task that asks it carries the answer (task_send it if you need the answer too).\n'
    + 'FOR_USER_ASK_SAME: needs-you only: the id of the listed task whose ask is the same decision as yours, or "different" when yours is another decision. Otherwise none.';
}
