import { createHash } from 'node:crypto';

/**
 * pickBatchUuid — which pre-assigned user-message uuid a DRAINED BATCH carries.
 *
 * A drain joins every pending row into ONE stream-json user message, so the CLI
 * writes ONE user line and only one uuid can survive. The harness already
 * decided which one: its own enqueue path takes `batch.findLast(c => c.uuid)`,
 * i.e. the LAST uuid in the batch wins. We port that rule verbatim rather than
 * inventing a Walnut-side convention (first-wins, or refusing to batch), because
 * the CLI owns the transcript and any disagreement here shows up as an anchor
 * pointing at a line that doesn't exist.
 *
 * Rows without a uuid are skipped, so a batch that mixes pre-assigned and plain
 * sends still delivers the newest pre-assigned uuid. No rows carry one ⇒
 * `undefined`, and callers must then omit the `uuid` key entirely so the payload
 * is byte-identical to the pre-feature envelope.
 */
export function pickBatchUuid(rows: ReadonlyArray<{ userUuid?: string }>): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const uuid = rows[i]?.userUuid;
    if (uuid) return uuid;
  }
  return undefined;
}

/**
 * The uuid a drained batch's user line goes out under: the pre-assigned one
 * when a row carries it (pickBatchUuid), else one derived from the batch's row
 * ids. Derived, not random, so every attempt at the SAME batch carries the same
 * uuid (the CLI skips a uuid its transcript already holds, and names it in its
 * command_lifecycle events), while a batch of different rows never shares one.
 * Only the wire uses it: the turn's question link stays pickBatchUuid's.
 */
export function lineUuidFor(rows: ReadonlyArray<{ id: string; userUuid?: string }>): string {
  const picked = pickBatchUuid(rows);
  if (picked) return picked;
  const h = createHash('sha256').update(`walnut-line:${rows.map((r) => r.id).join(',')}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * splitBatchAtUuid: the part of a pending run that may go out as ONE turn.
 *
 * A pre-assigned uuid is a question's head row (a thread anchor is keyed by it),
 * so it must become its own transcript line and its own turn: batched with other
 * rows, only one uuid would survive (pickBatchUuid) and the other question's
 * anchor would point at nothing; batched with a plain row, the head line would
 * carry someone else's text and the answer would cover both. So a uuid row at the
 * head goes alone, and a plain run stops before the first uuid row. Rows without
 * a uuid anywhere: the whole run, exactly today's batching.
 */
export function splitBatchAtUuid<T extends { userUuid?: string }>(rows: readonly T[]): T[] {
  if (rows.length === 0) return [];
  if (rows[0]?.userUuid) return [rows[0]];
  const firstUuid = rows.findIndex((r) => !!r.userUuid);
  return firstUuid < 0 ? [...rows] : rows.slice(0, firstUuid);
}

/**
 * The uuid of the user line the CURRENT turn answers, per session: set when a
 * batch is delivered (undefined for a plain batch), read at `session:result` by
 * the thread titler to prove a result belongs to a question. With the split
 * rule above a turn carries at most one uuid, so this is exact, never a guess.
 */
const turnUuids = new Map<string, string | undefined>();

export function noteTurnUserUuid(sessionId: string, uuid: string | undefined): void {
  if (uuid) turnUuids.set(sessionId, uuid);
  else turnUuids.delete(sessionId);
}

export function turnUserUuid(sessionId: string): string | undefined {
  return turnUuids.get(sessionId);
}

/**
 * Which queue rows each recent line carries, per session: noted where the queue
 * gives a batch its line uuid (markProcessing), on every path the line then goes
 * out (a live write, a write behind a running turn, the first line of a cold
 * --resume). The take marker (`session:user-line`) names these rows, and the chat
 * places a sent message by them (web/src/stream/chat-order.ts): a bubble knows
 * its row id, never the line's uuid. 2026-10-31: a cold resume's first line was
 * registered nowhere the marker read, so its message sat below the whole answer.
 * In memory: a line an earlier server process sent is named once this one sends
 * it again (its rows keep their uuid across a restart, QueuedMessage.lineUuid).
 */
const carried = new Map<string, Map<string, string[]>>();
/** Bounds: a line's marker comes within its turn; old lines must not pin memory. */
const MAX_CARRIED_LINES = 64;
const MAX_CARRIED_SESSIONS = 256;

export function noteLineCarries(sessionId: string, uuid: string | undefined, rowIds: readonly string[]): void {
  if (!sessionId || !uuid || rowIds.length === 0) return;
  let lines = carried.get(sessionId);
  if (lines) carried.delete(sessionId);
  else lines = new Map();
  carried.set(sessionId, lines);
  if (carried.size > MAX_CARRIED_SESSIONS) carried.delete(carried.keys().next().value!);
  lines.delete(uuid);
  lines.set(uuid, [...rowIds]);
  if (lines.size > MAX_CARRIED_LINES) lines.delete(lines.keys().next().value!);
}

/** The rows a line carries (empty when this server never sent it). */
export function rowsCarriedBy(sessionId: string | null | undefined, uuid: string): readonly string[] {
  return (sessionId ? carried.get(sessionId)?.get(uuid) : undefined) ?? [];
}

export function resetLineCarriesForTesting(): void {
  carried.clear();
}
