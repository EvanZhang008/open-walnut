/**
 * What a task still waits on the user for, read from where a task that handed the user's decision
 * up to its lead leaves it (2026-11-16, the user: it closed while it was still waiting on him).
 *
 * The case: a worker sent to "look at a new document" found an invoice to pay. Paying is the user's
 * decision, so it replied to its lead ("whether to pay is Evan's decision"), wrote that in its
 * not_done, marked the Progress line "[DONE] You: decide whether to pay" (passed to the lead), and
 * completed. Its lead had put the question on the user's Threads ("reply 'pay' and the task pays it"),
 * naming that worker. None of the four owed sources saw it (its own status never asked the user, the
 * Progress line read DONE, no letter, no Board choice), so the close went through, and the task that
 * was to pay once he answered was gone.
 *
 * Two more sources for the close gate (owed-to-user.ts), both read the task's own record:
 *   - `thread`: an open thread of any org node that waits on him (stored state needs) and names this
 *     task (its tasks, its ask owner, its opener's ref), unless the thread reads as a pointer to a
 *     task asking it (thread-task-ask.ts): that task's own ask is the item, or it is another task's.
 *   - `decision`: the task's own conclusion says the user still has to decide, answer or act: its
 *     not_done items, then its result ("X is Evan's decision", its Chinese
 *     forms, "waiting for the user's answer"). A conclusion written in the past ("per Evan's decision")
 *     is not.
 *
 * And the force a non-lead closer may use past them needs the user's own words (userWordsQuoted):
 * only he settles what waits on him; a lead settles its team's items itself (owed-to-user.ts).
 * Guard tests: tests/core/owed-waits.test.ts and tests/e2e/owed-close.test.ts (every source).
 */
import type { Task } from '../types.js';
import { asksToDecide } from './stale-note.js';
import { namesUser } from './owed-to-user.js';
import type { OrgThread } from '../org/threads-model.js';

const ESC = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ITEM_MAX = 300;

/** Who the user is in a line: "you", "the user", their own first name. */
function whoRe(name?: string): string {
  return ['the user', ...(name ? [ESC(name)] : [])].join('|');
}

/** Words just before a phrase that make it past or negated ("per Evan's decision", "no longer waiting on Evan"). */
const PAST_BEFORE_RE = /(?:\b(?:per|following|followed|applied|as|with|made|took|on|by|after|at|did|no longer|not|never|without|nothing|no one|nobody)\s+(?:\S+\s+)?)$/i;
/** Chinese: "according to / per / no need to / already" right before it (as escapes). */
const PAST_BEFORE_ZH_RE = /(?:(?:\u6ca1\u6709|\u6ca1|\u65e0)[^\uff0c\u3002\uff1b,.;]{0,6}$)|(?:\u6309|\u6839\u636e|\u7167|\u4f9d|\u4e0d\u7528|\u4e0d\u9700\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u5df2(?:\u7ecf)?)\s*$/u;

/** A wait said to be over ("no longer waiting on Robin"): namesUser reads only the words after it. */
const NEGATED_WAIT_RE = /\b(?:no longer|not|never|without|no need to|stopped|done|nothing|no one|nobody)\s+(?:\S+\s+)?(?:wait|await)/i;

/** What of the user's own a task waits for: a decision, an answer, a go-ahead. */
const OWN_WORDS = 'decision|call|choice|pick|approval|answer|reply|go-ahead|ok|okay|sign-?off|confirmation|review';

/**
 * The phrases that say the user still has to decide, answer or act, built for their name. `strict`
 * holds only a decision put on the user ("is Robin's decision", "交 Robin 定"); the rest also read a
 * plain wait ("waiting on Robin"), which a result uses to describe work ("a task still waiting on the
 * user cannot close"), so only a not_done item, a line of what is NOT done, reads them.
 */
