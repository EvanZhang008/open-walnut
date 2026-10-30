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
