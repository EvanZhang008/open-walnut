/**
 * Action needed: every open thing a task asks of the user, one list per task (2026-11-19, the user:
 * "如果他需要我什么东西，他可以不blocking的……会在这个 task 的 panel 上面……显示一个 approval,
 * action needed……我就可以直接在那里面 approve, make decision", and "这个东西本身 snooze").
 *
 * A task's own state (Working, Waiting, ...) stays what it is; its open asks ride beside it as
 * `user_status.actions`: an approval its session asked for, a prompt its session waits on, a
 * decision letter it sent, a Board choice about it, or its own report's ask. Each is answered where
 * it lives (the approval's answer, the session's permission answer, the letter's answer, the Board
 * choice, a message to its session), and each can be snoozed on its own (`Task.action_snoozes`)
 * without snoozing the task.
 *
 * The state rule (applyActions): a task with an open action that is not snoozed reads Needs you,
 * with `working` set when its turn still runs, so every surface counts it once and its row still
 * says Working. When every action that made it Needs you is snoozed, it reads Waiting / snoozed
 * until the earliest one comes back, the same shape a task's own snooze has (snooze.ts), so every
 * reminder path that honours `snoozed` honours this too.
 *
 * ACTION_KIND_OF_SOURCE maps every place a Needs you can come from (UserStatus.source) to its kind,
 * or null with why it is no answerable item; tests/core/action-needed-ratchet.test.ts fails when a
 * new source, a new kind or a surface that answers them is not wired in.
 *
 * Pure and browser-safe: the server derives it (user-status-sync.ts) and the web imports the types.
 */
import type { AskForm, AskOption, UserStatus } from './user-status.js';

/** In the order a row draws them: what blocks a session first. */
export type ActionKind = 'question' | 'permission' | 'approval' | 'letter' | 'choice' | 'ask';
export const ACTION_KINDS: readonly ActionKind[] = ['question', 'permission', 'approval', 'letter', 'choice', 'ask'];

/** The word that leads an item on every surface. */
export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  question: 'Question', permission: 'Permission', approval: 'Approval', letter: 'Letter', choice: 'Choice', ask: 'Ask',
};

/** Where a Needs you lives (UserStatus.source) and the action kind it is, or null and why not. */
export const ACTION_KIND_OF_SOURCE: Record<NonNullable<UserStatus['source']>, ActionKind | 'prompt' | null> = {
  // A session's live prompt: AskUserQuestion is a question, any other tool a permission (promptKind).
  prompt: 'prompt',
  letter: 'letter',
  choice: 'choice',
  session: 'ask',
  approval: 'approval',
  // A failure is no ask with an answer: its row offers Retry or Open (the session's error banner).
  error: null,
  // Main's or a lead's Threads: answered in the thread itself (Org page), never on a task row.
  thread: null,
};

export interface ActionItem {
  kind: ActionKind;
  /** Its own id where it lives: `apr-...`, a prompt's request id, `lt-...`, a Board choice id, an ask id. */
  id: string;
  /** One line, the thing asked. */
  summary: string;
  /** A line or two of why, under it (a letter's preview, an ask's more, an approval's summary). */
  detail?: string;
  /** When it was asked (ISO). */
  at?: string;
  /** The session that asks (a prompt, an ask) or that asked (an approval). */
  sessionId?: string;
  /** The session waits on it and does nothing until it is answered (a live prompt). */
  blocking?: true;
  /** One-click answers: a letter's actions, a one-question prompt's options, an ask's options. */
  options?: AskOption[];
  /** A question prompt that takes several picks. */
  multi?: true;
  /** A one-question prompt: its question word for word, the key its answer is sent under. */
  question?: string;
  /** An ask from its report in its one-click shape. */
  form?: AskForm;
  /** A Board choice: the Board (its owner task) it is on. */
  board?: string;
  /** An approval whose Approve needs a device's proof (Touch ID, a Passwords unlock): answered in its dialog. */
  proof?: true;
  /** Snoozed by the user until this time (ISO); absent when it is not. */
  snoozedUntil?: string;
}

/** One snooze of one item (Task.action_snoozes). */
export interface ActionSnooze { id: string; until: string; at: string; by?: string }
/** How many a task keeps: a snooze of an item that is gone is dropped at the next write. */
export const ACTION_SNOOZES_MAX = 40;

