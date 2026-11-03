/**
 * The user's messages in a task's own chat that the task still owes an answer, as Walnut's own
 * record (user-asks.ts keeps the file). Pure.
 *
 * 2026-11-03, the user, after a worker said "I'll check first, then get back to you" to his
 * question, was compacted twice, and never answered: "why do you miss things? I find that unforgivable" (his words, translated).
 * Only Main and the VPs filed his messages (org Threads); a worker's chat kept them only in its
 * transcript and in its own compaction summary, which dropped the question. A lead's team note
 * counted it answered because the worker's turn ended after it (team-asks.ts answeredUserAsks),
 * and the readback after a compaction never named it.
 *
 *   filed      every message a person typed into a task's chat (or the note of a letter answer)
 *   judged     at each turn end the status question lists the open ones and asks which are still
 *              owed (FOR_USER_OWED): the session's own judgement, recorded by Walnut, so a
 *              compaction cannot lose it; "on it" is still owed, an answer or a delivered result
 *              is not
 *   closed     reported answered, the task completed, or a week old; kept CLOSED_KEEP_MS more,
 *              because the readback after a compaction quotes his recent words, answered ones too
 *
 * Read back first after a compaction (open-items.ts), named at a turn's end when owed across a
 * compaction or for hours (the Stop hook), told to the lead in its team note, and a session that sits on one an hour
 * with no turn running is woken once.
 */

export type UserAskVia = 'chat' | 'letter';
export type UserAskClosedBy = 'report' | 'complete' | 'expired';

export interface UserAsk {
  id: string;
  at: string;
  /** His words, cut at ASK_TEXT_MAX. */
  text: string;
  images?: string[];
  via: UserAskVia;
  /** A letter answer: the letter's subject. */
  about?: string;
  /** The session it went to. */
  sid?: string;
  /** The send's own id, so a retry of it is filed once. */
  key?: string;
  state: 'open' | 'closed';
  /** The last turn-end status that named it still owed. */
  owedAt?: string;
  closedAt?: string;
  closedBy?: UserAskClosedBy;
  /** Turn ends the Stop hook named it at. */
  nudges?: number;
  /** The one wake of an idle session about it. */
  wokenAt?: string;
}

export interface UserAsksFile {
  version: 1;
  taskId: string;
  asks: UserAsk[];
}

export const ASK_TEXT_MAX = 2000;
/** Open asks kept; the oldest past this is closed as expired. */
export const OPEN_MAX = 15;
/** An open ask this old is closed as expired: the work moved on long ago. */
export const OPEN_TTL_MS = 7 * 24 * 3600_000;
/** A closed ask is kept this long, then dropped. */
const CLOSED_KEEP_MS = 3 * 24 * 3600_000;
/** Enough for a night's conversation (2026-11-03: 48 messages in 12 hours) to be read back after a compaction. */
export const CLOSED_MAX = 80;
/** The same words again this soon is one message (a retry). */
const SAME_WORDS_MS = 2 * 60_000;
/** Asks the status question lists. */
export const JUDGE_MAX = 8;
const PREVIEW_CHARS = 300;
/** Owed this long after he wrote: the lead hears of it, the Stop hook names it. */
export const OWED_STALE_MS = 30 * 60_000;
/** Owed this long with no turn running: the session is woken once. */
export const OWED_WAKE_MS = 60 * 60_000;
export const MAX_ASK_STOP_NUDGES = 2;

export function emptyUserAsks(taskId: string): UserAsksFile {
  return { version: 1, taskId, asks: [] };
}

export function normalizeUserAsks(raw: unknown, taskId: string): UserAsksFile {
  const f = raw as Partial<UserAsksFile> | null;
  if (!f || typeof f !== 'object' || !Array.isArray(f.asks)) return emptyUserAsks(taskId);
  const asks = f.asks.filter((a): a is UserAsk => !!a && typeof a.id === 'string' && typeof a.at === 'string'
    && typeof a.text === 'string' && (a.state === 'open' || a.state === 'closed'));
  return { version: 1, taskId, asks };
}

