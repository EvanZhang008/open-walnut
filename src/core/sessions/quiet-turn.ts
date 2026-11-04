/**
 * A quiet turn: one Walnut runs in a session for the session's own upkeep (today
 * only the idle compaction, sessions/idle-compaction.ts), which is no work of the
 * task's. It moves no phase, runs no turn-end hook (no status question, no
 * notice to a parent, no summary), pushes nothing to a phone and reads as no
 * running turn in the user's status. Its cost is still recorded.
 *
 * In memory, keyed by session, and bound to the one queue row that carries it:
 * begun just before the send, it lasts until the turn's result or error has been
 * seen and every reader had time to ask (`GRACE_MS`). It ends at once when
 * anything else is sent to the session, when a line goes out that is not its row
 * alone (session-message-queue.ts markProcessing), or when a turn starts before
 * its row went out or after its result, so a real turn is never kept quiet. Its
 * end listener (idle-compaction.ts) takes back a row that never went out. A
 * server restart forgets it; the idle compaction begins it again from the
 * session record while the row still waits.
 *
 * Every reader of a session's turn edges asks `isQuietTurn(sessionId)`;
 * tests/core/sessions/quiet-turn-ratchet.test.ts lists them.
 */
import { log } from '../../logging/index.js';

export type QuietTurnKind = 'idle-compact';

interface QuietTurn {
  kind: QuietTurnKind;
  /** The send source that carries it: a SESSION_SEND of any other source ends it. */
  source: string;
  /** The queue row (QueuedMessage.id) that carries it. */
  rowId?: string;
  /** Its row went out alone. */
  delivered?: boolean;
  /** The runner's turn generations it ran under (session runner `_turnGen`, carried by each SESSION_RESULT). */
  gens?: number[];
  begunAt: number;
  /** The turn's result or error was seen; the entry stays for GRACE_MS. */
  endedAt?: number;
  timer: ReturnType<typeof setTimeout>;
}

/** How long after its result a quiet turn still reads as quiet: the result's readers run late. */
export const QUIET_TURN_GRACE_MS = 60_000;
/** A quiet turn whose end never came (a lost process) stops being quiet after this. */
export const QUIET_TURN_MAX_MS = 30 * 60_000;

const turns = new Map<string, QuietTurn>();
/**
 * sessionId → turn generation → until when it is remembered. A result names its turn's generation,
 * so a reader that runs late (after a person already wrote, after the next turn began) still knows
 * whether the result it holds was the quiet one, and a real turn's result never reads as quiet.
 */
const quietGens = new Map<string, Map<number, number>>();
// Remembered while the quiet turn runs, then only for the grace after its end: a runner that
// respawned counts its generations from the start again, so an old number must not linger.
function rememberGen(sessionId: string, gen: number, nowMs: number): void {
  let gens = quietGens.get(sessionId);
  if (!gens) quietGens.set(sessionId, gens = new Map());
  for (const [g, until] of gens) if (until < nowMs) gens.delete(g);
  gens.set(gen, nowMs + QUIET_TURN_MAX_MS);
}

/** The quiet turn is over: its generations are kept only for the grace its late readers need. */
function shortenGens(sessionId: string, nowMs: number): void {
  const gens = quietGens.get(sessionId);
  if (!gens) return;
  for (const [g, until] of gens) gens.set(g, Math.min(until, nowMs + QUIET_TURN_GRACE_MS));
}

export interface QuietTurnEnd { sessionId: string; kind: QuietTurnKind; why: string; rowId?: string; delivered: boolean }
let endListener: ((end: QuietTurnEnd) => void) | null = null;
/** Told whenever a quiet turn ends, whichever way (idle-compaction.ts: takes back an unsent row, stores the end). */
export function onQuietTurnEnd(listener: ((end: QuietTurnEnd) => void) | null): void {
  endListener = listener;
}

function arm(sessionId: string, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => endQuietTurn(sessionId, ms === QUIET_TURN_GRACE_MS ? 'settled' : 'timeout'), ms);
  t.unref?.();
  return t;
}

/** Mark the session's next turn quiet. Called right before Walnut sends `rowId`. */
export function beginQuietTurn(sessionId: string, kind: QuietTurnKind, source: string, nowMs = Date.now(), rowId?: string): void {
  // One quiet turn per session: an earlier one ends first, so its row is taken back.
  if (turns.has(sessionId)) endQuietTurn(sessionId, 'replaced');
  const left = Math.max(1_000, QUIET_TURN_MAX_MS - (Date.now() - nowMs));
  turns.set(sessionId, { kind, source, begunAt: nowMs, ...(rowId ? { rowId } : {}), timer: arm(sessionId, left) });
}