export function promptKind(toolName: string | null | undefined): 'question' | 'permission' {
  return toolName === 'AskUserQuestion' ? 'question' : 'permission';
}

/** The status source an item answers as. */
export function sourceOfKind(kind: ActionKind): NonNullable<UserStatus['source']> {
  return kind === 'question' || kind === 'permission' ? 'prompt' : kind === 'ask' ? 'session' : kind;
}

/** The snooze in effect on an item now (its until, ISO), or undefined. */
export function snoozeOfItem(snoozes: readonly ActionSnooze[] | null | undefined, id: string, nowMs = Date.now()): string | undefined {
  const s = (snoozes ?? []).find((x) => x.id === id);
  if (!s) return undefined;
  const at = Date.parse(s.until);
  return Number.isFinite(at) && at > nowMs ? s.until : undefined;
}

/** The items with their snoozes marked, in draw order. Pure. */
export function markSnoozes(items: readonly ActionItem[], snoozes: readonly ActionSnooze[] | null | undefined, nowMs = Date.now()): ActionItem[] {
  const order = (k: ActionKind) => ACTION_KINDS.indexOf(k);
  return items
    .map((it) => { const until = snoozeOfItem(snoozes, it.id, nowMs); const { snoozedUntil: _old, ...rest } = it; return until ? { ...rest, snoozedUntil: until } : rest; })
    .sort((a, b) => order(a.kind) - order(b.kind) || (a.at ?? '').localeCompare(b.at ?? ''));
}

/** The snooze list after one write: `until` null takes it off; expired and unknown ones are dropped. */
export function writeSnooze(
  prev: readonly ActionSnooze[] | null | undefined, id: string, until: string | null, nowMs = Date.now(), by?: string,
): ActionSnooze[] {
  const kept = (prev ?? []).filter((s) => s.id !== id && Date.parse(s.until) > nowMs);
  if (until) kept.push({ id, until, at: new Date(nowMs).toISOString(), ...(by ? { by } : {}) });
  return kept.slice(-ACTION_SNOOZES_MAX);
}

/** The ask a status shows as its own item (a report's ask or a Board choice it already reads). */
export function ownItemOf(s: UserStatus, sessionId?: string): ActionItem | null {
  if (s.state !== 'needs' || !s.ask) return null;
  if (s.source === 'session') {
    const id = s.decision?.id ?? `ask:${hashWords(s.ask)}`;
    return strip<ActionItem>({ kind: 'ask', id, summary: s.askForm?.summary ?? s.ask, ...(detailOf(s.askForm?.more, s.askForm?.summary ?? s.ask)), sessionId: s.askSessionId ?? sessionId, ...(s.askForm ? { form: s.askForm, options: s.askForm.options } : {}), at: s.checkedAt });
  }
  if (s.source === 'choice' && s.choice) return { kind: 'choice', id: s.choice.id, summary: s.ask, board: s.choice.board };
  return null;
}