function waitRes(name?: string): { strict: RegExp[]; broad: RegExp[] } {
  const who = whoRe(name);
  const zhWho = [...(name ? [ESC(name)] : []), '\\u7528\\u6237', '\\u4f60'].join('|');
  const zhWhoNamed = [...(name ? [ESC(name)] : []), '\\u7528\\u6237'].join('|');
  // decide / answer / reply / confirm / approve / sign off / choose (escapes)
  const zhDecide = '\\u51b3\\u5b9a|\\u62cd\\u677f|\\u786e\\u8ba4|\\u6279\\u51c6|\\u7b54\\u590d|\\u56de\\u590d|\\u56de\\u7b54|\\u9009|\\u5b9a';
  const strict = [
    // "is Evan's decision", "the user's approval is needed": a possessive alone ("Evan's reply is in
    // the DM", "the user's pick of 10 designs") names a past one.
    new RegExp(`\\b(?:is|are|stays?|remains?|left (?:to|for)|up to|pending)\\s+(?:${who})(?:'s|\\u2019s)\\s+(?:${OWN_WORDS})\\b`, 'iu'),
    new RegExp(`(?:${who})(?:'s|\\u2019s)\\s+(?:${OWN_WORDS})\\s+(?:is\\s+)?(?:still\\s+)?(?:needed|pending|open|required|outstanding)\\b`, 'iu'),
    new RegExp(`\\b(?:for|to)\\s+(?:${who})\\s+to\\s+(?:decide|choose|pick|confirm|approve|answer|reply|sign|pay)\\b`, 'iu'),
    new RegExp(`\\b(?:${who})\\s+(?:still\\s+)?(?:to|must|needs? to|has to|is to)\\s+(?:decide|choose|pick|confirm|approve|answer|reply|sign|review|accept)\\b`, 'iu'),
    new RegExp(`\\b(?:is|are|it's|left)\\s+up to\\s+(?:${who})(?![\\p{L}-])`, 'iu'),
    // "hand to / left to / ask <user> to decide / answer / reply" (escapes)
    new RegExp(`(?:\\u4ea4(?:\\u7ed9)?|\\u7531|\\u5f85|\\u8bf7)\\s*(?:${zhWho})\\s*\\u6765?\\s*(?:${zhDecide})`, 'u'),
  ];
  const broad = [
    ...strict,
    new RegExp(`\\b(?:needs?|awaits?|awaiting|waiting (?:for|on)|until)\\s+(?:${who})(?:'s|\\u2019s)\\s+(?:${OWN_WORDS})\\b`, 'iu'),
    new RegExp(`\\b(?:awaiting|wait(?:s|ing)?\\s+(?:on|for))\\s+(?:${who})(?![\\p{L}-])`, 'iu'),
    new RegExp(`\\buntil\\s+(?:${who})\\s+(?:decides|chooses|picks|confirms|approves|answers|replies|reviews|signs|pays|renews|accepts)\\b`, 'iu'),
    // "<user>'s decision / answer / confirmation / consent" (de + the word)
    new RegExp(`(?:${zhWhoNamed})\\s*\\u7684\\s*(?:\\u51b3\\u5b9a|\\u7b54\\u590d|\\u56de\\u590d|\\u56de\\u7b54|\\u786e\\u8ba4|\\u6279\\u51c6|\\u540c\\u610f)`, 'u'),
    // "wait for <user>" (deng / dai)
    new RegExp(`(?:\\u7b49|\\u5f85)(?:\\u5f85)?\\s*(?:${zhWhoNamed})`, 'u'),
  ];
  return { strict, broad };
}

/**
 * Whether the text says something still waits on the user (pure). `name`: their first name, when
 * known. `strict`: only a decision put on the user (for a result, which describes work); a not_done
 * item reads a plain wait too ("waiting for Robin to sign in").
 */