export function openAsks(file: UserAsksFile): UserAsk[] {
  return file.asks.filter((a) => a.state === 'open').sort((a, b) => a.at.localeCompare(b.at));
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface AddAskInput {
  id: string;
  at: string;
  text: string;
  images?: string[];
  via: UserAskVia;
  about?: string;
  sid?: string;
  key?: string;
}

/** One more message of his; a retry of one already filed (its key, or the same words just now) adds nothing. */
export function addAsk(file: UserAsksFile, input: AddAskInput): { file: UserAsksFile; added: boolean } {
  const at = Date.parse(input.at);
  const words = flat(input.text);
  const dup = file.asks.some((a) => (input.key && a.key === input.key)
    || (flat(a.text) === words && Math.abs(Date.parse(a.at) - at) < SAME_WORDS_MS && (a.images ?? []).join() === (input.images ?? []).join()));
  if (dup) return { file, added: false };
  const ask: UserAsk = {
    id: input.id, at: input.at, text: input.text.slice(0, ASK_TEXT_MAX), via: input.via, state: 'open',
    ...(input.images?.length ? { images: input.images.slice(0, 8) } : {}),
    ...(input.about ? { about: input.about.slice(0, 200) } : {}),
    ...(input.sid ? { sid: input.sid } : {}),
    ...(input.key ? { key: input.key } : {}),
  };
  return { file: prune({ ...file, asks: [...file.asks, ask] }, at), added: true };
}

function close(a: UserAsk, by: UserAskClosedBy, at: string): UserAsk {
  return { ...a, state: 'closed', closedAt: at, closedBy: by };
}

/** Expire what is too old or past the open cap; drop closed asks past their keep. */
export function prune(file: UserAsksFile, nowMs: number): UserAsksFile {
  const at = new Date(nowMs).toISOString();
  let asks = file.asks.map((a) => (a.state === 'open' && nowMs - Date.parse(a.at) > OPEN_TTL_MS ? close(a, 'expired', at) : a));
  const open = asks.filter((a) => a.state === 'open').sort((a, b) => a.at.localeCompare(b.at));
  const over = new Set(open.slice(0, Math.max(0, open.length - OPEN_MAX)).map((a) => a.id));
  asks = asks.map((a) => (over.has(a.id) ? close(a, 'expired', at) : a));
  const closed = asks.filter((a) => a.state === 'closed' && nowMs - Date.parse(a.closedAt ?? a.at) < CLOSED_KEEP_MS)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, CLOSED_MAX);
  return { ...file, asks: [...asks.filter((a) => a.state === 'open'), ...closed].sort((a, b) => a.at.localeCompare(b.at)) };
}

/**
 * The status question's verdict: of the asks it listed (`listed`), the ids in `owed` stay open
 * and are marked owed now; the rest are answered. An ask filed after the question was asked is
 * left alone. `owed` null: the answer had no FOR_USER_OWED line, so nothing is judged.
 */
export function applyOwed(file: UserAsksFile, listed: readonly string[], owed: ReadonlySet<string> | null, at: string): { file: UserAsksFile; closed: string[] } {
  if (!owed) return { file, closed: [] };
  const inList = new Set(listed);
  const closed: string[] = [];
  const asks = file.asks.map((a) => {
    if (a.state !== 'open' || !inList.has(a.id)) return a;
    if (owed.has(a.id)) return { ...a, owedAt: at };
    closed.push(a.id);
    return close(a, 'report', at);
  });
  return { file: { ...file, asks }, closed };
}

export function closeAll(file: UserAsksFile, by: UserAskClosedBy, at: string): UserAsksFile {
  return { ...file, asks: file.asks.map((a) => (a.state === 'open' ? close(a, by, at) : a)) };
}

