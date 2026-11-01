/**
 * The reply language, corrected inside the turn: in a turn a person started, the first progress
 * line the user reads in the wrong language gets one correction, delivered mid-turn so it lands
 * with the next tool result, instead of after the turn (hint-drift.ts, the next message).
 *
 * 2026-11-01: a worker answered the user's own messages in English in 17 of 27 replies while he
 * was talking to it; the turn-end check named it only on his next message, so each long turn
 * stayed English to its end ("The machine load just dropped from about 90 to 26, so I'm
 * re-measuring...", the line after his "what the hack?").
 *
 * How: the main lane's text deltas are kept per message id; a message is complete when a tool
 * call follows it, and only then judged (languageDrift, the turn-end sensor's own test). Who
 * started the turn is read when it starts: the last Walnut send since the previous turn ended
 * (SESSION_SEND's source, send-sent-by.ts); a turn with none is the CLI's own (a background
 * command back, a wakeup), never a person's. The correction goes once per turn through the
 * mid-turn path (deliverToSession, source walnut-notify): a native Claude Code session reads it
 * with the tool result. ACP engines take one prompt per turn, so a correction there would start
 * a turn of its own; they keep the turn-end correction only. If the turn ends before the line is
 * read (its last tool was quick), the CLI runs it as a turn of its own: the line asks for the
 * no-action reply then, which the chat hides. At the turn's end the sensor asks this module what
 * came after a correction that went out in the turn (`takeLiveCorrection`): a turn that came back
 * to the language is not named again.
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import { languageDrift } from './hint-drift-detect.js';
import { findHint } from './hint-registry.js';
import { replyLanguageText } from '../sessions/output-mode.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { queueSentBy } from '../sessions/send-sent-by.js';

const SUBSCRIBER = 'hint-drift-live';
const TEXT_MAX = 4000;
const MESSAGES_MAX = 24;
/** Sessions followed at once; the oldest is dropped past it. */
const SESSIONS_MAX = 300;

interface LiveTurn {
  /** A person's send started it. */
  personTurn: boolean;
  /** Main-lane text per message id, in arrival order. */
  texts: Map<string, string>;
  /** Message ids already judged (a tool call followed them). */
  judged: Set<string>;
  /** A correction is on its way (sent at most once per turn). */
  sending: boolean;
  /** The correction was queued while this turn still ran. */
  corrected: boolean;
  /** Messages judged after the correction: did any break the rule again? */
  driftAfter: boolean;
}

const turns = new Map<string, LiveTurn>();
/** The last send per session (its source, when), and when its last turn ended (`seq`). */
const lastSend = new Map<string, { source: string; at: number }>();
const turnEnded = new Map<string, number>();
/** Event order (sends and turn ends in one millisecond still compare). */
let seq = 0;
/** A finished turn's outcome (a promise: its last lines may still be judged), until the sensor reads it. */
const finished = new Map<string, Promise<{ driftAfter: boolean }>>();

/** The correction's words. */
export const LIVE_CORRECTION_TEXT = 'Correction: your progress line just now was not in the user\'s language, and he reads '
  + 'this chat now. Write every line from here on in it, the short ones between tool calls included, also when a tool '
  + 'result or your own notes are in English. If your turn had already ended when this arrived, reply with only '
  + '<walnut-turn status="agent-ack"/>.';

export function liveCorrectionMessage(rule: string): string {
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'reply-language', note: 'a correction of this turn, not a work request' },
    body: `${LIVE_CORRECTION_TEXT} ${rule}`,
  });
}

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= SESSIONS_MAX) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

function startTurn(sid: string): LiveTurn {
  const send = lastSend.get(sid);
  const personTurn = !!send && send.at > (turnEnded.get(sid) ?? 0) && queueSentBy(send.source) === 'person';
  const t: LiveTurn = { personTurn, texts: new Map(), judged: new Set(), sending: false, corrected: false, driftAfter: false };
  bounded(turns, sid, t);
  finished.delete(sid);
  return t;
}

