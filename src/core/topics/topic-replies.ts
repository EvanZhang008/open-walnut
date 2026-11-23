/**
 * A woken member's reply is posted to the topic as that member (contract: "your reply in this turn
 * is posted to the topic as you"). When a session with a topic turn in flight ends a turn
 * (session:result, the same subscription thread-answers.ts keeps: a team or a background job still
 * running is not the turn's end, nor is a quiet turn), its last words since the wake are read from
 * its transcript a moment later. Nothing said, or only the agent-ack line: nothing is posted. Else
 * the words are the member's message (its @mentions parsed) and run their own delivery.
 *
 * Which sessions wait on a reply is kept in memory (rebuilt from the topic files at start), so a
 * turn's end in any other session costs nothing. A topic turn older than PENDING_TURN_MAX_MS is
 * dropped, and so is one whose session stopped or whose turn ended in an error (endTurnsOf, after
 * its words are read); a dropped turn that was told more (`more`) sends its one follow-up wake.
 * Started with the server on the primary (startTopics); idle while the experiment is off.
 */
import { log } from '../../logging/index.js';
import { withoutWalnutControl } from '../../lib/walnut-control-text.js';
import { stripAboutTag } from '../org/message-about.js';
import { isQuietTurn } from '../sessions/quiet-turn.js';
import { intermediateResult, type ResultOutliving } from '../sessions/outliving-work.js';
import { parseHinted } from '../hints/hint-format.js';
import { holdNotice } from '../sessions/held-notices.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { PENDING_TURN_MAX_MS, TOPIC_TEXT_MAX, walnutLine, type MemberId, type Topic } from './topics-model.js';
import { TOPIC_NEWS_OUTCOME } from './topic-text.js';
import { sessionTurnLive, TOPIC_TURN_SETTLE_MS } from './topic-turn-live.js';

/** A transcript row as the projection gives it (thread-answers.ts AnswerRow). */
export interface ReplyRow { role: string; text: string; timestamp: string; kind?: string; textWithoutContext?: string; opensTurn?: true }
export type ReadRows = (sessionId: string, since: string) => Promise<ReplyRow[]>;

let rowsOverride: ReadRows | null = null;
/** Test seam: replace the transcript read. */
export function _setTopicTranscriptForTesting(fn: ReadRows | null): void { rowsOverride = fn; }

async function readRows(sessionId: string, since: string): Promise<ReplyRow[]> {
  if (rowsOverride) return rowsOverride(sessionId, since);
  const { rowsSince } = await import('../org/thread-answers.js');
  return rowsSince(sessionId, since);
}

/** session id -> the topics with a turn in flight in it, each with when it was noted (ms). */
const waiting = new Map<string, Map<string, number>>();
let indexed = false;

export function notePendingTurn(sessionId: string, topicId: string, at = Date.now()): void {
  const topics = waiting.get(sessionId) ?? new Map<string, number>();
  topics.set(topicId, at);
  waiting.set(sessionId, topics);
}

/** Rebuild the index from the topic files (start, or the experiment turned on). */
export async function indexPendingTurns(): Promise<void> {
  const { listTopics } = await import('./topics-store.js');
  waiting.clear();
  for (const t of await listTopics()) {
    for (const m of t.members) if (m.pendingTurn) notePendingTurn(m.pendingTurn.sessionId, t.id, Date.parse(m.pendingTurn.since) || Date.now());
  }
  indexed = true;
}

