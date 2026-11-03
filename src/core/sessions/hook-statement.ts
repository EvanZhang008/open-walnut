/**
 * What the post-compaction hook (open-items.ts, `open_items hook:"compact"`) records as told
 * counts only for a compaction of the session's own conversation.
 *
 * The hook restates the changed default instructions (instruction-notice.ts), the task's place
 * (place-notice.ts) and the message hints (hints/hint-send.ts), and each is recorded as told for
 * the boundary the hook answers. The server reads that boundary from the stream a few seconds
 * later and carries the statement onto it (place-notice.ts notePlaceCompaction). But the CLI also
 * runs the hook when a FORK of the conversation compacts: a side question (the turn-end report)
 * or a subagent, with the same session id and the same hook input. That compaction writes no
 * boundary to the session's own stream, so its statement stayed on the old boundary and counted
 * as told to a conversation that never read it (2026-10-30: a lead's turn-end report compacted,
 * and every changed rule, a new one included, was marked told to the lead's main session, which
 * never received them).
 *
 * The rule: a hook statement counts only when the server read a boundary within
 * HOOK_BOUNDARY_MS of it, either side (the boundary is read after the hook almost always, before
 * it in a race). One no boundary came near is void: the next message tells those lines again.
 */

/** A hook statement and the boundary it answers are read this close together. */
export const HOOK_BOUNDARY_MS = 5 * 60_000

/** True when `byHookAt` is a hook statement no compaction boundary of this session came near. */
export function hookStatementVoid(byHookAt: string | undefined, record: { lastCompactAt?: string }): boolean {
  if (!byHookAt) return false
  const at = Date.parse(byHookAt)
  if (!Number.isFinite(at)) return false
  const read = record.lastCompactAt ? Date.parse(record.lastCompactAt) : NaN
  return !(Number.isFinite(read) && Math.abs(read - at) < HOOK_BOUNDARY_MS)
}

/**
 * The told record that counts for the session's own conversation. A hook statement replaces what
 * was told before it and keeps that as `prior`: when the statement turns out to be a fork's (void),
 * the conversation still holds the prior one, so only what came after it is told again, never
 * everything (2026-11-03: a side question compacted 15 minutes after a real compaction, and the
 * next message re-sent all 10.8 KB of changed instructions and the place note).
 */
export function heldStatement<T extends { byHookAt?: string; prior?: Omit<T, 'prior'> }>(
  noted: T | undefined, record: { lastCompactAt?: string },
): Omit<T, 'prior'> | undefined {
  if (!noted) return undefined
  if (hookStatementVoid(noted.byHookAt, record)) return noted.prior
  const { prior: _prior, ...rest } = noted
  return rest
}

/**
 * The boundary a hook statement answers, read under the record's lock. The hook's caller read the
 * record when its request came in; the server may have read the new boundary since (the race the
 * notes above name), and a statement on the old boundary then counted for none (2026-11-03).
 */
export function statementBoundary(current: { lastCompactUuid?: string }): { compactUuid?: string } {
  return current.lastCompactUuid ? { compactUuid: current.lastCompactUuid } : {}
}
