/**
 * The reply language, corrected only when a line the user reads broke it (2026-11-14, the org
 * reflection: with the language only a line of the system prompt, agents answered the user's
 * English messages in English for whole turns; "Yes, CPU went down too..." four times in a row, a
 * worker's progress lines English for an hour, a router's letters English). The rule itself stays
 * in the prompt (sessions/reply-language-context.ts); this module adds text only on a drift, so a
 * session that keeps the language pays nothing.
 *
 * Three places, one check (hint-drift-detect.ts languageDrift: code, paths, links and HTML do not
 * count, a short line proves nothing):
 *   - Inside a turn a person started: the main lane's lines are kept per message id and judged when
 *     a tool call follows them. The first line off gets one short correction, delivered mid-turn so
 *     a native Claude Code session reads it with the next tool result; again only after two more
 *     lines off, at most LIVE_MAX a turn. ACP engines take one prompt per turn: the turn end covers them.
 *   - At the end of such a turn: when a line after the last correction (or any, with none) was off,
 *     the session's hint state marks the drift, and the next message carries the `reply-language`
 *     hint (hint-registry.ts, its one trigger `on_drift`) with the correction.
 *   - A letter a session writes the user (human_inbox_send, human_inbox_reply, a router's for_user
 *     brief): one off gets a note in the op's answer, the next tool result its writer reads.
 *
 * The Settings switch of the `reply-language` hint turns all three off. The correction's words are
 * Walnut's English followed by the user's own rule (2026-11-05, the user: no language of Walnut's
 * own in the product).
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import { LIVE_MIN_LETTERS, languageDrift } from './hint-drift-detect.js';
import { findHint } from './hint-registry.js';
import { replyLanguageText } from '../sessions/output-mode.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { isQuietTurn } from '../sessions/quiet-turn.js';
import { stripAboutTag } from '../org/message-about.js';

const SUBSCRIBER = 'reply-language-drift';
const KIND = 'reply-language';
const TEXT_MAX = 4000;
const MESSAGES_MAX = 24;
/** Sessions followed at once; the oldest is dropped past it. */
const SESSIONS_MAX = 300;
/** Corrections in one turn: the next one only when two more lines after the last are still off. */
const LIVE_MAX = 2;
const OFF_BEFORE_NEXT = 2;
const QUOTE_MAX = 160;
/** Characters of each part of a letter that are judged. */
const LETTER_JUDGE_CHARS = 20_000;

interface Turn {
  /** Main-lane text per message id, in arrival order. */
  texts: Map<string, string>;
  /** Message ids already judged (a tool call or the turn's end followed them). */
  judged: Set<string>;
  /** Did a person start this turn? Known from the row delivered for it, else read from the record once. */
  person: Promise<boolean>;
  /** A person's row was delivered into this turn while it ran (he wrote mid-turn). */
  personNow: boolean;
  sending: boolean;
  /** Corrections delivered while this turn ran, and tried (delivered or not). */
  corrections: number;
  attempts: number;
  /** Lines off since the last correction (since the start, with none). */
  offAfter: number;
  /** Any line off in the whole turn, and any judged in the language. */
  anyOff: boolean;
  anyIn: boolean;
}

const turns = new Map<string, Turn>();
/** Who wrote each queued row (session:message-queued), until it is delivered. */
const queuedBy = new Map<string, 'person' | 'agent'>();
const QUEUED_MAX = 2000;
/** Whether the rows delivered last to a session with no turn open yet held a person's. */
const deliveredBy = new Map<string, boolean>();

/** The correction's fixed words; the user's rule follows them. */
export function liveCorrectionText(said: string): string {
  return `Your line just now was not in the user's language: "${said}". Write every line from here on in it, `
    + 'the short ones between tool calls included, also when a tool result or a message you received is in English.';
}
/** Said in English in every language: the tag is the same in all. */
export const LIVE_LATE_LINE = 'If your turn had already ended when this arrived, reply with only <walnut-turn status="agent-ack"/>.';

/** The line as quoted: one line, cut at QUOTE_MAX. */
export function quoteLine(line: string): string {
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1)}…` : one;
}

export function liveCorrectionMessage(rule: string, said: string): string {
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'reply-language', note: 'a correction of this turn, not a work request' },
    body: `${liveCorrectionText(quoteLine(said))} ${rule}\n${LIVE_LATE_LINE}`,
  });
}

/** The note a letter off the language gets in its op's answer. */
export function letterLanguageNoteText(rule: string): string {
  return `Reply language: this letter is not in the user's language. It went out as written; write every letter, `
    + `reply and line the user reads in it from now on (an English quote or draft inside one is fine). ${rule}`;
}

let ruleCache: { rule: string | null; enabled: boolean; at: number } | null = null;
/** The rule and the switch; kept 30 s for the per-tool-call path, emptied on a settings change. A letter reads fresh. */
async function currentRule(fresh = false): Promise<{ rule: string | null; enabled: boolean }> {
  if (!fresh && ruleCache && Date.now() - ruleCache.at < 30_000) return ruleCache;
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig().catch(() => null);
  // The hint's switch and its one trigger: an override that dropped on_drift turns the check off too.
  const hint = findHint(config, KIND);
  ruleCache = { rule: replyLanguageText(config), enabled: !!hint?.enabled && hint.triggers.includes('on_drift'), at: Date.now() };
  return ruleCache;
}