function endTurn(sid: string): LiveTurn | undefined {
  const t = turns.get(sid);
  turns.delete(sid);
  bounded(turnEnded, sid, ++seq);
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

/** The messages a tool call (or the turn's end) completed, not judged yet. */
function unjudged(t: LiveTurn): string[] {
  const out: string[] = [];
  for (const [id, text] of t.texts) {
    if (t.judged.has(id)) continue;
    t.judged.add(id);
    if (text.trim()) out.push(text);
  }
  return out;
}

let ruleCache: { rule: string | null; enabled: boolean; at: number } | null = null;
async function currentRule(): Promise<{ rule: string | null; enabled: boolean }> {
  if (ruleCache && Date.now() - ruleCache.at < 30_000) return ruleCache;
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig().catch(() => null);
  const hint = findHint(config, 'reply-language');
  ruleCache = { rule: replyLanguageText(config), enabled: !!hint?.enabled && hint.triggers.includes('on_drift'), at: Date.now() };
  return ruleCache;
}

async function judgeAtToolUse(sid: string, t: LiveTurn): Promise<void> {
  // Taken now, in event order: a later tool call or the turn's end judges the rest.
  const texts = unjudged(t);
  if (!texts.length) return;
  const { rule, enabled } = await currentRule();
  if (!rule || !enabled) return;
  const drifted = texts.some((x) => languageDrift(rule, x) === true);
  if (t.corrected) { if (drifted) t.driftAfter = true; return; }
  if (!drifted || t.sending || !t.personTurn) return;
  t.sending = true;
  const sent = await sendCorrection(sid, rule).catch((err) => {
    log.session.warn('reply-language: live correction not delivered', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
    return false;
  });
  // Counted for this turn only when it went out while the turn still ran; otherwise the turn-end
  // check judges the turn as before (and names it on the next message).
  if (sent && turns.get(sid) === t) t.corrected = true;
}

/** Deliver the correction to a running native session. */
async function sendCorrection(sid: string, rule: string): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sid).catch(() => null);
  if (!rec || rec.process_status !== 'running') return false;
  const { engineCaps } = await import('../agents/engine-registry.js');
  if (engineCaps(rec.engine).runtimeKind !== 'native') return false;
  const { deliverToSession } = await import('../sessions/session-send-core.js');
  const text = liveCorrectionMessage(rule);
  await deliverToSession(rec, { busText: text, enqueueText: text, source: 'walnut-notify', ...(rec.taskId ? { taskId: rec.taskId } : {}) });
  log.session.info('reply-language: live correction sent', { sessionId: sid, taskId: rec.taskId });
  return true;
}

function finishTurn(sid: string): void {
  const t = endTurn(sid);
  if (!t?.corrected) return;
  const texts = unjudged(t);
  bounded(finished, sid, (async () => {
    if (texts.length) {
      const { rule } = await currentRule();
      if (rule && texts.some((x) => languageDrift(rule, x) === true)) t.driftAfter = true;
    }
    return { driftAfter: t.driftAfter };
  })());
}

/** Judgements still running (a test waits for them: `_settledForTest`). */
const inflight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

function onEvent(event: BusEvent): void {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
  if (!sid) return;
  switch (event.name) {
    case EventNames.SESSION_SEND:
      // A redelivery trigger carries no message of its own.
      if (typeof data.message === 'string' && data.message && event.source) bounded(lastSend, sid, { source: event.source, at: ++seq });
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
    case EventNames.SESSION_RESULT:
      // A result withheld for background work leaves the turn going (derive/session.ts).
      if (data.teamActive || data.backgroundActive) return;
      if (data.interrupted || data.isError) { endTurn(sid); return; }
      finishTurn(sid);
      return;
    case EventNames.SESSION_STATUS_CHANGED:
      if (data.process_status === 'stopped' || data.process_status === 'error') endTurn(sid);
      return;
  }
}

/**
 * For the turn-end sensor, read once: when a correction went out in this turn, whether a line
 * after it broke the rule again; undefined when none did.
 */
export async function takeLiveCorrection(sid: string): Promise<{ driftAfter: boolean } | undefined> {
  const f = finished.get(sid);
  if (!f) return undefined;
  finished.delete(sid);
  return f;
}

export function startLiveDrift(): void {
  bus.subscribe(SUBSCRIBER, onEvent, {
    global: true,
    interest: [EventNames.SESSION_SEND, EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE, EventNames.SESSION_RESULT,
      EventNames.SESSION_STATUS_CHANGED],
  });
}

export function stopLiveDrift(): void {
  bus.unsubscribe(SUBSCRIBER);
  turns.clear();
  finished.clear();
  lastSend.clear();
  turnEnded.clear();
  ruleCache = null;
}

/** Test seam: every judgement and delivery started so far has finished. */
export async function _settledForTest(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
