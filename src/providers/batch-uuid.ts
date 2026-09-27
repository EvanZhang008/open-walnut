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