/** Walnut's envelopes in a chat row (walnut-message-tag.ts: open tag, newline, body, newline, close). */
const ENVELOPE_RE = /<walnut-message((?:\s+[a-z-]+="[^"]*")*)\s*>\n[\s\S]*?\n<\/walnut-message>/g;

/**
 * What a user row is to topic `topicId`: `mine` when it carries this topic's wake (a `topic`
 * envelope about it) and nothing else that asks for an answer (Walnut's notifications may ride
 * along); `mixed` when it carries this wake batched with other input (a person's words, another
 * note or wake); `other` for any other input. Message hints are taken off first: they are for the
 * model, not an input.
 */
export function rowFor(row: Pick<ReplyRow, 'text' | 'textWithoutContext'>, topicId: string): 'mine' | 'mixed' | 'other' {
  const text = parseHinted(row.textWithoutContext ?? row.text).text;
  let mine = false;
  let foreign = false;
  const rest = text.replace(ENVELOPE_RE, (_all, attrs: string) => {
    const a = Object.fromEntries([...attrs.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (a.kind === 'topic' && a.about === topicId) mine = true;
    else if (a.kind !== 'notification') foreign = true;
    return '';
  });
  if (!mine) return 'other';
  return !foreign && !rest.trim() ? 'mine' : 'mixed';
}

/**
 * Pure: the member's reply to its last wake of topic `topicId` since `since`, without Walnut's
 * control lines ('' when it said nothing but the agent-ack line, or when its words may answer
 * something else), and whether that turn has spoken at all (no: the wake has not reached the chat
 * yet, or its turn has not said anything, so the reply is still to come).
 *
 * Only the words of the turn that the LAST wake of this topic opened count, never the session's
 * last words: a reply goes to the topic as the member, and from there by mail to people outside
 * Walnut, so words about other work must never ride it. That turn runs from the wake's row to the
 * next row that opens a turn (an input after the turn's own words). Nothing is posted when the wake
 * came in while another turn was still working (its row right after a tool call: the turn's words
 * then answer that work too), or when any other input reached the turn before it spoke (a person's
 * words, another task's note, a mixed batch): the member posts with topic_post then.
 */
export interface TopicReply {
  text: string;
  spoke: boolean;
  /** The words were not taken: the wake went into a busy turn or one batched with other input. */
  busy?: true;
}

export function replyFromRows(rows: readonly ReplyRow[], since: string, topicId: string): TopicReply {
  const isInput = (r: ReplyRow) => r.role === 'user' && !r.kind;
  let at = -1;
  let kind: ReturnType<typeof rowFor> = 'other';
  for (let i = rows.length - 1; i >= 0 && rows[i].timestamp >= since; i--) {
    if (!isInput(rows[i])) continue;
    kind = rowFor(rows[i], topicId);
    if (kind !== 'other') { at = i; break; }
  }
  if (at < 0) return { text: '', spoke: false };
  // Batched with other input: its words may answer that too.
  if (kind === 'mixed') return { text: '', spoke: true, busy: true };
  // Delivered into a running turn: the row before it is that turn's tool call.
  const before = rows.slice(0, at).reverse().find((r) => r.role === 'assistant');
  if (before?.kind === 'tool' && before.timestamp >= since) return { text: '', spoke: true, busy: true };
  // The turn's final text: every text row after its last tool call (a tool call starts it over).
  let final: string[] = [];
  let spoke = false;
  for (let i = at + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isInput(r) || r.opensTurn) {
      const prev = rows[i - 1];
      // After the turn's words: the next turn's input. Before them, or after a tool call: it reached this turn.
      if (spoke && prev.role === 'assistant' && prev.kind !== 'tool') break;
      return { text: '', spoke: true, busy: true };
    }
    if (r.role !== 'assistant') continue;
    if (r.kind === 'tool') { final = []; continue; }
    if (r.kind) continue;
    spoke = true;
    const words = stripAboutTag(withoutWalnutControl(r.text)).trim();
    if (words) final.push(words);
  }
  const text = final.join('\n\n');
  return { text: text ? [...text].slice(0, TOPIC_TEXT_MAX).join('') : '', spoke };
}

/** What a member whose words were not taken is told, riding its next message (never a wake). */
export function notTakenNotice(topic: Pick<Topic, 'id' | 'title'>): string {
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: `Topic: ${topic.title}`, outcome: TOPIC_NEWS_OUTCOME, note: 'about your last topic turn: not a request' },
    body: `Your words in that turn were not posted to topic ${topic.id} "${topic.title}": the turn also handled other input. Post with topic_post if you meant to answer.`,
  });
}

export const notTakenLine = (name: string): string => `${name} was woken but its reply was not posted (busy turn).`;

/**
 * Post the replies waiting in `sessionId`. Exported for tests; never throws. Returns how many were posted.
 * A topic noted for this session whose file shows no turn in it yet is noted again (its delivery may
 * still be writing), until PENDING_TURN_MAX_MS after it was noted. A reply not taken because the
 * turn was busy is said: the member hears it with its next message, and the topic gets a line.
 */
