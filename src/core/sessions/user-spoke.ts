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
  /**
   * The caller acts on words of his it quotes (user_words), and he wrote in the task after them:
   * when the newest message it quotes was written (null: none of his messages Walnut holds), and
   * his messages in the task after it, newest last (wordsAfterQuote).
   */
  quotedAt?: string | null;
  afterQuote?: SpokenWord[];
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

/**
 * When the decision this report asks (its ask_id, kept across rewordings: ask-decision.ts) began to be
 * asked without a break: the report before's while it asked the same decision, else this report's own.
 * Stamped after the decision id (status-question.ts, report-set.ts). Pure.
 */
export function askSinceStamp(
  report: Pick<StatusReport, 'state' | 'ask' | 'ask_id' | 'at' | 'turn_ended_at'>,
  prev: Pick<StatusReport, 'state' | 'ask' | 'ask_id' | 'ask_since' | 'at' | 'turn_ended_at' | 'needs_since'> | null | undefined,
): string | undefined {
  if (report.state !== 'needs' || !report.ask) return undefined;
  const own = askSinceOf({ at: report.at, turn_ended_at: report.turn_ended_at }) ?? report.at;
  if (prev?.state === 'needs' && prev.ask && report.ask_id && prev.ask_id === report.ask_id) {
    // A report an older Walnut stored has no ask_since: the start of its run of asks.
    return prev.ask_since ?? askSinceOf(prev) ?? own;
  }
  return own;
}

