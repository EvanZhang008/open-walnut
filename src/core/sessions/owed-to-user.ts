/**
 * A task is not closed while it still holds something for the user (2026-11-02, Main's daily
 * reflection: a session completed a task whose own Progress still said the user had to resubmit a
 * form by the next day; Main read COMPLETE as done and told the user it was submitted).
 *
 * COMPLETE means nothing is left for anyone, so when a SESSION closes a task (its own or another)
 * that still holds something only the user can do or decide, Walnut keeps it open instead:
 *
 *   - its result is recorded with those items as `not_done` (Partial: the Board, the Brief, the
 *     phone and its parent read it);
 *   - its phase goes to NEED_ACTION with a Needs you line naming them, so it stays on the user's
 *     list until someone handles them;
 *   - the call answers 409 `owed_to_user` saying so. Once that hold has named them, `force` with a
 *     reason (the items are done already, or no longer needed) closes it, and the items are kept as
 *     settled with that reason. A force before any hold is held first, so the items are always seen.
 *
 * The hold lives on `result_report.owed`: while open, user-status.ts reads the task as Needs you
 * and report-phase.ts keeps a later turn's report from moving it off NEED_ACTION. The not-done
 * settle (POST /tasks/:id/not-done), a person's close and a forced close end it.
 *
 * What counts (OWED_SOURCES): an open Progress item that names the user, the ask its status
 * makes of the user (its own report, a letter, a Board choice, a live prompt, a snoozed ask), an
 * unanswered decision letter it sent, an unanswered Board choice about it. A person's own
 * completion is never checked: they decided. Main and a lead are never held: they are never closed
 * as work, and their asks are their teams'. Guard tests: tests/core/owed-to-user.test.ts (sources,
 * every close path) and tests/e2e/owed-close.test.ts (every source through every close route).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { openOwed, type StructuredReply, type TaskResultReport } from '../peers/structured-reply.js';
import type { UserStatus } from '../user-status.js';

export type OwedSource = 'progress' | 'ask' | 'letter' | 'choice' | 'held';
export interface OwedItem { source: OwedSource; text: string }

/**
 * How each kind of Needs you the one status gives (UserStatus.source) is owed at a close.
 * tests/core/owed-to-user.test.ts fails on a source not listed here.
 */
export const OWED_STATUS_SOURCES: Record<NonNullable<UserStatus['source']>, { owed: boolean; why: string }> = {
  session: { owed: true, why: 'its own report asks the user' },
  letter: { owed: true, why: 'an unanswered decision letter of it' },
  choice: { owed: true, why: 'an unanswered Board choice about it' },
  prompt: { owed: true, why: 'a live prompt waits on the user' },
  error: { owed: false, why: 'a failed session is the machine\'s, and a close ends it' },
  thread: { owed: false, why: 'a Thread waiting on the user is his own request to Main or a VP, which are never closed as work' },
};

/** The Progress labels of work not finished (task-progress.ts). */
const OPEN_PROGRESS = new Set(['TODO', 'WIP', 'WAIT', 'BLOCKED']);

const REASON_MIN = 10;
const ASK_MAX = 300;
const ESC = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The user's own first name, from the Identity section of their profile (memory/USER.md), so an
 * older Progress line written as "<name>: do X" is read as theirs. Undefined when none is recorded.
 */
