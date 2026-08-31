/**
 * Boot-time healer for lane answers stranded by a mid-turn server death.
 *
 * The defect it repairs (observed repeatedly, 2 of 14 relayed phone turns over
 * two days): a deploy SIGTERMs the server while a Personal AI lane turn is
 * running. The `claude` CLI is owned by the daemon, so it survives, finishes the
 * answer, and writes it durably — into its stream JSONL and its own transcript.
 * But the piece that persists the answer into the CONVERSATION store lived in
 * the killed process (the awaited `runLaneTurn` promise plus its bus
 * subscription in runApiV1LaneTurn), and re-attach deliberately skips replay
 * (fresh attach subscribes future-only), so nothing ever adopts it. The
 * conversation is left reading user→user, and the user's answer exists only on
 * disk where no surface reads it.
 *
 * ── Correlation is STRUCTURAL, not lexical ──
 * `session:result` carries no id of the message it answers (see lane-turn.ts's
 * MVP-approximation note), so the pairing has to be reconstructed. Two ordered
 * sequences describe the same events: the conversation's turn-starting user
 * entries, and the stream's turn slots (one per turn-starting `user` line, the
 * same boundary session-reconcile's fold anchors on). Every lane delivery writes
 * a marker, in order, so ordinal position is the real key:
 *
 *   1. bound the stream window (slots older than the tail cannot exist), and
 *      drop store turns that predate it, so ordinals cannot be shifted;
 *   2. take the same-text FAMILY on both sides, dropping any slot whose delivered
 *      text is itself another turn's message (exact ownership beats suffix
 *      membership); the counts must then be equal, else the sequences disagree
 *      and we refuse rather than guess;
 *   3. the orphan's ordinal inside its store family selects its OWN slot;
 *   4. that slot must itself hold a successful result. Errored or resultless
 *      means "this turn produced no answer" — never a reason to look at another
 *      slot;
 *   5. the slot's delivery marker must sit within a tight window of the store
 *      write, which is a same-box, sub-second relationship.
 *
 * The guarantee, stated exactly: an answer is only ever adopted from the slot
 * that ordinal alignment identifies as the orphan's own, and every ambiguity
 * (count mismatch, missing marker, out-of-window marker, errored or resultless
 * own slot) is a refusal. It is NOT "any slot whose text looks similar" — an
 * earlier version was, and it could adopt a neighbouring turn's answer whenever
 * the orphan's own turn had no usable result, which is the observed
 * retyped-question shape with one variable flipped.
 *
 * ── Safety posture ──
 * Idempotent (adoption is refused when that answer text is already anywhere in
 * the store), bounded (a capped number of recent lane conversations, a capped
 * tail read per stream, a capped number of orphans per conversation, a line-
 * chunked parse that yields to the event loop), and non-fatal by construction:
 * every step is wrapped, and the whole pass is scheduled after `listen` so a
 * failure here can never keep the server down.
 *
 * It also never SETTLES anything. A recovered turn ended minutes-to-hours ago;
 * announcing it with a terminal frame would settle whatever turn is live now
 * (see the emit note at the bottom of this file), so the only signal is an
 * advisory bus event no client treats as terminal.
 */

import { log } from '../../logging/index.js';
import { bus } from '../event-bus.js';
import { isRealUserLine, daemonStreamPathCandidates } from '../session-reconcile.js';
import {
  listStoreTurns,
  listOrphanTurnTails,
  adoptRecoveredAssistantMessage,
  type OrphanTurnTail,
  type StoreTurnRef,
  type AdoptRecoveredOutcome,
} from '../chat-history.js';
import { parseLaneKey } from './personal-ai-lane.js';

/**
 * Advisory event fired after an adoption. Deliberately NOT any of the terminal
 * turn events (`message-end`, `agent:response`): those SETTLE the conversation's
 * live turn, and a recovered answer is by definition an old one. No client
 * handler consumes this name today, so it is observable in the WS log and inert
 * everywhere else; clients read the adopted message from the store as usual.
 */
export const RECOVERED_TURN_EVENT = 'chat:turn-recovered';