/** What the user reads of a text: Walnut's tasks line and style or script blocks left out. */
function readable(text: string): string {
  // An unclosed block (a cut body) runs to the end: CSS is never the user's language either way.
  return stripAboutTag(text).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(style|script)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
}

/**
 * A letter's words (subject, body, preview), judged as one: the note for its op's answer when it is
 * off the user's language, else null. Never throws.
 */
export async function letterLanguageNote(parts: ReadonlyArray<unknown>): Promise<string | null> {
  try {
    // A body may be megabytes of inline media: its head is enough to tell, and the event loop stays free.
    const text = parts.filter((p): p is string => typeof p === 'string' && !!p.trim())
      .map((p) => p.slice(0, LETTER_JUDGE_CHARS).replace(/data:[^\s"')]+/g, ' ')).join('\n');
    if (!text) return null;
    const { rule, enabled } = await currentRule(true);
    if (!rule || !enabled) return null;
    return languageDrift(rule, readable(text)) === true ? letterLanguageNoteText(rule) : null;
  } catch {
    return null;
  }
}

function bounded<V>(map: Map<string, V>, key: string, value: V, max = SESSIONS_MAX): void {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

/** The last send to this session was a person's (hint-send.ts records it on every send). */
async function personStarted(sid: string): Promise<boolean> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sid);
    return rec?.hintState?.lastSendBy === 'person';
  } catch {
    return false;
  }
}

function startTurn(sid: string): Turn {
  const known = deliveredBy.get(sid);
  deliveredBy.delete(sid);
  const t: Turn = {
    texts: new Map(), judged: new Set(), person: known !== undefined ? Promise.resolve(known) : personStarted(sid), personNow: false, sending: false,
    corrections: 0, attempts: 0, offAfter: 0, anyOff: false, anyIn: false,
  };
  bounded(turns, sid, t);
  return t;
}

function noteText(sid: string, data: Record<string, unknown>): void {
  if (data.parentToolUseId || data.replayed === true || typeof data.delta !== 'string' || !data.delta) return;
  const t = turns.get(sid) ?? startTurn(sid);
  const key = typeof data.msgId === 'string' && data.msgId ? data.msgId : '_';
  const cur = t.texts.get(key);
  if (cur === undefined) {
    if (t.texts.size >= MESSAGES_MAX) {
      const oldest = t.texts.keys().next().value as string;
      t.texts.delete(oldest);
      t.judged.delete(oldest);
    }
    t.texts.set(key, data.delta.slice(0, TEXT_MAX));
  } else if (cur.length < TEXT_MAX) {
    t.texts.set(key, (cur + data.delta).slice(0, TEXT_MAX));
  }
}

/** The messages a tool call (or the turn's end) completed, not judged yet; taken in event order. */
function unjudged(t: Turn): string[] {
  const out: string[] = [];
  for (const [id, text] of t.texts) {
    if (t.judged.has(id)) continue;
    t.judged.add(id);
    if (text.trim()) out.push(readable(text));
  }
  return out;
}

const personOf = async (t: Turn): Promise<boolean> => t.personNow || await t.person;

/** Rows went into the session: a person's among them makes the turn they open, or run in, his. */
function noteDelivered(sid: string, ids: unknown): void {
  if (!Array.isArray(ids)) return;
  const kinds = ids.map((id) => queuedBy.get(String(id))).filter(Boolean);
  for (const id of ids) queuedBy.delete(String(id));
  if (!kinds.length) return;
  const person = kinds.includes('person');
  const t = turns.get(sid);
  if (t) { if (person) t.personNow = true; }
  else bounded(deliveredBy, sid, person);
}

/** Judge lines into the turn's counts; the lines that were off. */
async function judge(t: Turn, texts: string[]): Promise<{ rule: string; off: string[] } | null> {
  if (!texts.length || !(await personOf(t))) return null;
  const { rule, enabled } = await currentRule();
  if (!rule || !enabled) return null;
  const off: string[] = [];
  for (const x of texts) {
    const v = languageDrift(rule, x, LIVE_MIN_LETTERS);
    if (v === true) off.push(x);
    else if (v === false) t.anyIn = true;
  }
  if (off.length) { t.anyOff = true; t.offAfter += off.length; }
  return { rule, off };
}

async function judgeAtToolUse(sid: string, t: Turn): Promise<void> {
  const verdict = await judge(t, unjudged(t));
  if (!verdict?.off.length) return;
  const due = !t.sending && t.attempts < LIVE_MAX && t.offAfter >= (t.corrections ? OFF_BEFORE_NEXT : 1);
  if (!due) return;
  t.sending = true;
  t.attempts += 1;
  const said = verdict.off[verdict.off.length - 1];
  const sent = await sendCorrection(sid, verdict.rule, said, () => turns.get(sid) === t).catch((err) => {
    log.session.warn('reply-language: live correction not delivered', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
    return false;
  });
  t.sending = false;
  // Counted only when it went out while the turn still ran; otherwise the turn end marks the drift.
  if (sent && turns.get(sid) === t) { t.corrections += 1; t.offAfter = 0; }
}

/** Deliver the correction to a running native session. */
async function sendCorrection(sid: string, rule: string, said: string, stillRunning: () => boolean): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sid).catch(() => null);
  if (!rec || rec.process_status !== 'running') return false;
  const { engineCaps } = await import('../agents/engine-registry.js');
  if (engineCaps(rec.engine).runtimeKind !== 'native') return false;
  if (!stillRunning()) return false;
  const { deliverToSession } = await import('../sessions/session-send-core.js');
  const text = liveCorrectionMessage(rule, said);
  // Checked again right before the row is stored: a turn that ended meanwhile gets none (it would
  // start a turn of its own), and the turn end marks the drift instead.
  try {
    await deliverToSession(rec, { busText: text, enqueueText: text, source: 'walnut-notify', stillWanted: stillRunning, ...(rec.taskId ? { taskId: rec.taskId } : {}) });
  } catch (err) {
    if (!stillRunning()) return false;
    throw err;
  }
  log.session.info('reply-language: live correction sent', { sessionId: sid, taskId: rec.taskId });
  return true;
}