/** When the decision the task asks now appeared (askSinceStamp), else when its run of asks began. Pure. */
export function decisionSinceOf(r: Pick<StatusReport, 'at' | 'turn_ended_at' | 'needs_since' | 'ask_since'> | null | undefined): string | null {
  return r?.ask_since ?? askSinceOf(r);
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

/** A quote placed nowhere: his messages in the task this recent count as maybe newer than it. */
export const UNPLACED_QUOTE_MS = 7 * 24 * 60 * 60_000;

/** The parts of user_words in quotation marks, plain and without spaces, each long enough to place. */
function quotedParts(userWords: string): string[] {
  const parts = [...userWords.matchAll(/["\u201c\u300c\u300e]([^"\u201d\u300d\u300f]{2,})["\u201d\u300d\u300f]/g)].map((m) => m[1]);
  return [userWords, ...parts].map((p) => plain(p).replace(/ /g, '')).filter((p) => p.length >= SHORT_OPENING);
}

/** Whether `userWords` passes the message `w` back: its opening is in it (wordsNotPassedBack's rule). Pure. */
export function passesBack(w: SpokenWord, userWords: string | undefined): boolean {
  return !wordsNotPassedBack({ askSince: null, spokeSince: true, words: [w] }, userWords).length;
}

/**
 * Whether the message `w` is where the words `userWords` quotes come from: it passes the message
 * back, or a quoted part of it (or the whole) makes up at least half of the message. A newer message
 * that only mentions the old words ("I changed my mind about no audits: send it") is no source
 * (2026-11-09 review), so it can never move the quote's time past itself. Pure.
 */
export function quotesWord(w: SpokenWord, userWords: string): boolean {
  if (!plain(w.text)) return false;
  if (passesBack(w, userWords)) return true;
  const bare = plain(w.text).replace(/ /g, '');
  return quotedParts(userWords).some((p) => bare.includes(p) && p.length * 2 >= bare.length);
}

/**
 * His messages in the task newer than the words a caller acts on (2026-11-08, the Personal VP's
 * reflection: it answered an ask on his "no inspection" of the day before, and in the task he had
 * since asked for that very email). `inTask`: his messages in the task and in each teammate folded
 * under it, the words that win; `pool`: where else the quote may come from (the caller's own chat or
 * Threads). The EARLIEST message the quote comes from places it: words he repeated later never hide
 * what he wrote between. Placed nowhere, his messages in the task of the last UNPLACED_QUOTE_MS (his
 * last few) may be newer. Null with no quote. Pure.
 */
export function wordsAfterQuote(
  inTask: readonly SpokenWord[], pool: readonly SpokenWord[], userWords: string | undefined, nowMs = Date.now(),
): { quotedAt: string | null; after: SpokenWord[] } | null {
  const given = (userWords ?? '').trim();
  if (!plain(given)) return null;
  const sorted = [...inTask].filter((w) => plain(w.text)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const placed = [...inTask, ...pool].filter((w) => quotesWord(w, given)).map((w) => Date.parse(w.at)).filter(Number.isFinite);
  if (placed.length) {
    const at = Math.min(...placed);
    return { quotedAt: new Date(at).toISOString(), after: sorted.filter((w) => Date.parse(w.at) > at).slice(-SINCE_WORDS_MAX) };
  }
  return { quotedAt: null, after: sorted.filter((w) => nowMs - Date.parse(w.at) <= UNPLACED_QUOTE_MS).slice(-LAST_WORDS_SHOWN) };
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

/** The refusal when he wrote in the task after the words the caller quotes. Pure. */
export function userSpokeAfterQuoteMessage(target: Pick<Task, 'id' | 'title'>, quotedAt: string | null, after: readonly SpokenWord[], what: string): string {
  return `Not ${what}: the user wrote in "${target.title}" (${target.id}) or a teammate whose same ask shows on it `
    + (quotedAt ? `after the words of his you quote (${stamp(quotedAt)})` : 'recently, and Walnut cannot tell when the words of his you quote were written, so these may be newer')
    + `: ${quoteWords(after)}. Newer words of his win over older ones. Read them first. If your answer still stands with them, `
    + 'send it again with user_words quoting each of those messages too; if they change the decision, tell the task what he said instead, or leave it to him.';
}

/** What a tool that settles an ask says of it (task_send answers_ask, task_report_set). */
export const USER_SPOKE_TEXT = 'Settling a task\'s ask in the user\'s place shows what he wrote in that task (userSaid: his messages since it began asking, '
  + 'else his last few). When he wrote there after the ask appeared, it is refused with 409 user_spoke_since quoting his words: read them, '
  + 'and if your answer still stands, send again with user_words quoting each of them. The same holds for his words in that task newer than '
  + 'the ones you quote in user_words: newer words win, so each of them must be quoted too.';
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
  opts: { anyAsk?: boolean } = {},
): Promise<SettleCheck | null> {
  if (!callerTaskId || callerTaskId === target.id) return null;
  const { openAskOf } = await import('./ask-answer.js');
  const open = openAskOf(target);
  // A report or phase write only takes off a report or chat ask; an answer (anyAsk) settles any.
  if (!('ask' in open) || (!opts.anyAsk && open.where !== 'report' && open.where !== 'chat')) return null;
  const said = await userSaidIn(target, everything);
  if (wordsNotPassedBack(said, userWords).length) return { said, refusal: userSpokeMessage(target, said, what) };
  // The words it quotes: his messages in the task newer than them must be quoted too.
  const later = await wordsAfterQuoteIn(target, callerTaskId, userWords, everything);
  if (!later) return { said };
  const unquoted = later.after.filter((w) => !passesBack(w, userWords));
  const shown: UserSaid = { ...said, quotedAt: later.quotedAt, afterQuote: later.after };
  return unquoted.length ? { said: shown, refusal: userSpokeAfterQuoteMessage(target, later.quotedAt, unquoted, what) } : { said: shown };
}

/** wordsAfterQuote on Walnut's record: his words in `target` and its folded teammates, placed against the caller's too. */
async function wordsAfterQuoteIn(
  target: Spoken, callerTaskId: string, userWords: string | undefined, everything: readonly Spoken[],
): Promise<{ quotedAt: string | null; after: SpokenWord[] } | null> {
  if (!plain(userWords ?? '')) return null;
  const folded = everything.filter((t) => t.id !== target.id && t.user_status?.sameAsk?.id === target.id);
  const inTask: SpokenWord[] = [];
  for (const t of [target, ...folded]) inTask.push(...await userWordsIn(t));
  const caller = everything.find((t) => t.id === callerTaskId);
  // The quote may come from the caller's own record or a thread about the task on any Org node
  // (verifyUsersWords finds it there too): placed, it is never read as of unknown time.
  const pool = [
    ...(caller ? await userWordsIn(caller) : []),
    ...(await Promise.all(everything.filter(isOrgNode).map((n) => linkedThreadWords(n.id, target.id)))).flat(),
  ];
  return wordsAfterQuote(inTask, pool, userWords);
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

/** Where a caller's user_words for an ask only the user approves were found in his own record. */
export type UsersWordsCheck =
  | { ok: true; word: SpokenWord; where: string }
  | { ok: false; refusal: string };

/** Under this many characters a quote must be his whole message ("ok", "no", "cahneg"). */
const WHOLE_QUOTE = 12;

/**
 * Whether `userWords` quotes his message `w` itself, the other way round from passesBack: the words
 * (or a part in quotation marks) are his message, or most of it, never a message of his inside a
 * longer line ("no" inside "no problem, buy it"; 2026-11-17 review). Pure.
 */
export function quotesHisMessage(w: SpokenWord, userWords: string): boolean {
  const msg = plain(w.text).replace(/ /g, '');
  if (!msg) return false;
  const parts = [userWords, ...[...userWords.matchAll(/["\u201c\u300c\u300e]([^"\u201d\u300d\u300f]+)["\u201d\u300d\u300f]/g)].map((m) => m[1])]
    .map((p) => plain(p).replace(/ /g, '')).filter(Boolean);
  return parts.some((p) => p === msg || (p.length >= WHOLE_QUOTE && msg.includes(p) && p.length * 2 >= msg.length));
}

/** Where his words may answer an ask about `target`, each read once. Never throws. */
async function hisWordsAbout(
  target: Spoken & Pick<Task, 'title'>, callerTaskId: string, everything: ReadonlyArray<Spoken & Pick<Task, 'title'>>,
): Promise<Array<{ label: string; words: SpokenWord[] }>> {
  const folded = everything.filter((t) => t.id !== target.id && t.user_status?.sameAsk?.id === target.id);
  const caller = everything.find((t) => t.id === callerTaskId);
  const nodes = everything.filter(isOrgNode);
  const [inTasks, callerChat, threads] = await Promise.all([
    Promise.all([target, ...folded].map(async (t) => ({ label: `the chat of "${t.title}"`, words: await userOwnWordsIn(t) }))),
    // A task leading it (no Org node): its own chat, where he tells it what to do with its team.
    caller && !isOrgNode(caller) ? userWordsIn(caller).then((words) => [{ label: 'your own chat', words }]) : Promise.resolve([]),
    // A thread about the task on any Org node, the caller's own included: where he often answers.
    // Only threads linked to the task: a "yes" about something else is no answer here.
    Promise.all(nodes.map(async (n) => ({ label: `${n.id === callerTaskId ? 'your' : `"${n.title}"'s`} thread about the task`, words: await linkedThreadWords(n.id, target.id) }))),
  ]);
  return [...inTasks, ...callerChat, ...threads];
}

/**
 * An ask only the user approves (spending, credentials...) answered in his place stands on his own
 * words, checked in Walnut's record rather than taken on trust (2026-11-17, the Personal VP's
 * reflection: the user answered "cahneg" in its thread on whether to change a portal password, and
 * answers_ask refused his own word as too short, so the ask stayed on his Needs you). `userWords`
 * must quote one message he wrote after `askSince` (when this decision was put to him; null: within
 * UNPLACED_QUOTE_MS): in the task's chat (or a teammate's whose same ask is folded under it), in the
 * caller's own chat when it is no Org node, or in a thread linked to the task on any Org node. A
 * message an agent filed into a thread (via "import") is never his. A typo counts as his: the quote
 * is matched to his record, not to a dictionary. Otherwise the refusal says what to do next.
 */
export async function verifyUsersWords(
  target: Spoken & Pick<Task, 'title'>, callerTaskId: string, userWords: string | undefined,
  everything: ReadonlyArray<Spoken & Pick<Task, 'title'>>, what: string, askSince: string | null, nowMs = Date.now(),
): Promise<UsersWordsCheck> {
  const given = (userWords ?? '').trim();
  const where = `${what} of "${target.title}" (${target.id})`;
  const ask = askSince ? ` after it was put to him (${stamp(askSince)})` : ' (within the last week)';
  const nextStep = 'Find his answer to it (the task\'s chat: task_history rows with sentBy "person"; or a thread about the task) '
    + 'and pass that one message word for word in user_words, typos included (in quotation marks if you add words around it). '
    + 'If he has not answered it yet, leave the ask on his Needs you, or ask him in your thread about the task.';
  if (!plain(given)) {
    return { ok: false, refusal: `Not sent: the ${where} is the user's own decision: answer it in his place only with his own words${ask}. ${nextStep}` };
  }
  const sources = await hisWordsAbout(target, callerTaskId, everything);
  const sinceMs = askSince ? Date.parse(askSince) : nowMs - UNPLACED_QUOTE_MS;
  const found = sources.flatMap((s) => s.words.filter((w) => quotesHisMessage(w, given)).map((w) => ({ w, label: s.label })))
    .sort((a, b) => Date.parse(b.w.at) - Date.parse(a.w.at));
  const after = found.filter((f) => Date.parse(f.w.at) > sinceMs);
  if (after.length) return { ok: true, word: after[0].w, where: after[0].label };
  if (found.length) {
    return {
      ok: false,
      refusal: `Not sent: the words you quote are the user's (${found[0].label}, ${stamp(found[0].w.at)}: "${found[0].w.text.replace(/\s+/g, ' ').slice(0, 200)}"), `
        + `but he wrote them before the ${where} was put to him${askSince ? ` (${stamp(askSince)})` : ''}, so they do not answer it. ${nextStep}`,
    };
  }
  return {
    ok: false,
    refusal: `Not sent: the ${where} is the user's own decision, and the words you quote are not one message of his in Walnut's record `
      + `(searched: ${sources.map((s) => s.label).join('; ')}). ${nextStep}`,
  };
}

const isOrgNode = (t: Pick<Task, 'org_role'>) => t.org_role === 'main' || t.org_role === 'lead';

/** His own messages in `task`: as userWordsIn, without what an agent filed into a thread ("import"). Never throws. */
async function userOwnWordsIn(task: Pick<Task, 'id' | 'org_role' | 'plugin_only'>): Promise<SpokenWord[]> {
  if (!isOrgNode(task)) return userWordsIn(task);
  try {
    const { readThreads } = await import('../org/threads-store.js');
    return (await readThreads(task.id)).threads.flatMap((t) => t.messages.filter((m) => m.via !== 'import').map((m) => ({ at: m.at, text: m.text })));
  } catch {
    return [];
  }
}

/** His messages in the threads of Org node `nodeId` that are about task `taskId`; never one an agent filed. Never throws. */
async function linkedThreadWords(nodeId: string, taskId: string): Promise<SpokenWord[]> {
  try {
    const { readThreads } = await import('../org/threads-store.js');
    return (await readThreads(nodeId)).threads.filter((t) => (t.tasks ?? []).includes(taskId))
      .flatMap((t) => t.messages.filter((m) => m.via !== 'import').map((m) => ({ at: m.at, text: m.text })));
  } catch {
    return [];
  }
}

/** The line that hands the task the user's own words its answer stands on. Pure. */
export function usersWordsLine(check: Extract<UsersWordsCheck, { ok: true }>): string {
  return `The user's own words it stands on (${check.where}, ${stamp(check.word.at)}): "${check.word.text.replace(/\s+/g, ' ').trim().slice(0, WORD_CHARS)}".`;
}
