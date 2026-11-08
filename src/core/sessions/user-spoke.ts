/**
 * The user's own words in a task, read before anyone settles its ask in his place (2026-11-07,
 * Main's reflection, two real cases: Main answered "local only" to a task where the user had just
 * written "submit the cr", and "go ahead, stop asking" to one where he had written "discuss before
 * doing"; nothing showed Main his words).
 *
 * A lead, VP or Main that answers a task's ask (task_send answers_ask) or rewrites its Needs you line
 * (task_report_set) is shown what he wrote in that task: every message since the task began asking
 * (StatusReport.needs_since), else his last few. When he wrote after the ask appeared, the step is
 * refused (409 user_spoke_since, his words quoted) unless the caller passes them back in user_words:
 * no caller settles an ask he already spoke to without having read what he said.
 *
 * His words are Walnut's own record: a task's chat (user-asks.ts), or an Org node's Threads.
 */
import type { Task } from '../types.js';
import type { StatusReport } from '../user-status.js';

/** One message the user wrote in the task. */
export interface SpokenWord { at: string; text: string }

/** What the user wrote in the task, as a caller settling its ask is shown it. */
export interface UserSaid {
  /** When the task began asking, or null when unknown. */
  askSince: string | null;
  /** He wrote after that: his messages since then (newest last); else his last few. */
  spokeSince: boolean;
  words: SpokenWord[];
}

/** His last messages shown when he wrote nothing since the ask. */
export const LAST_WORDS_SHOWN = 3;
/** Messages since the ask shown (and to be passed back), newest kept. */
export const SINCE_WORDS_MAX = 10;
const WORD_CHARS = 600;
/** The opening of a message user_words must hold to count as passing it back. */
const QUOTE_CHARS = 60;
/** An opening shorter than this ("ok", "no") must stand as whole words in user_words. */
const SHORT_OPENING = 6;

/**
 * When the task began asking the user without a break: kept from the report before while that one
 * asked too, else this report's own time. Stored on every report (status-question.ts, report-set.ts). Pure.
 */
export function needsSinceOf(
  report: Pick<StatusReport, 'state' | 'at' | 'turn_ended_at'>,
  prev: Pick<StatusReport, 'state' | 'at' | 'turn_ended_at' | 'needs_since'> | null | undefined,
): string | undefined {
  if (report.state !== 'needs') return undefined;
  if (prev?.state === 'needs') return askSinceOf(prev) ?? askSinceOf({ at: report.at, turn_ended_at: report.turn_ended_at }) ?? report.at;
  // A new ask shows from its turn's end: the report is read a little later, and a reply typed in between is since.
  return askSinceOf({ at: report.at, turn_ended_at: report.turn_ended_at }) ?? report.at;
}