/** Tail window per stream file. Not smaller: in the confirmed instance the
 *  orphan's own user line sat 1.62 MB from the end of a 2.6 MB file, so a 1-2 MB
 *  window would have missed the very case this exists for. The event-loop cost
 *  of a window this size is paid off by the chunked parse below, not by
 *  shrinking it. */
const STREAM_TAIL_BYTES = 4 * 1024 * 1024;

/** Lines folded between event-loop yields. A 4 MB window is ~8.6k lines and
 *  ~200 ms of JSON.parse; measured on the real 2.6 MB stream (5,670 lines,
 *  120 ms) that is ~21 ms per 1,000 lines, which is a slice the web server can
 *  absorb. One uninterrupted 200 ms parse is exactly what the "never block the
 *  event loop" rule forbids — every route shares this loop. */
const PARSE_LINE_CHUNK = 1_000;

/** Recent lane conversations examined per pass. A lane whose orphan still
 *  matters is by definition recently active. */
const DEFAULT_MAX_LANES = 25;

/** Orphans healed per conversation per pass. */
const MAX_ORPHANS_PER_LANE = 5;

/**
 * Marker-vs-store-write proximity, the tight window step 5 applies.
 *
 * The eager store persist happens inside the per-agent turn queue slot,
 * immediately before the lane delivery that writes the marker, on the SAME box:
 * the confirmed instance measured 103 ms. The only legitimate stretch is a cold
 * lane resolve/spawn, itself capped at 90 s (`waitForLaneRecord`). So 120 s
 * forward covers a worst-case cold spawn with margin, while rejecting the real
 * impostor in that same conversation — a same-text turn 470,878 ms away — by
 * almost 4x. Backwards is clock jitter only (the store write provably precedes
 * the marker), hence the much smaller allowance.
 */
const MARKER_FORWARD_TOLERANCE_MS = 120_000;
const MARKER_BACK_TOLERANCE_MS = 60_000;

/**
 * Needle floor for the SUFFIX arm of text matching (either bound satisfies it).
 *
 * The only legitimate reason a delivered lane message differs from the stored one
 * is the image-context block, which is PREPENDED as whole lines
 * (`buildSessionImageContext` ends with a blank line). The suffix arm therefore
 * demands a NEWLINE BOUNDARY — that alone is what refuses "sounds good ok" for an
 * orphaned 'ok' — plus this floor as a second layer, in case a real multi-line
 * message happens to end with a line that equals some other message.
 *
 * Two bounds because either is sufficient evidence of a substantive message, and
 * neither alone covers both shapes: a short-but-wordy question ("which one is
 * better", 19 chars / 4 words) and a long single token (a pasted path). Chars OR
 * words, same lesson as MIN_NEEDLE_SEGMENTS in path-ref-parse: bound the needle,
 * don't just cap the search. Acknowledgements — 'ok', 'yes', '?', 'continue',
 * 'go on' — fail both, so they can only ever match EXACTLY.
 */
const MIN_SUFFIX_NEEDLE_CHARS = 16;
const MIN_SUFFIX_NEEDLE_WORDS = 4;

/** One turn as the stream file records it. */
export interface LaneStreamTurnSlot {
  /** Text of the turn-opening user line. */
  text: string;
  /** Walnut's delivery marker timestamp (ISO), when the daemon wrote one. */
  timestamp?: string;
  /** The turn's answer — last successful result inside the slot, else null. */
  answer: string | null;
  /** `duration_ms` of that result, for an honest completion timestamp. */
  durationMs?: number;
  /** True when the slot's last result was an error (never adopted). */
  errored: boolean;
}