/** An item's detail: its words on one line, cut at 240, and none when they only repeat its summary. */
export function detailOf(words: string | null | undefined, summary: string): { detail?: string } {
  const d = (words ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const same = (x: string) => x.replace(/[\s.。!！?？]+$/g, '').trim();
  return d && same(d) !== same(summary.replace(/\s+/g, ' ')) ? { detail: d } : {};
}

/** A short stable id for words (FNV-1a), for an ask that has no decision id. */
export function hashWords(words: string): string {
  let h = 0x811c9dc5;
  for (const ch of words.replace(/\s+/g, ' ').trim()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/**
 * The status a task reads with its actions (see the header). `items` are the live facts (an
 * approval, a prompt, a letter) without the status's own ask, which this adds from the status.
 * `orgNode`: Main and a lead keep their own rule (their asks are in chat and Threads), so their
 * status carries the items but never changes for them. Pure.
 */
export function applyActions(
  s: UserStatus, items: readonly ActionItem[], snoozes: readonly ActionSnooze[] | null | undefined,
  opts: { orgNode?: boolean; held?: boolean; sessionId?: string; nowMs?: number } = {},
): UserStatus {
  const nowMs = opts.nowMs ?? Date.now();
  if (s.state === 'done') return s;
  const own = ownItemOf(s, opts.sessionId);
  // The prompt a status already names is the live item itself (`items` carries it).
  const all = markSnoozes(own && !items.some((i) => i.id === own.id) ? [...items, own] : items, snoozes, nowMs);
  if (!all.length) return s;
  const out: UserStatus = { ...s, actions: all };
  // The items ride along and the state is as derived for: an org node (its asks are in its chat and
  // Threads), a task snoozed by its start date (snooze.ts), one held by its team's stop (`held`),
  // and an ask another task asks the same or a lead answered (same-ask.ts: one decision shows once).
  if (opts.orgNode || opts.held || s.snoozed || s.sameAsk || s.answeredFor) return out;
  const open = all.filter((i) => !i.snoozedUntil);
  const ownSource = s.state === 'needs' && s.source ? s.source : undefined;
  const ownIsItem = !!ownSource && ACTION_KIND_OF_SOURCE[ownSource] !== null;
  // A failure or a person's own mark speaks first; so does an ask whose item Walnut does not hold.
  if (s.state === 'needs' && (!ownIsItem || !all.some((i) => sourceOfKind(i.kind) === ownSource))) return out;
  if (open.length) {
    if (s.state === 'needs' && open.some((i) => sourceOfKind(i.kind) === ownSource)) return out;
    // An approval is listed with its own buttons everywhere (the corner, the approvals line), so a
    // status that reads `approval` asks nothing else: another open item names the status first.
    const first = open.find((i) => i.kind !== 'approval') ?? open[0];
    const { kind: _k, waitingOn: _w, until: _u, toRead: _t, carriesOn: _c, choice: _ch, askForm: _f, decision: _d, ...rest } = out;
    return strip<UserStatus>({
      ...rest, state: 'needs', source: sourceOfKind(first.kind), ask: first.summary, category: 'decide',
      ...(first.kind === 'choice' && first.board ? { choice: { board: first.board, id: first.id } } : {}),
      ...(first.kind === 'ask' && s.askForm ? { askForm: s.askForm, ...(s.decision ? { decision: s.decision } : {}) } : {}),
      ...(s.state === 'working' ? { working: true as const } : {}),
    });
  }
  // Every item is snoozed: a status that asked the user through one of them sleeps until the first
  // comes back; a status that asked nothing of the user (working, waiting on others) is as it is.
  if (s.state !== 'needs') return out;
  const until = all.map((i) => i.snoozedUntil!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return strip<UserStatus>({
    state: 'waiting', kind: 'time', waitingOn: `Snoozed until ${until}`, until,
    now: s.now, next: s.next, at: s.at, line: s.line, stale: s.stale, due: s.due, threads: s.threads,
    ...(s.reportBy ? { reportBy: s.reportBy } : {}), ...(s.reportSessionId ? { reportSessionId: s.reportSessionId } : {}),
    ...(s.askBy ? { askBy: s.askBy, ...(s.askSessionId ? { askSessionId: s.askSessionId } : {}) } : {}),
    snoozed: { until, ...(s.ask ? { ask: s.ask } : {}) }, actions: all,
  });
}

/** The item a status's own needs line names (its source's item), when Walnut holds one. */
export function ownLineIsItem(s: Pick<UserStatus, 'state' | 'source' | 'actions'> | null | undefined): boolean {
  if (!s || s.state !== 'needs' || !s.source || ACTION_KIND_OF_SOURCE[s.source] === null) return false;
  return (s.actions ?? []).some((i) => sourceOfKind(i.kind) === s.source);
}

/** When a snooze of this one item ran out (ms), or NaN: a re-check counts from then (snooze.ts snoozeEndedMs). */
export function itemSnoozeEndedMs(snoozes: readonly ActionSnooze[] | null | undefined, id: string, nowMs = Date.now()): number {
  const at = Date.parse((snoozes ?? []).find((x) => x.id === id)?.until ?? '');
  return Number.isFinite(at) && at <= nowMs ? at : NaN;
}

/** The open (not snoozed) items of a status. */
export function openActions(s: Pick<UserStatus, 'actions'> | null | undefined): ActionItem[] {
  return (s?.actions ?? []).filter((i) => !i.snoozedUntil);
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