export function waitsOnUser(text: string, name?: string, strict = false): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (asksToDecide(t)) return true;
  if (!strict && namesUser(t, name) && !NEGATED_WAIT_RE.test(t)) return true;
  const res = waitRes(name);
  for (const re of strict ? res.strict : res.broad) {
    const g = new RegExp(re.source, `${re.flags}g`);
    for (let m = g.exec(t); m; m = g.exec(t)) {
      const before = t.slice(Math.max(0, m.index - 30), m.index);
      if (!PAST_BEFORE_RE.test(before) && !PAST_BEFORE_ZH_RE.test(before)) return true;
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return false;
}

/** Sentences of a text (".", "?", "!", ";" and their full-width forms). */
function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.?!;])\s+|(?<=[\u3002\uff1f\uff01\uff1b])/u).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function cut(t: string, max = ITEM_MAX): string {
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

/**
 * The task's own conclusion that says the user still has something (pure): its not_done items first
 * (each kept as written, so a hold lists it once), else its result's sentences that put a decision on
 * the user (waitsOnUser strict: a result describes work). Not its Executive
 * Summary: that is its history ("holds each push until Evan approves it" describes a hook), and a
 * summary that reads unfinished is stale-note.ts's to ask about.
 */
export function decisionItems(
  conclusion: { notDone?: readonly string[]; result?: string | null },
  name?: string,
): string[] {
  const nd = (conclusion.notDone ?? []).map((s) => s.trim()).filter((s) => s && waitsOnUser(s, name));
  if (nd.length) return [...new Set(nd)];
  return [...new Set(sentences(conclusion.result ?? '').filter((s) => waitsOnUser(s, name, true)).map((s) => cut(s)))];
}

/**
 * Whether an open thread waiting on the user is about this task (pure): it was opened about it
 * (opener.ref) or names it as the task that asks it (askOwner); or it lists it among the tasks it went
 * to (tasks) and is a lead's above it (`chain`: the task's lead chain) and either goes to it alone or
 * the task's own conclusion says it waits on the user. A thread that only went to several tasks ("which
 * first?") holds none of them.
 */
export function threadNamesTask(
  t: Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'askOwner' | 'opener'>, taskId: string,
  on?: { node: string; chain: ReadonlySet<string>; saysWaits: boolean },
): boolean {
  if (t.closed || t.state !== 'needs') return false;
  if (t.askOwner?.task === taskId || t.opener?.ref === taskId) return true;
  const tasks = t.tasks ?? [];
  if (!tasks.includes(taskId) || !on || !on.chain.has(on.node)) return false;
  return tasks.length === 1 || on.saysWaits;
}

/** The item a thread waiting on the user is for a task: what it asks him, else its title. */
export function threadItemText(t: Pick<OrgThread, 'ask' | 'reply' | 'title'>, askText: (t: Pick<OrgThread, 'ask' | 'reply'>) => string | null): string {
  return cut(askText(t) ?? `Answer the thread "${t.title}"`);
}

/** The task's lead chain: its parents up to LEAD_DEPTH (unreadable links end it). */
export async function leadChain(task: Pick<Task, 'id' | 'parent_task_id'>, read: (id: string) => Promise<Pick<Task, 'id' | 'parent_task_id'> | null>): Promise<Set<string>> {
  const out = new Set<string>();
  let parent = task.parent_task_id;
  for (let i = 0; parent && i < 8 && !out.has(parent) && parent !== task.id; i++) {
    out.add(parent);
    parent = (await read(parent).catch(() => null))?.parent_task_id;
  }
  return out;
}

export interface ThreadWait { node: string; id: string; text: string }

/**
 * The threads of every org node that wait on the user for this task, as he reads them: one that reads
 * as a pointer to a task asking its decision (askedIn) is that task's ask, never a second item.
 * Every store that cannot be read adds nothing.
 */
export async function threadWaitItems(task: Pick<Task, 'id' | 'parent_task_id'>, all: readonly Task[] | undefined, saysWaits: boolean): Promise<ThreadWait[]> {
  const out: ThreadWait[] = [];
  try {
    const { threadTaskIds, readThreads, withTaskAsks } = await import('../org/threads-store.js');
    const { threadAskText } = await import('../org/thread-task-ask.js');
    const byId = new Map((all ?? []).map((t) => [t.id, t] as const));
    const chain = await leadChain(task, async (id) => byId.get(id) ?? null);
    const { keepsThreads } = await import('../org/keeps-threads.js');
    const { listTasksByIds } = await import('../task-manager.js');
    for (const node of await threadTaskIds()) {
      if (node === task.id) continue;
      // Threads the user turned off (Task.threads_on) are on no screen: they hold nothing.
      const keeper = byId.get(node) ?? (await listTasksByIds([node]).catch(() => []))[0];
      if (keeper && !keepsThreads(keeper)) continue;
      const file = await readThreads(node).catch(() => null);
      const mine = (file?.threads ?? []).filter((t) => threadNamesTask(t, task.id, { node, chain, saysWaits }));
      if (!mine.length) continue;
      const shown = await withTaskAsks(node, mine, all);
      for (const t of shown) if (!t.closed && t.state === 'needs' && !t.askedIn) out.push({ node, id: t.id, text: threadItemText(t, threadAskText) });
    }
  } catch { /* unread: nothing */ }
  return out;
}

/**
 * Once a close settled what a hold named for the user (his words quoted, or his own close), the
 * threads that asked it of him, stored as waiting on him, go quiet (pending: out of his sight, no
 * overdue clock). Read as a pointer while the task asked, they would ask him again the moment it
 * completed; the lead hears the completion and writes the thread's result. Never throws.
 */
export async function quietSettledThreads(taskId: string, settled: readonly string[], by: `task:${string}` | 'human'): Promise<number> {
  if (!settled.length) return 0;
  let n = 0;
  try {
    const { threadTaskIds, readThreads, patchThread } = await import('../org/threads-store.js');
    const { threadAskText } = await import('../org/thread-task-ask.js');
    for (const node of await threadTaskIds()) {
      if (node === taskId) continue;
      const file = await readThreads(node).catch(() => null);
      for (const t of file?.threads ?? []) {
        const about = (t.tasks ?? []).includes(taskId) || t.askOwner?.task === taskId || t.opener?.ref === taskId;
        if (t.closed || t.state !== 'needs' || !about || !settled.includes(threadItemText(t, threadAskText))) continue;
        await patchThread(node, t.id, { state: 'pending' }, by).then(() => { n++; }).catch(() => {});
      }
    }
  } catch { /* nothing quieted */ }
  return n;
}

/**
 * Whether `userWords` quotes a message the user wrote after `since` (the hold that named the items):
 * in the task itself, in a thread about it, or in the closing task (where a lead relays him). Words
 * from before the hold (his first ask of the task) never settle what it named. A force past what
 * waits on him needs it.
 */
export async function userWordsQuoted(task: Pick<Task, 'id' | 'org_role' | 'plugin_only'>, userWords: string | undefined, closerTaskId: string | undefined, since: string): Promise<boolean> {
  const words = (userWords ?? '').trim();
  const sinceMs = Date.parse(since);
  if (!words || !Number.isFinite(sinceMs)) return false;
  const { userWordsIn, quotesWord } = await import('./user-spoke.js');
  const pool = [...await userWordsIn(task)];
  try {
    const { getTask } = await import('../task-manager.js');
    const closer = closerTaskId && closerTaskId !== task.id ? await getTask(closerTaskId).catch(() => null) : null;
    if (closer) pool.push(...await userWordsIn(closer));
    const { threadTaskIds, readThreads } = await import('../org/threads-store.js');
    for (const node of await threadTaskIds()) {
      const file = await readThreads(node).catch(() => null);
      for (const t of file?.threads ?? []) {
        if (!((t.tasks ?? []).includes(task.id) || t.askOwner?.task === task.id || t.opener?.ref === task.id)) continue;
        pool.push(...t.messages.map((m) => ({ at: m.at, text: m.text })));
      }
    }
  } catch { /* what was read is the pool */ }
  return pool.some((w) => Date.parse(w.at) > sinceMs && quotesWord(w, words));
}