/**
 * The turn ended: still off after the last correction (or off with none) marks the drift for the
 * next message; a turn in the language throughout clears an older mark.
 */
async function finishTurn(sid: string, t: Turn): Promise<void> {
  const verdict = await judge(t, unjudged(t));
  if (!verdict && !(await personOf(t))) return;
  const broke = t.offAfter > 0;
  if (!broke && (t.anyOff || !t.anyIn)) return;
  const { writeHintState } = await import('./hint-send.js');
  const at = new Date().toISOString();
  await writeHintState(sid, (cur) => {
    const state = cur.hintState;
    if (!state) return null;
    const drift = { ...(state.drift ?? {}) };
    if (broke) drift[KIND] = at;
    else if (drift[KIND]) delete drift[KIND];
    else return null;
    const { drift: _old, ...rest } = state;
    return { hintState: Object.keys(drift).length ? { ...rest, drift } : rest };
  });
  if (broke) log.session.info('reply-language: drift marked for the next message', { sessionId: sid, corrections: t.corrections });
}

/** Judgements still running (a test waits for them: `_settledForTest`). */
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

function onEvent(event: BusEvent): void {
  if (event.name === EventNames.CONFIG_CHANGED) { ruleCache = null; return; }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
  if (!sid) return;
  switch (event.name) {
    case EventNames.SESSION_MESSAGE_QUEUED:
      if (typeof data.messageId === 'string' && (data.sentBy === 'person' || data.sentBy === 'agent')) bounded(queuedBy, data.messageId, data.sentBy, QUEUED_MAX);
      return;
    case EventNames.SESSION_MESSAGES_DELIVERED:
      noteDelivered(sid, data.messageIds);
      return;
    case EventNames.SESSION_TEXT_DELTA:
      noteText(sid, data);
      return;
    case EventNames.SESSION_TOOL_USE: {
      const t = turns.get(sid);
      if (data.parentToolUseId || !t) return;
      track(judgeAtToolUse(sid, t));
      return;
    }
    case EventNames.SESSION_RESULT: {
      // A result withheld for background work leaves the turn going (derive/session.ts).
      if (data.teamActive || data.backgroundActive) return;
      let t = turns.get(sid);
      turns.delete(sid);
      // A quiet turn (Walnut's idle compaction) wrote nothing the user reads.
      if (isQuietTurn(sid, (data as { turnGen?: number }).turnGen) || data.interrupted || data.isError) return;
      // A turn whose lines never streamed here is judged from its result.
      if (!t && typeof data.result === 'string' && data.result.trim()) {
        t = startTurn(sid);
        turns.delete(sid);
        t.texts.set('_result', data.result.slice(0, TEXT_MAX));
      }
      if (t) track(finishTurn(sid, t));
      return;
    }
    case EventNames.SESSION_STATUS_CHANGED:
      if (data.process_status === 'stopped' || data.process_status === 'error') turns.delete(sid);
      return;
  }
}

export function startReplyLanguageDrift(): void {
  bus.subscribe(SUBSCRIBER, onEvent, {
    global: true,
    interest: [EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE, EventNames.SESSION_RESULT,
      EventNames.SESSION_STATUS_CHANGED, EventNames.CONFIG_CHANGED, EventNames.SESSION_MESSAGE_QUEUED,
      EventNames.SESSION_MESSAGES_DELIVERED],
  });
}

export function stopReplyLanguageDrift(): void {
  bus.unsubscribe(SUBSCRIBER);
  turns.clear();
  queuedBy.clear();
  deliveredBy.clear();
  ruleCache = null;
}

/** Test seam: every judgement and delivery started so far has finished. */
export async function _settledForTest(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