export function ago(iso: string, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function preview(a: UserAsk, max = PREVIEW_CHARS): string {
  const words = flat(a.text);
  const pics = a.images?.length ? ` [${a.images.length} picture${a.images.length > 1 ? 's' : ''}]` : '';
  const cut = words.length > max ? `${words.slice(0, max)}...` : words;
  return `${cut || '(a picture only)'}${pics}`;
}

/** The asks the status question lists: the newest open ones. */
export function asksToJudge(file: UserAsksFile): UserAsk[] {
  return openAsks(file).slice(-JUDGE_MAX);
}

/** What the status question adds when the task has open asks. '' when none. */
export function owedQuestionBlock(asks: readonly UserAsk[], nowMs: number): string {
  if (!asks.length) return '';
  const lines = asks.map((a) => `[${a.id}] ${ago(a.at, nowMs)}${a.via === 'letter' ? ' (his answer to your letter)' : ''}: "${preview(a)}"`);
  return [
    '',
    'Walnut keeps the user\'s messages in this task that may still wait for your answer:',
    ...lines,
    'FOR_USER_OWED: the ids of those you still owe him, separated by commas: his question not answered yet, or what he asked '
      + 'for not done and reported back to him yet ("I will check" and "on it" are still owed). none when you answered every one '
      + '(an answer in your chat, or the result he asked for, already given to him).',
  ].join('\n');
}

const OWED_LINE_RE = /(?:^|\n)\s*\**FOR_USER_OWED\**\s*:\**\s*([\s\S]*?)(?=\n\s*\**[A-Z][A-Z_]{3,}\**\s*:|$)/i;
const ASK_ID_RE = /\bua-[a-z0-9]{4,16}\b/gi;

/**
 * The ids the answer names still owed: its FOR_USER_OWED value up to the next label (ids may sit
 * on the lines below it). An empty set only for an explicit "none"; null when there is no such
 * line, or a value that names neither ids nor none ("the first one"), so nothing is judged.
 */
export function readOwedLine(answer: string): Set<string> | null {
  const m = OWED_LINE_RE.exec(answer);
  if (!m) return null;
  const ids = (m[1].match(ASK_ID_RE) ?? []).map((id) => id.toLowerCase());
  if (ids.length) return new Set(ids);
  return /^\W*none\b/i.test(m[1]) ? new Set() : null;
}

/** The readback after a compaction: his words, whole, oldest first. '' when none. */
export function owedReadback(asks: readonly UserAsk[], nowMs: number, max = 4_000): string {
  if (!asks.length) return '';
  const head = 'The user\'s messages in this task that you have not answered yet, in his own words (Walnut\'s record, '
    + 'not your summary; it closes each one when your turn-end status says it is answered). Answer each one in your chat, '
    + 'or, when the work it asks for still runs, carry on and give him the result:';
  const out: string[] = [head];
  let used = head.length;
  let left = 0;
  for (const a of [...asks].sort((x, y) => x.at.localeCompare(y.at))) {
    const line = `- ${ago(a.at, nowMs)} (${a.at.slice(0, 16).replace('T', ' ')} UTC)${a.via === 'letter' ? `, answering your letter${a.about ? ` "${flat(a.about)}"` : ''}` : ''}: "${preview(a, 1200)}"`;
    if (used + line.length + 1 > max) { left++; continue; }
    out.push(line);
    used += line.length + 1;
  }
  if (left) out.push(`- and ${left} more: open_items lists them.`);
  return out.join('\n');
}

/** Owed long enough that the lead hears of it. */
export function staleOwed(file: UserAsksFile, nowMs: number): UserAsk[] {
  return openAsks(file).filter((a) => a.owedAt && nowMs - Date.parse(a.at) >= OWED_STALE_MS);
}

/** What the Stop hook says about the asks it names. */
export function owedStopReason(asks: readonly UserAsk[], nowMs: number): string {
  return [
    `Walnut: before this turn ends, the user still waits for your answer to ${asks.length === 1 ? 'a message' : `${asks.length} messages`} in this task:`,
    ...asks.map((a) => `- ${ago(a.at, nowMs)}: "${preview(a)}"`),
    'If you have the answer or the result, give it to him now, in your chat. Still working on it: end the turn as you planned and '
      + 'give him the result when it is ready. Already answered: end the turn; Walnut closes it with your turn-end status.',
  ].join('\n');
}

/** The note that wakes an idle session about an ask it still owes. */
export function owedWakeBody(asks: readonly UserAsk[], nowMs: number): string {
  return [
    `The user is still waiting for your answer to ${asks.length === 1 ? 'a message' : `${asks.length} messages`} in this task (your last status said you owe it):`,
    ...asks.map((a) => `- ${ago(a.at, nowMs)}: "${preview(a)}"`),
    'Answer him now in your chat, or tell him in one line where it stands and when he gets the result. Walnut wakes you for this once.',
  ].join('\n');
}

/** How far back the readback after a compaction quotes his words, answered ones too. */
export const RECENT_WORDS_MS = 48 * 3600_000;
/** The most that readback adds: the hook's whole text has HOOK_CONTEXT_MAX (open-items.ts). */
export const RECENT_WORDS_MAX = 1_600;
const RECENT_PREVIEW_CHARS = 160;

/**
 * The readback after a compaction of what he said in this task lately, answered ones too: his own
 * words, newest kept first when they do not all fit, listed oldest first. The open ones are left out
 * (owedReadback quotes them whole). '' when there are none.
 *
 * 2026-11-03: a worker and the user talked for twelve hours (48 messages of his: a risk review, a
 * report, a team post); three compactions later its summary kept one line of that thread, and when
 * he came back it had moved on to other work and could not say where his thread stood. Every one of
 * those messages had been answered, so the owed readback had nothing to say. Each compaction keeps
 * the user's messages since the last one and only a summary of the summary before, so his words
 * thin out one compaction at a time; Walnut's record does not.
 */
export function recentWordsReadback(file: UserAsksFile, nowMs: number, max = RECENT_WORDS_MAX): string {
  const recent = file.asks
    .filter((a) => a.state === 'closed' && nowMs - Date.parse(a.at) <= RECENT_WORDS_MS)
    .sort((a, b) => b.at.localeCompare(a.at));
  if (!recent.length) return '';
  const head = 'What the user said in this task over the last two days, answered ones too, in his own words (Walnut\'s '
    + 'record; your summary keeps less of them each compaction). It is the thread of work he follows. The exchange around '
    + `one: walnut tools call task_history '{"id":"${file.taskId}","before":"<a minute after it>"}'`;
  const lines: string[] = [];
  let used = head.length;
  let left = 0;
  for (const a of recent) {
    const line = `- ${a.at.slice(0, 16).replace('T', ' ')} UTC${a.via === 'letter' ? ', answering your letter' : ''}: "${preview(a, RECENT_PREVIEW_CHARS)}"`;
    if (left || used + line.length + 1 > max) { left++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return [head, ...lines.reverse(), ...(left ? [`- and ${left} earlier: task_history with before reads them.`] : [])].join('\n');
}