/** Every quiet turn's row id starts so: the queue knows one without asking (session-message-queue.ts markProcessing). */
export const QUIET_ROW_PREFIX = 'qm-quiet-';
export function isQuietRowId(id: string): boolean {
  return id.startsWith(QUIET_ROW_PREFIX);
}

/** The row of the session's quiet turn, while one runs. */
export function quietTurnRow(sessionId: string): string | undefined {
  return turns.get(sessionId)?.rowId;
}

/**
 * A line is going out to the session with these rows. Only the quiet turn's own row, alone, is the
 * quiet turn; any other line is a real turn and ends it.
 */
export function noteQuietTurnDelivery(sessionId: string, rowIds: readonly string[]): void {
  const t = turns.get(sessionId);
  if (!t?.rowId) return;
  if (rowIds.length === 1 && rowIds[0] === t.rowId) { t.delivered = true; return; }
  endQuietTurn(sessionId, 'other-line');
}

/**
 * Whether the session's current (or just ended) turn is a quiet one. A reader of a result passes the
 * result's `turnGen`: the answer is then about that turn, however late the reader runs.
 */
export function isQuietTurn(sessionId: string | undefined | null, turnGen?: unknown): boolean {
  if (!sessionId) return false;
  const t = turns.get(sessionId);
  if (typeof turnGen === 'number') {
    const until = quietGens.get(sessionId)?.get(turnGen);
    if (until !== undefined && until >= Date.now()) return true;
    // A quiet turn whose start the runner never reported (no generation seen): the live answer.
    return !!t && !t.gens?.length;
  }
  return !!t;
}

/** The kind of the session's quiet turn, if one runs. */
export function quietTurnKind(sessionId: string | undefined | null): QuietTurnKind | undefined {
  return sessionId ? turns.get(sessionId)?.kind : undefined;
}

/** The quiet turn's result or error came: it stays quiet for the readers still to run, then ends. */
export function noteQuietTurnSettled(sessionId: string | undefined): void {
  const t = sessionId ? turns.get(sessionId) : undefined;
  if (!t || t.endedAt) return;
  clearTimeout(t.timer);
  t.endedAt = Date.now();
  shortenGens(sessionId!, t.endedAt);
  t.timer = arm(sessionId!, QUIET_TURN_GRACE_MS);
}

/** A send reached the session: one of another source is a real turn, and ends the quiet one. */
export function noteSessionSend(sessionId: string | undefined, source: string | undefined): void {
  const t = sessionId ? turns.get(sessionId) : undefined;
  if (t && source !== t.source) endQuietTurn(sessionId!, 'other-send');
}

/**
 * A turn started: once the quiet turn has settled, this one is another turn and is not quiet; before
 * its row went out, it is a turn the CLI began by itself (a wakeup, a cron fire).
 */
export function noteTurnStart(sessionId: string | undefined, turnGen?: number): void {
  const t = sessionId ? turns.get(sessionId) : undefined;
  if (!t) return;
  if (t.endedAt) endQuietTurn(sessionId!, 'next-turn');
  else if (t.rowId && !t.delivered) endQuietTurn(sessionId!, 'turn-before-delivery');
  else if (turnGen !== undefined) {
    (t.gens ??= []).push(turnGen);
    rememberGen(sessionId!, turnGen, Date.now());
  }
}

export function endQuietTurn(sessionId: string, why: string): void {
  const t = turns.get(sessionId);
  if (!t) return;
  clearTimeout(t.timer);
  turns.delete(sessionId);
  shortenGens(sessionId, Date.now());
  log.session.debug('quiet turn ended', { sessionId, kind: t.kind, why, ms: Date.now() - t.begunAt });
  try {
    endListener?.({ sessionId, kind: t.kind, why, ...(t.rowId ? { rowId: t.rowId } : {}), delivered: !!t.delivered });
  } catch (err) {
    log.session.warn('quiet turn end listener failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tests only. */
export function resetQuietTurnsForTest(): void {
  for (const t of turns.values()) clearTimeout(t.timer);
  turns.clear();
  quietGens.clear();
}