export function userNameOf(profile: string): string | undefined {
  const m = /^##\s*Identity\s*\n+\s*([^\n]+)/im.exec(profile);
  // "Robin, software engineer" / "Robin \u2014 designer" / "Robin (they/them)": a name, then a stop.
  const first = m?.[1]?.trim().match(/^([A-Z][\p{L}'-]{1,30})\s*[,:(\u2014\u2013]/u)?.[1];
  return first && !['The', 'This', 'My', 'Name', 'User', 'A', 'An'].includes(first) ? first : undefined;
}

/**
 * A Progress line is the user's to do: it starts with whom it is for ("You: ...", "You, next year:
 * ...", "The user: ...", or their own name then ":" or ","), or it waits on them ("Waits on: the
 * user's decision"). A line that only mentions them ("Tell Robin the result", "your sign-in") is the
 * task's own work.
 */
export function namesUser(text: string, name?: string): boolean {
  const who = ['you', 'the user', ...(name ? [ESC(name)] : [])].join('|');
  if (new RegExp(`^\\s*(?:${who})\\s*[:,]`, 'iu').test(text)) return true;
  return /\bwait(?:s|ing)? (?:on|for):?\s*(?:the user|you)(?![-\w])/i.test(text)
    || (!!name && new RegExp(`\\bwait(?:s|ing)? (?:on|for):?\\s*${ESC(name)}(?![\\p{L}])`, 'iu').test(text));
}

/** The open Progress items of a note that are the user's (pure). */
export function userProgressItems(note: string | null | undefined, name: string | undefined,
  extract: (note: string | null | undefined) => Array<{ status: string; text: string }>): string[] {
  return extract(note).filter((l) => OPEN_PROGRESS.has(l.status) && namesUser(l.text, name)).map((l) => `[${l.status}] ${l.text}`);
}

/** The ask its stored status makes of the user, when that is owed (pure). */
export function statusAskItem(s: UserStatus | null | undefined): string | undefined {
  if (!s) return undefined;
  if (s.snoozed?.ask) return s.snoozed.ask;
  if (s.state !== 'needs' || !s.ask) return undefined;
  return OWED_STATUS_SOURCES[s.source ?? 'session']?.owed === false ? undefined : s.ask;
}

/** Everything the task still holds for the user. Each store that cannot be read adds nothing. */
export async function owedToUser(task: Task): Promise<OwedItem[]> {
  const out: OwedItem[] = [];
  const seen = new Set<string>();
  const add = (source: OwedSource, text: string | undefined) => {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return;
    seen.add(key);
    out.push({ source, text: t });
  };
  try {
    const { extractProgressLines } = await import('../task-progress.js');
    const { refreshUserProfile } = await import('./user-profile-context.js');
    const name = userNameOf((await refreshUserProfile().catch(() => null))?.text ?? '');
    for (const t of userProgressItems(task.note, name, extractProgressLines)) add('progress', t);
  } catch { /* unread: nothing */ }
  // Not the ask a hold of its own wrote (its status reads it back): the items it names come below.
  const held = openOwed(task.result_report);
  const ask = statusAskItem(task.user_status);
  if (!held || ask !== held.ask) add('ask', ask);
  try {
    const { listLetters } = await import('../human-inbox/store.js');
    const { letters } = await listLetters({ archived: false });
    for (const l of letters) {
      if (l.type === 'action_required' && !l.answered && !l.archived && l.sender?.taskId === task.id) add('letter', `Answer the letter "${l.subject}"`);
    }
  } catch { /* unread: nothing */ }
  try {
    const { listTasks } = await import('../task-manager.js');
    const { readStatusFacts } = await import('../user-status-sync.js');
    const all = await listTasks();
    const facts = await readStatusFacts([task], all.map((t) => t.id));
    for (const c of facts.choices?.get(task.id) ?? []) add('choice', `Answer the Board choice "${c.title}"`);
  } catch { /* unread: nothing */ }
  // A hold stays until it is settled (a forced close with a reason, the not-done settle, a person's
  // close): what it named counts even after the line that named it changed.
  for (const t of held?.items ?? []) add('held', t);
  return out;
}

/** How a close that goes through settles an open hold: a person's close, or a forced one. */
export interface CloseSettle { taskId: string; items: OwedItem[]; reason: string; by: string; person?: boolean }

export type CloseAdmission =
  | { ok: true; settle?: CloseSettle }
  | { ok: false; code: 'owed_to_user'; message: string; items: OwedItem[] };

/** Who is closing: null for a person (never checked), else the closing session's task. */
async function closerOf(callerSid: string | undefined): Promise<{ taskId: string } | null> {
  if (!callerSid) return null;
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(callerSid).catch(() => null);
  return caller?.kind === 'session' && caller.record.taskId ? { taskId: caller.record.taskId } : null;
}

function itemsText(items: readonly OwedItem[]): string {
  return items.map((i, n) => `${n + 1}) ${i.text}`).join('; ');
}

/** The closer's own not-done items of a report still open: not what a hold listed for the user. */
function ownNotDone(r: TaskResultReport | undefined): string[] {
  if (r?.settled) return [];
  const owed = new Set(r?.owed?.items ?? []);
  return (r?.not_done ?? []).filter((t) => !owed.has(t));
}

/** Cut to `max` characters, never inside a surrogate pair. */
function cut(t: string, max = ASK_MAX): string {
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

/**
 * Keep it open: its result lists the items (Partial) and holds them on `owed`, which reads Needs you
 * until they are settled, and its phase goes to NEED_ACTION. The closer is recorded as told, so its
 * next close may force it. A second close by a told closer naming the same items writes nothing.
 * A task completed meanwhile is left alone. Throws when the hold could not be recorded.
 */
async function holdOpen(task: Task, items: OwedItem[], closer: { taskId: string }, callerSid: string, fields?: StructuredReply | null): Promise<void> {
  const by = `task:${closer.taskId}`;
  const texts = items.map((i) => i.text);
  const ask = cut(items.length === 1 && items[0].source !== 'progress' && items[0].source !== 'held'
    ? items[0].text
    : `Left for you when this task was closed: ${itemsText(items)}`);
  const at = new Date().toISOString();
  const { updateTask, updateTaskRaw } = await import('../task-manager.js');
  let phaseRead: Task['phase'] | undefined;
  const { task: held, changed } = await updateTaskRaw(task.id, (cur) => {
    phaseRead = cur.phase;
    if (cur.phase === 'COMPLETE' || cur.status === 'done') return null;
    const was = cur.result_report;
    const open = openOwed(was);
    const same = !!open && open.items.length === texts.length && texts.every((t) => open.items.includes(t));
    const told = [...new Set([...(same ? open!.told ?? [] : []), closer.taskId])];
    if (same && !fields && (open!.told ?? []).includes(closer.taskId)) return null;
    const own = fields?.not_done ?? ownNotDone(was);
    return {
      result_report: {
        via: 'complete', at, by,
        ...((fields?.result ?? was?.result) ? { result: fields?.result ?? was?.result } : {}),
        ...((fields?.evidence ?? was?.evidence) ? { evidence: fields?.evidence ?? was?.evidence } : {}),
        not_done: [...new Set([...own, ...texts])],
        owed: same ? { ...open!, told } : { items: texts, ask, at, by, told },
      },
    };
  }, { source: 'result-report', push: false });
  if (phaseRead === 'COMPLETE') return;
  if (changed && held) {
    const { bus, EventNames } = await import('../event-bus.js');
    bus.emit(EventNames.TASK_UPDATED, { task: held }, ['web-ui'], { source: 'result-report' });
  }
  // Only from the phase it had: a close or a move by someone else meanwhile wins.
  if (phaseRead && phaseRead !== 'NEED_ACTION') {
    await updateTask(task.id, { phase: 'NEED_ACTION' }, { source: 'api', actorSid: callerSid, ifPhase: phaseRead });
  }
  log.task.info('close held open: the user still has items of it', { taskId: task.id, by, items: items.map((i) => i.source), changed });
}

/**
 * The gate every close path a session can reach goes through (tests/core/owed-to-user.test.ts lists
 * them). A close of a task already COMPLETE, of Main or a lead, or one with nothing owed passes.
 * A person's close passes and settles an open hold (they decided). A session's forced close passes
 * only when this closer was already told every item it would settle.
 */
export async function admitSessionClose(
  taskId: string, callerSid: string | undefined,
  opts: { force?: boolean; reason?: string; fields?: StructuredReply | null } = {},
): Promise<CloseAdmission> {
  const closer = await closerOf(callerSid);
  const { getTask } = await import('../task-manager.js');
  if (!closer || !callerSid) {
    // A person's close: nothing is checked, but a hold ends with it, as settled by them.
    const t = await getTask(taskId).catch(() => null);
    const held = t && t.phase !== 'COMPLETE' ? openOwed(t.result_report) : undefined;
    return held
      ? { ok: true, settle: { taskId: t!.id, items: held.items.map((text) => ({ source: 'held', text })), reason: 'The user closed the task', by: 'human', person: true } }
      : { ok: true };
  }
  const task = await getTask(taskId).catch(() => null);
  if (!task || task.phase === 'COMPLETE' || task.status === 'done' || task.org_role === 'main' || task.org_role === 'lead') return { ok: true };
  const items = await owedToUser(task);
  if (!items.length) return { ok: true };
  const reason = (opts.reason ?? '').replace(/\s+/g, ' ').trim();
  const held = openOwed(task.result_report);
  const told = !!held && (held.told ?? []).includes(closer.taskId) && items.every((i) => held.items.includes(i.text));
  if (opts.force === true && reason.length >= REASON_MIN && told) {
    log.task.info('task closed with items of the user settled by its closer', { taskId, by: closer.taskId, reason, items: items.map((i) => i.source) });
    return { ok: true, settle: { taskId: task.id, items, reason, by: `task:${closer.taskId}` } };
  }
  let failed: string | undefined;
  try {
    await holdOpen(task, items, closer, callerSid, opts.fields);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    log.task.warn('close held open, but recording it failed', { taskId, error: failed });
  }
  const forcedEarly = opts.force === true && !told;
  const message = `Not closed: the user still has ${items.length} thing(s) of this task to do or decide: ${itemsText(items)}. `
    + (failed
      ? `Recording this on the task failed (${cut(failed, 160)}), so it may not show as Partial yet; tell the user. `
      : 'It now reads Partial and stays in their Needs you (NEED_ACTION) until they are handled; tell the user if you have not. ')
    + (forcedEarly ? 'force settles only items already named to you, as these are now. ' : '')
    + `If they are already done or no longer needed, close it again with force:true and a reason (${REASON_MIN}+ characters) saying so; the reason is kept as how they were settled.`;
  return { ok: false, code: 'owed_to_user', message, items };
}

/**
 * Record how a close settles the hold. A forced close keeps the user's items on `owed`, settled as
 * dropped with the closer's reason, while the closer's own not-done items stay open (Partial) and
 * its result and evidence stay. A person's close settles the whole result (COMPLETE is verified).
 * Returns the report it replaced, for `undoSettle` when the close then fails.
 */
async function recordSettle(settle: CloseSettle, fields?: StructuredReply | null): Promise<{ prev: TaskResultReport | undefined; at: string }> {
  const { updateTaskRaw } = await import('../task-manager.js');
  const at = new Date().toISOString();
  const settled = { at, by: settle.by, how: settle.person ? 'taken' as const : 'dropped' as const, note: cut(settle.reason, 500) };
  let prev: TaskResultReport | undefined;
  await updateTaskRaw(settle.taskId, (cur) => {
    const was = cur.result_report;
    prev = was;
    const items = settle.items.map((i) => i.text);
    const owed = {
      items, ask: was?.owed?.ask ?? cut(itemsText(settle.items)), at: was?.owed?.at ?? at, by: was?.owed?.by ?? settle.by,
      ...(was?.owed?.told ? { told: was.owed.told } : {}), settled,
    };
    // A person's close: what they wrote with it is the result; else the old one, all settled.
    if (settle.person) {
      if (fields) return { result_report: { via: 'complete', by: 'human', ...fields, at, ...(fields.not_done?.length ? {} : { settled }), owed } };
      return { result_report: { ...(was ?? { via: 'complete' as const, by: 'human' }), at, settled, owed } };
    }
    const own = fields?.not_done ?? ownNotDone(was);
    return {
      result_report: {
        via: 'complete', at, by: settle.by,
        ...((fields?.result ?? was?.result) ? { result: fields?.result ?? was?.result } : {}),
        ...((fields?.evidence ?? was?.evidence) ? { evidence: fields?.evidence ?? was?.evidence } : {}),
        ...(own.length ? { not_done: own } : {}),
        owed,
      },
    };
  }, { source: 'result-report', push: false });
  return { prev, at };
}

/**
 * Put back the report a settle replaced, unless something wrote a newer one meanwhile or the task
 * is COMPLETE after all (a sync push that failed after the local close still closed it).
 */
async function undoSettle(taskId: string, mark: { prev: TaskResultReport | undefined; at: string }): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  await updateTaskRaw(taskId, (cur) => (cur.result_report?.at === mark.at && cur.phase !== 'COMPLETE' ? { result_report: (mark.prev ?? null) as never } : null),
    { source: 'result-report', push: false }).catch(() => {});
}

/**
 * Run a close that the gate let through: its settle is recorded first (so the completion's own
 * event and its parent's notice carry it) and put back if the close throws, so the user's items
 * never vanish from a task that stayed open.
 */
export async function closeWithSettle<T>(settle: CloseSettle | undefined, fields: StructuredReply | null | undefined, close: () => Promise<T>): Promise<T> {
  if (!settle) return close();
  const mark = await recordSettle(settle, fields);
  try {
    return await close();
  } catch (err) {
    await undoSettle(settle.taskId, mark);
    throw err;
  }
}

/**
 * A batch close: the ids that may close now, those held open (each answered as refused), and the
 * settles of those that go through; `settleBatch` records them around the bulk write.
 */
export async function splitSessionCloses(ids: readonly string[], phase: string, callerSid: string | undefined): Promise<{ ids: string[]; refused: { id: string; ok: false; error: string }[]; settles: Map<string, CloseSettle> }> {
  const settles = new Map<string, CloseSettle>();
  if (phase !== 'COMPLETE') return { ids: [...ids], refused: [], settles };
  const keep: string[] = [];
  const refused: { id: string; ok: false; error: string }[] = [];
  for (const id of ids) {
    const admit = await admitSessionClose(id, callerSid);
    if (!admit.ok) { refused.push({ id, ok: false, error: `${admit.code}: ${admit.message}` }); continue; }
    keep.push(id);
    if (admit.settle) settles.set(id, admit.settle);
  }
  return { ids: keep, refused, settles };
}

/** Records a batch's settles, runs the bulk write, and puts back those whose close did not land. */
export async function settleBatch<T extends { changed: Array<{ id: string } | string> }>(settles: Map<string, CloseSettle>, bulk: () => Promise<T>): Promise<T> {
  if (!settles.size) return bulk();
  const marks = new Map<string, { prev: TaskResultReport | undefined; at: string }>();
  for (const s of settles.values()) marks.set(s.taskId, await recordSettle(s));
  let result: T;
  try {
    result = await bulk();
  } catch (err) {
    for (const [id, m] of marks) await undoSettle(id, m);
    throw err;
  }
  const done = new Set(result.changed.map((c) => (typeof c === 'string' ? c : c.id)));
  for (const [id, m] of marks) if (!done.has(id)) await undoSettle(id, m);
  return result;
}