export async function captureReplies(sessionId: string, nowMs = Date.now()): Promise<number> {
  const noted = waiting.get(sessionId);
  if (!noted?.size) return 0;
  waiting.delete(sessionId);
  let posted = 0;
  const store = await import('./topics-store.js');
  for (const [topicId, notedAt] of noted) {
    try {
      const topic = await store.readTopic(topicId);
      if (!topic) continue;
      const mine = topic.members.filter((m) => m.pendingTurn?.sessionId === sessionId);
      if (!mine.length) {
        if (nowMs - notedAt <= PENDING_TURN_MAX_MS) notePendingTurn(sessionId, topicId, notedAt);
        continue;
      }
      for (const member of mine) {
        const turn = member.pendingTurn!;
        const expired = nowMs - Date.parse(turn.since) > PENDING_TURN_MAX_MS;
        const reply: TopicReply = expired ? { text: '', spoke: true } : replyFromRows(await readRows(sessionId, turn.since), turn.since, topicId);
        // Not spoken yet: the turn that ended was an earlier one; wait for the next end.
        if (!reply.spoke) { notePendingTurn(sessionId, topicId, notedAt); continue; }
        await store.updateMember(topicId, member.id, { pendingTurn: undefined });
        if (member.status !== 'active') continue;
        // More was said to it while this turn ran: the follow-up wake asks again, so nothing is said here.
        if (reply.busy && !turn.more) {
          void holdNotice(sessionId, `topic-not-taken:${topicId}`, notTakenNotice(topic));
          await store.mutateTopic(topicId, (t) => { t.messages.push(walnutLine(notTakenLine(member.name))); });
          continue;
        }
        if (reply.text && !reply.busy) {
          const { postMessage } = await import('./topic-post.js');
          await postMessage(topicId, { author: member.id as MemberId, text: reply.text, via: 'agent', allowClosed: !!topic.closed });
          posted++;
        }
        if (turn.more && !expired) {
          const [{ wakeAgain }, { userName }] = await Promise.all([import('./topic-delivery.js'), import('./topic-post.js')]);
          await wakeAgain(topicId, member.id, await userName());
        }
      }
    } catch (err) {
      log.task.warn('topics: a reply was not posted', { topicId, sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return posted;
}

/** The one follow-up wake of a member whose dropped turn was told more meanwhile. */
async function wakeAfterDrop(topicId: string, memberId: string): Promise<void> {
  const [{ wakeAgain }, { userName }] = await Promise.all([import('./topic-delivery.js'), import('./topic-post.js')]);
  await wakeAgain(topicId, memberId, await userName());
}

/** Drop topic turns older than PENDING_TURN_MAX_MS (a session that never ended its turn); one told more wakes again. */
export async function expirePendingTurns(nowMs = Date.now()): Promise<number> {
  const store = await import('./topics-store.js');
  let dropped = 0;
  for (const t of await store.listTopics()) {
    for (const m of t.members) {
      if (!m.pendingTurn || nowMs - Date.parse(m.pendingTurn.since) <= PENDING_TURN_MAX_MS) continue;
      await store.updateMember(t.id, m.id, { pendingTurn: undefined }).catch(() => {});
      waiting.get(m.pendingTurn.sessionId)?.delete(t.id);
      dropped++;
      if (m.pendingTurn.more && m.status === 'active') {
        await wakeAfterDrop(t.id, m.id).catch((err) => log.task.warn('topics: a follow-up wake after an expired turn failed', {
          topicId: t.id, memberId: m.id, error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }
  return dropped;
}

/**
 * The session stopped, or its turn ended in an error: its topic turns bring no reply. What it said
 * is posted first (captureReplies); then each turn still pending in it is dropped, unless the
 * session runs a turn or holds a queued wake again, or the turn is under TOPIC_TURN_SETTLE_MS old
 * (its wake may be what resumes the session). One that was told more sends its follow-up wake.
 * Returns how many were dropped; never throws.
 */
export async function endTurnsOf(sessionId: string, nowMs = Date.now()): Promise<number> {
  let dropped = 0;
  try {
    await captureReplies(sessionId, nowMs);
    const noted = waiting.get(sessionId);
    if (!noted?.size || await sessionTurnLive(sessionId)) return 0;
    const store = await import('./topics-store.js');
    for (const topicId of [...noted.keys()]) {
      const { topic, out: ended } = await store.mutateTopic(topicId, (t) => {
        const gone: Array<{ id: string; more: boolean }> = [];
        for (const m of t.members) {
          const turn = m.pendingTurn;
          if (turn?.sessionId !== sessionId || nowMs - Date.parse(turn.since) <= TOPIC_TURN_SETTLE_MS) continue;
          delete m.pendingTurn;
          gone.push({ id: m.id, more: !!turn.more && m.status === 'active' });
        }
        return gone;
      }, { touch: false });
      dropped += ended.length;
      if (!topic.members.some((m) => m.pendingTurn?.sessionId === sessionId)) noted.delete(topicId);
      for (const one of ended) if (one.more) await wakeAfterDrop(topicId, one.id).catch(() => {});
    }
    if (!noted.size && waiting.get(sessionId) === noted) waiting.delete(sessionId);
  } catch (err) {
    log.task.warn('topics: the turns of a stopped session were not cleared', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
  return dropped;
}

/** One session's reply reads and turn drops, one after another (a result and a stop come close together). */
const sessionChains = new Map<string, Promise<unknown>>();
function inOrder(sessionId: string, run: () => Promise<unknown>): void {
  const next = (sessionChains.get(sessionId) ?? Promise.resolve()).then(run).catch(() => {});
  sessionChains.set(sessionId, next);
  void next.finally(() => { if (sessionChains.get(sessionId) === next) sessionChains.delete(sessionId); });
}

/**
 * Whether a bus event ends a session's turns without a result: a turn that ended in an error
 * (`session:error`), or the session stopped (`session:status-changed` to stopped or error). A
 * delivery failure whose message is still queued for a retry is neither: that wake still comes.
 */
export function endsTopicTurn(name: string, data: unknown): boolean {
  const d = (data ?? {}) as { errorKind?: string; parked?: boolean; process_status?: string; status?: { process_status?: string } };
  if (name === 'session:error') return !(d.errorKind === 'delivery_failed' && !d.parked);
  if (name !== 'session:status-changed') return false;
  const status = d.status?.process_status ?? d.process_status;
  return status === 'stopped' || status === 'error';
}

/** How long after a turn's result its transcript is read (thread-answers.ts waits the same). */
const RESULT_SETTLE_MS = 1500;
const EXPIRE_EVERY_MS = 10 * 60_000;

/** The primary's topic replies: started next to startThreadAnswers; idle while the experiment is off. */
export function startTopics(): { stop: () => void; ready: Promise<void> } {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const subscribed = (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    bus.subscribe('topic-replies', (event) => {
      const d = event.data as { sessionId?: string; turnGen?: number } & ResultOutliving;
      if (!d.sessionId) return;
      const ending = event.name !== EventNames.SESSION_RESULT;
      if (ending ? !endsTopicTurn(event.name, event.data) : intermediateResult(d)) return;
      if (isQuietTurn(d.sessionId, d.turnGen)) return;
      if (indexed && !waiting.has(d.sessionId)) return;
      const sid = d.sessionId;
      // When the turn ended: a host's result read back late (a leader that was away) is judged at its
      // own time (a topic turn's age, its settle), and its reply is posted as any (the topic's record).
      const endedAt = event.timestamp || Date.now();
      const timer = setTimeout(() => {
        timers.delete(timer);
        inOrder(sid, async () => {
          const { topicsEnabled } = await import('./topics-store.js');
          if (!(await topicsEnabled())) return;
          if (!indexed) await indexPendingTurns().catch(() => {});
          await (ending ? endTurnsOf(sid, endedAt) : captureReplies(sid, endedAt));
        });
      }, RESULT_SETTLE_MS);
      timer.unref?.();
      timers.add(timer);
    }, { global: true, interest: ['session:result', 'session:error', 'session:status-changed'] });
  })();
  // The experiment on at boot: know which sessions owe a reply before the first turn ends.
  const firstIndex = import('./topics-store.js').then(async (m) => { if (!stopped && await m.topicsEnabled()) await indexPendingTurns(); }).catch(() => {});
  const expire = setInterval(() => {
    void (async () => {
      const { topicsEnabled } = await import('./topics-store.js');
      if (await topicsEnabled()) await expirePendingTurns().catch(() => 0);
    })();
  }, EXPIRE_EVERY_MS);
  expire.unref?.();
  return {
    // Subscribed and the first index of pending turns built (tests wait on it, never on a clock).
    ready: Promise.all([subscribed, firstIndex]).then(() => {}),
    stop: () => {
      stopped = true;
      clearInterval(expire);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      waiting.clear();
      indexed = false;
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe('topic-replies'));
    },
  };
}

/** Test seam. */
export function _resetTopicRepliesForTesting(): void {
  waiting.clear();
  sessionChains.clear();
  indexed = false;
}