/** Plain text of a stream `user` line's message content. */
function streamUserText(parsed: Record<string, unknown>): string {
  const content = (parsed.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Fold ONE stream line into the slot list.
 *
 * A slot opens on every turn-starting `user` line and closes at the next one, so
 * a result can only ever be attributed to the turn it physically sits inside.
 * Within a slot the LAST successful result wins (a team/subagent workflow emits
 * intermediate results before the final answer); an error result marks the slot
 * errored and clears any answer, because the turn's verdict was a failure.
 * Lines before the first user line belong to a turn that started before the
 * window and are dropped — a tail read can only heal what it can see whole.
 */
function foldStreamLine(slots: LaneStreamTurnSlot[], line: string): void {
  if (!line || line.charCodeAt(0) !== 0x7b /* '{' */) return; // torn prefix / blank
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  const type = parsed.type as string | undefined;
  if (type === 'user') {
    if (!isRealUserLine(parsed)) return;
    slots.push({
      text: streamUserText(parsed),
      ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : {}),
      answer: null,
      errored: false,
    });
    return;
  }
  if (type !== 'result') return;
  const slot = slots[slots.length - 1];
  if (!slot) return; // result of a turn that opened before the window
  if (parsed.is_error === true) {
    slot.errored = true;
    slot.answer = null;
    return;
  }
  const answer = typeof parsed.result === 'string' ? parsed.result : '';
  if (!answer) return;
  slot.errored = false;
  slot.answer = answer;
  slot.durationMs = typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined;
}

/** Split a stream-file tail into turn slots (see {@link foldStreamLine}). Pure;
 *  use {@link parseLaneStreamTurnsYielding} anywhere on the server's event loop. */
export function parseLaneStreamTurns(tail: string): LaneStreamTurnSlot[] {
  const slots: LaneStreamTurnSlot[] = [];
  for (const line of tail.split('\n')) foldStreamLine(slots, line);
  return slots;
}

/** Identical result to {@link parseLaneStreamTurns}, folded in
 *  {@link PARSE_LINE_CHUNK}-line slices with an event-loop yield between them so
 *  a multi-MB window cannot pin the loop every route shares. */
export async function parseLaneStreamTurnsYielding(tail: string): Promise<LaneStreamTurnSlot[]> {
  const slots: LaneStreamTurnSlot[] = [];
  const lines = tail.split('\n');
  for (let i = 0; i < lines.length; i++) {
    foldStreamLine(slots, lines[i]);
    if ((i + 1) % PARSE_LINE_CHUNK === 0) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
  return slots;
}

/** Two store texts are the same turn text. Both sides come from the store, so
 *  this is exact — nothing fuzzy may decide which ordinal a turn holds. */
function sameStoreText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Was `slotText` (as DELIVERED to the lane) this store message?
 *
 * Exact, or the store text as the final line-aligned block of a longer delivered
 * message — the image-context prefix, and nothing else. See
 * {@link MIN_SUFFIX_NEEDLE_CHARS} for why the loose `endsWith` this replaces was
 * unsafe.
 */
function slotDeliveredText(slotText: string, storeText: string): boolean {
  const slot = slotText.trim();
  const store = storeText.trim();
  if (!slot || !store) return false;
  if (slot === store) return true;
  const words = store.split(/\s+/).filter(Boolean).length;
  if (store.length < MIN_SUFFIX_NEEDLE_CHARS && words < MIN_SUFFIX_NEEDLE_WORDS) return false;
  return slot.endsWith(`\n${store}`);
}

export interface OrphanMatch {
  /** Index of the matched slot (exposed for tests/logging, not for writing). */
  slotIndex: number;
  answer: string;
  /** Honest completion time: delivery marker + the turn's own duration. */
  completedAt: string;
}

/**
 * The answer of the orphan's OWN turn, or null.
 *
 * Ordinal alignment, in the five steps the file header lists. Every branch that
 * cannot prove which slot belongs to the orphan returns null: a wrong answer in
 * someone's conversation is strictly worse than a missing one, and the missing
 * one is what the store already shows.
 *
 * `storeTurns` must be the conversation's FULL turn sequence in order (see
 * chat-history.listStoreTurns), including answered turns — they hold ordinals.
 */
export function matchOrphanToAnswer(
  orphan: OrphanTurnTail,
  slots: LaneStreamTurnSlot[],
  storeTurns: StoreTurnRef[],
): OrphanMatch | null {
  const orphanMs = Date.parse(orphan.timestamp);
  if (!Number.isFinite(orphanMs)) return null;

  // 1. Window floor. The tail starts mid-conversation, so store turns older than
  //    the earliest marker in the window have no slot here; counting them would
  //    shift every ordinal after them.
  let firstMarkerMs = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    if (!slot.timestamp) continue;
    const ms = Date.parse(slot.timestamp);
    if (Number.isFinite(ms) && ms < firstMarkerMs) firstMarkerMs = ms;
  }
  // No marker anywhere in the window: ordinals cannot be anchored to a time at
  // all (a pre-marker daemon). Refuse rather than fall back to text similarity.
  if (!Number.isFinite(firstMarkerMs)) return null;
  // A store turn whose marker is in this window can predate that marker by at
  // most the FORWARD tolerance (marker = store + [-back, +forward] ⇒ store >=
  // marker - forward). Using the smaller back-tolerance here excluded an
  // orphan's own turn whenever its delivery lagged, which then read as a
  // count mismatch and refused a valid heal.
  const floorMs = firstMarkerMs - MARKER_FORWARD_TOLERANCE_MS;

  // 2. Same-text families on both sides; unequal counts mean the two sequences
  //    disagree about this text (a lost delivery, a truncated window, a
  //    neighbour whose delivered text merely resembles this one) → refuse.
  const storeFamily = storeTurns.filter((t) => {
    const ms = Date.parse(t.timestamp);
    return Number.isFinite(ms) && ms >= floorMs && sameStoreText(t.text, orphan.text);
  });
  const slotFamily = slots.filter((s) => {
    if (!slotDeliveredText(s.text, orphan.text)) return false;
    // Exact ownership beats suffix membership. The suffix arm exists for the
    // image-context prefix, but any longer message ENDING with the orphan's text
    // also passes it — e.g. a pasted error log that closes with the same
    // question. When that longer text is itself one of the conversation's turns,
    // the slot is demonstrably THAT turn's delivery, so it must not sit in the
    // orphan's family: admitting it either fabricates an answer (the orphan's own
    // delivery is missing, counts tie 1-1, ordinal 0 hands over the log's answer)
    // or inflates the count and refuses a valid heal. A slot matching the orphan
    // EXACTLY is never rejected here — the check only fires on suffix members.
    if (sameStoreText(s.text, orphan.text)) return true;
    return !storeTurns.some((t) => sameStoreText(t.text, s.text));
  });
  if (slotFamily.length === 0 || storeFamily.length !== slotFamily.length) return null;

  // 3. The orphan's ordinal in its own family selects its own slot.
  const ordinal = storeFamily.findIndex((t) => t.turnId === orphan.turnId);
  if (ordinal < 0) return null;
  const own = slotFamily[ordinal];

  // 4. Own slot, or nothing. An errored or resultless own slot means this turn
  //    produced no answer — never a licence to read a different slot. (This is
  //    the branch whose absence let a retyped question's answer be written back
  //    onto the turn that failed.)
  if (!own || own.errored || !own.answer) return null;

  // 5. Proximity: same-box, sub-second in practice.
  if (!own.timestamp) return null;
  const markerMs = Date.parse(own.timestamp);
  if (!Number.isFinite(markerMs)) return null;
  const signed = markerMs - orphanMs;
  if (signed < -MARKER_BACK_TOLERANCE_MS || signed > MARKER_FORWARD_TOLERANCE_MS) return null;

  return {
    slotIndex: slots.indexOf(own),
    answer: own.answer,
    completedAt: new Date(markerMs + (own.durationMs ?? 0)).toISOString(),
  };
}

/** A lane-bound conversation to examine. */
export interface LaneRef {
  sessionId: string;
  agentId: string;
  conversationId: string;
  host: string | null;
}

export interface AdoptedLaneTurn extends LaneRef {
  turnId: string;
  text: string;
  answer: string;
  completedAt: string;
}

export interface LaneOrphanReport {
  lanesScanned: number;
  orphansFound: number;
  adopted: number;
  /** Reason → count, for one summary log line. */
  skipped: Record<string, number>;
}

export interface LaneOrphanRecoveryOptions {
  /** Test seam: enumerate lane conversations (default = the session registry). */
  listLanes?: () => Promise<LaneRef[]>;
  /** Test seam: read a lane stream's tail (default = the daemon file reader). */
  readStreamTail?: (lane: LaneRef) => Promise<string | null>;
  /** Called after each adoption — the caller owns telling connected clients. */
  onAdopted?: (adopted: AdoptedLaneTurn) => void | Promise<void>;
  maxLanes?: number;
}

/** Lane-bound, non-archived sessions, most recently active first. Bounded by an
 *  index-backed read — never a whole-table scan. */
async function defaultListLanes(limit: number): Promise<LaneRef[]> {
  const { listRecentSessionRecords } = await import('../session-tracker.js');
  // Widened over `limit`: the window is ordered by activity across ALL sessions,
  // and lanes are a small minority of them.
  const records = await listRecentSessionRecords(400);
  const lanes: LaneRef[] = [];
  for (const record of records) {
    if (record.archived) continue;
    const parsed = parseLaneKey(record.lane);
    if (!parsed) continue;
    lanes.push({
      sessionId: record.claudeSessionId,
      agentId: parsed.agentId,
      conversationId: parsed.conversationId,
      host: record.host ?? null,
    });
    if (lanes.length >= limit) break;
  }
  return lanes;
}

/** Byte offset the tail read starts at for a file of `size` bytes. Exported so
 *  the window bound is asserted, not just declared. */
export function streamTailStart(size: number): number {
  return Math.max(0, size - STREAM_TAIL_BYTES);
}

/** Drop the torn first line of a window that began mid-file. The parser also
 *  skips any line not starting with '{', so this is belt-and-braces — but it is
 *  what guarantees a half-written line can never be re-joined with the next. */
export function dropTornPrefix(content: string, start: number): string {
  if (start === 0) return content;
  const nl = content.indexOf('\n');
  return nl >= 0 ? content.slice(nl + 1) : '';
}

/** Bounded tail of the lane's stream file, via the daemon (host-uniform). */
async function defaultReadStreamTail(lane: LaneRef): Promise<string | null> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(lane.host ?? '__local__');
  for (const candidate of daemonStreamPathCandidates(lane.sessionId, lane.host)) {
    let size = -1;
    try {
      const st = await reader.stat(candidate);
      if (st === null) continue;
      size = st.size;
    } catch { continue; }
    if (size <= 0) continue;
    const start = streamTailStart(size);
    try {
      const res = await reader.readFileRange(candidate, start);
      if (res === null) continue;
      return dropTornPrefix(res.content, start);
    } catch { continue; }
  }
  return null;
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/**
 * One reconciliation pass. Never throws — every failure is counted and logged.
 *
 * Deliberately re-runnable: a pass right after boot may find the orphan's turn
 * still unfinished (the surviving CLI writes its result seconds AFTER the new
 * server is up), so the caller schedules a few spaced passes. Adoption being
 * idempotent is what makes that safe.
 */
export async function reconcileLaneOrphanTurns(
  opts: LaneOrphanRecoveryOptions = {},
): Promise<LaneOrphanReport> {
  const report: LaneOrphanReport = { lanesScanned: 0, orphansFound: 0, adopted: 0, skipped: {} };
  const maxLanes = Math.max(1, opts.maxLanes ?? DEFAULT_MAX_LANES);

  let lanes: LaneRef[];
  try {
    lanes = opts.listLanes ? await opts.listLanes() : await defaultListLanes(maxLanes);
  } catch (err) {
    log.session.warn('lane orphan recovery: could not list lanes', {
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const lane of lanes.slice(0, maxLanes)) {
    report.lanesScanned++;
    let orphans: OrphanTurnTail[];
    let storeTurns: StoreTurnRef[];
    try {
      orphans = await listOrphanTurnTails(lane.agentId, lane.conversationId);
      // The full sequence is only needed once an orphan exists — reading it is
      // the same store read, so fetch it after the cheap gate below would have
      // skipped the lane.
      storeTurns = orphans.length === 0 ? [] : await listStoreTurns(lane.agentId, lane.conversationId);
    } catch (err) {
      bump(report.skipped, 'store-read-failed');
      log.session.debug('lane orphan recovery: store read failed', {
        sessionId: lane.sessionId, conversationId: lane.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (orphans.length === 0) continue;
    report.orphansFound += orphans.length;

    let tail: string | null;
    try {
      tail = opts.readStreamTail ? await opts.readStreamTail(lane) : await defaultReadStreamTail(lane);
    } catch (err) {
      bump(report.skipped, 'stream-read-failed');
      log.session.debug('lane orphan recovery: stream read failed', {
        sessionId: lane.sessionId, conversationId: lane.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!tail) { bump(report.skipped, 'no-stream'); continue; }

    // Yielding parse: a 4 MB window is ~200 ms of JSON.parse, and this runs on
    // the server's one event loop.
    const slots = await parseLaneStreamTurnsYielding(tail);
    if (slots.length === 0) { bump(report.skipped, 'no-turns-in-window'); continue; }

    for (const orphan of orphans.slice(-MAX_ORPHANS_PER_LANE)) {
      const match = matchOrphanToAnswer(orphan, slots, storeTurns);
      if (!match) { bump(report.skipped, 'no-positional-match'); continue; }
      let outcome: AdoptRecoveredOutcome;
      try {
        outcome = await adoptRecoveredAssistantMessage({
          agentId: lane.agentId,
          conversationId: lane.conversationId,
          turnId: orphan.turnId,
          text: match.answer,
          ...(match.completedAt ? { timestamp: match.completedAt } : {}),
          recoveredFrom: `lane-stream:${lane.sessionId}`,
        });
      } catch (err) {
        bump(report.skipped, 'adopt-failed');
        log.session.warn('lane orphan recovery: adoption failed', {
          sessionId: lane.sessionId, conversationId: lane.conversationId, turnId: orphan.turnId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (outcome !== 'adopted') { bump(report.skipped, outcome); continue; }
      report.adopted++;
      log.session.warn('lane orphan recovery: adopted a stranded answer', {
        sessionId: lane.sessionId, agentId: lane.agentId, conversationId: lane.conversationId,
        turnId: orphan.turnId, slotIndex: match.slotIndex, answerLength: match.answer.length,
        completedAt: match.completedAt,
      });
      // ── Why this is an ADVISORY and not a terminal turn frame ──
      // The obvious move — emit the SSE `message-end` a live lane turn ends with
      // — settles the WRONG turn. `emitSse` hands every frame to
      // mirrorRelayedChatFrame, which RE-STAMPS it with whichever turnId is
      // currently armed for the conversation, so the replica clears its live
      // in-flight turn with this old answer and then DROPS the real terminal
      // frame. iOS is worse: its `message-end` handler ignores turnId entirely —
      // it wipes the streaming text of whatever is running, cancels the
      // watchdog, unlocks the composer, and appends the old answer at the TAIL
      // (recovery inserts mid-list, so even the position would be wrong). Web
      // consumes no `message-end` at all, so there is nothing on that side to
      // win either. Since a recovered turn ended minutes-to-hours ago and every
      // client re-reads the conversation on open, the emit had ~zero value and a
      // real hazard. Advisory only: no handler treats this name as terminal.
      try {
        bus.emit(RECOVERED_TURN_EVENT, {
          agentId: lane.agentId, conversationId: lane.conversationId,
          turnId: orphan.turnId, sessionId: lane.sessionId,
          answerLength: match.answer.length, completedAt: match.completedAt,
        }, ['web-ui'], { source: 'lane-orphan-recovery' });
      } catch (err) {
        log.session.warn('lane orphan recovery: advisory emit failed', {
          turnId: orphan.turnId, error: err instanceof Error ? err.message : String(err),
        });
      }
      if (opts.onAdopted) {
        try {
          await opts.onAdopted({
            ...lane, turnId: orphan.turnId, text: orphan.text, answer: match.answer,
            completedAt: match.completedAt,
          });
        } catch (err) {
          // A hook is a courtesy; the durable write already landed.
          log.session.warn('lane orphan recovery: onAdopted hook threw', {
            turnId: orphan.turnId, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  return report;
}