/** When the ask the task shows now appeared: the start of its run of asks, or its report's time. Pure. */
export function askSinceOf(r: Pick<StatusReport, 'at' | 'turn_ended_at' | 'needs_since'> | null | undefined): string | null {
  if (!r) return null;
  if (r.needs_since) return r.needs_since;
  // A report an older Walnut stored: the earlier of its two times.
  const times = [r.at, r.turn_ended_at].filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/** What the user said in the task, measured against when its ask appeared. Pure. */
export function userSaidOf(words: readonly SpokenWord[], askSince: string | null): UserSaid {
  const sorted = [...words].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sinceMs = askSince ? Date.parse(askSince) : NaN;
  const since = Number.isFinite(sinceMs) ? sorted.filter((w) => Date.parse(w.at) > sinceMs) : [];
  return since.length
    ? { askSince, spokeSince: true, words: since.slice(-SINCE_WORDS_MAX) }
    : { askSince, spokeSince: false, words: sorted.slice(-LAST_WORDS_SHOWN) };
}

/** Words only, one space apart: case, width (NFKC) and punctuation aside. */
const plain = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * His messages since the ask that `userWords` does not pass back: each one's opening must be in it,
 * case, width, punctuation and spacing aside ("提交CR" and "提交 CR" are one), and a short one as
 * whole words ("ok" is not in "took"). Pure.
 */
export function wordsNotPassedBack(said: UserSaid, userWords: string | undefined): SpokenWord[] {
  if (!said.spokeSince) return [];
  const given = plain(userWords ?? '');
  const spaced = ` ${given} `;
  const joined = given.replace(/ /g, '');
  return said.words.filter((w) => {
    const opening = plain(w.text).slice(0, QUOTE_CHARS).trim();
    if (!opening) return false;
    const bare = opening.replace(/ /g, '');
    return bare.length < SHORT_OPENING ? !spaced.includes(` ${opening} `) : !joined.includes(bare);
  });
}

/** His words as one line each: `2026-11-07 16:10 UTC: "submit the cr"`. Pure. */
export function quoteWords(words: readonly SpokenWord[]): string {
  return words.map((w) => `${stamp(w.at)}: "${w.text.replace(/\s+/g, ' ').trim().slice(0, WORD_CHARS) || '(a picture)'}"`).join('; ');
}

function stamp(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : at;
}

/** The refusal's words, and the next step: read them, then pass them back if the answer stands. Pure. */
export function userSpokeMessage(target: Pick<Task, 'id' | 'title'>, said: UserSaid, what: string): string {
  return `Not ${what}: the user wrote in "${target.title}" (${target.id}) after its ask appeared${said.askSince ? ` (${stamp(said.askSince)})` : ''}, `
    + `so settling it in his place could go against what he said. His words there: ${quoteWords(said.words)}. `
    + 'Read them first. If your answer still stands with them, send it again with user_words quoting each of those messages; '
    + 'if they already answer the ask or change it, tell the task what he said instead, or leave it to him.';
}

/** What a tool that settles an ask says of it (task_send answers_ask, task_report_set). */
export const USER_SPOKE_TEXT = 'Settling a task\'s ask in the user\'s place shows what he wrote in that task (userSaid: his messages since it began asking, '
  + 'else his last few). When he wrote there after the ask appeared, it is refused with 409 user_spoke_since quoting his words: read them, '
  + 'and if your answer still stands, send again with user_words quoting each of them.';
/** How user_words passes his words back. */
export const USER_WORDS_BACK = 'quote each message of his it names (task_history rows with sentBy "person", or his thread messages), word for word.';

/** The user's words as an op's outcome says them, or '' when he wrote nothing there. Pure. */
export function userSaidLine(said: UserSaid | undefined): string {
  if (!said?.words.length) return '';
  return said.spokeSince
    ? `The user wrote there since it asked: ${quoteWords(said.words)}.`
    : `The user's last words there (before it asked): ${quoteWords(said.words)}.`;
}

/** Every message the user wrote in `task`: its chat (user-asks.ts), or an Org node's Threads. Never throws. */
export async function userWordsIn(task: Pick<Task, 'id' | 'org_role' | 'plugin_only'>): Promise<SpokenWord[]> {
  try {
    if (task.org_role === 'main' || task.org_role === 'lead') {
      const { readThreads } = await import('../org/threads-store.js');
      const file = await readThreads(task.id);
      return file.threads.flatMap((t) => t.messages.map((m) => ({ at: m.at, text: m.text })));
    }
    const { readUserAsks, filesUserAsks } = await import('./user-asks.js');
    if (!filesUserAsks(task)) return [];
    return (await readUserAsks(task.id)).asks.map((a) => ({ at: a.at, text: a.text }));
  } catch {
    return [];
  }
}

type Spoken = Pick<Task, 'id' | 'org_role' | 'plugin_only' | 'status_report' | 'user_status'>;

/**
 * What the user said about the ask `task` shows: in it since its ask appeared, and in each task whose
 * same ask is folded under it (user_status.sameAsk), since that one's; else his last few in `task`.
 * `everything`: the task list, to find the folded ones. Never throws.
 */
export async function userSaidIn(task: Spoken, everything: readonly Spoken[] = []): Promise<UserSaid> {
  const own = userSaidOf(await userWordsIn(task), askSinceOf(task.status_report));
  const folded = everything.filter((t) => t.id !== task.id && t.user_status?.sameAsk?.id === task.id);
  const since: SpokenWord[] = own.spokeSince ? [...own.words] : [];
  for (const t of folded) {
    const theirs = userSaidOf(await userWordsIn(t), askSinceOf(t.status_report));
    if (theirs.spokeSince) since.push(...theirs.words);
  }
  if (!since.length) return own;
  since.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { askSince: own.askSince, spokeSince: true, words: since.slice(-SINCE_WORDS_MAX) };
}

/** A task settling `target`'s ask in the user's place: what he said there, and the refusal when he wrote since unseen. */
export interface SettleCheck { said: UserSaid; refusal?: string }

/**
 * The one check every way a task settles another task's ask runs (answers_ask, task_report_set, a
 * phase write): null when `target` shows no ask of its own, or the caller is no other task (the
 * person, or the task itself). `what`: the step, as the refusal names it ("sent", "changed"). Never throws
 * for want of his words: a store it cannot read counts as none.
 */
export async function settleCheck(
  target: Spoken & Pick<Task, 'title'>, callerTaskId: string | null | undefined, userWords: string | undefined, what: string,
  everything: readonly Spoken[] = [],
): Promise<SettleCheck | null> {
  if (!callerTaskId || callerTaskId === target.id) return null;
  const { openAskOf } = await import('./ask-answer.js');
  if (!('ask' in openAskOf(target))) return null;
  const said = await userSaidIn(target, everything);
  return wordsNotPassedBack(said, userWords).length ? { said, refusal: userSpokeMessage(target, said, what) } : { said };
}

/** The task a session works for, or null (a person, an unknown session). */
export async function callerTaskOf(callerSid: string | undefined): Promise<string | null> {
  if (!callerSid) return null;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  return (await getSessionByClaudeId(callerSid).catch(() => null))?.taskId ?? null;
}

/**
 * Another task moving a task that asks the user out of NEED_ACTION (task_update phase) takes the ask
 * off his Needs you as surely as an answer does: the same check (COMPLETE has the close's own,
 * owed-to-user.ts, which names his words). Null when there is nothing to check.
 */
export async function admitPhaseByOther(
  taskId: string, callerSid: string | undefined, phase: unknown, userWords: unknown,
): Promise<SettleCheck | null> {
  if (typeof phase !== 'string' || phase === 'NEED_ACTION' || phase === 'COMPLETE') return null;
  const callerTaskId = await callerTaskOf(callerSid);
  if (!callerTaskId) return null;
  const { getTask, listTasks } = await import('../task-manager.js');
  const target = await getTask(taskId).catch(() => null);
  if (!target || target.phase === 'COMPLETE' || target.phase === phase) return null;
  return settleCheck(target, callerTaskId, typeof userWords === 'string' ? userWords : undefined, `moved to ${phase}`, await listTasks().catch(() => []));
}
