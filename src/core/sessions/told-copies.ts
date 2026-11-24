/**
 * What a session was told, when two servers tell it.
 *
 * A host's row is written by its host (session-row-owner.ts), and the told records of the notices
 * that ride its lines are host fields: `taskRoutingNoted` (instruction-notice.ts), `placeNoted`
 * (place-notice.ts), `outputModeHookAt` (hints/hint-send.ts) and `workspaceTold`
 * (workspaces/remake.ts). But the leader tells such a
 * session too: its queue, its compaction hook and its place notices. Its writes of those fields
 * were left out of the row (2026-11-24: 37 place records, 22 instruction records and 19 output mode
 * hook times in a day, and 18 workspace notices), so it told the same thing again at every line: one session got the same
 * folder move five times in 33 minutes, and the same rule change at 04:01, 07:18 and 13:00.
 *
 * So the leader keeps its own copy of each in a leader field (LEADER_TOLD_COPY), and a reader takes
 * what either copy says counts. The copy is written by renaming the field in the leader's write of a
 * host's row (session-tracker.ts applyUpdateToSession), so no writer needs to know whose row it is.
 * Every told record that rides a line has a copy here (tests/core/sessions/told-copies.test.ts).
 */
import type { SessionInstructionsNoted, SessionPlaceNoted, SessionRecord } from '../types.js'
import { HOOK_BOUNDARY_MS, answersBoundary, hintStateAtBoundary } from './hook-statement.js'

/** Each told record a host owns on its row, and the leader field the leader keeps its own copy in. */
export const LEADER_TOLD_COPY = {
  taskRoutingNoted: 'taskRoutingNotedByLeader',
  placeNoted: 'placeNotedByLeader',
  outputModeHookAt: 'outputModeHookAtByLeader',
  workspaceTold: 'workspaceToldByLeader',
} as const satisfies Partial<Record<keyof SessionRecord, keyof SessionRecord>>

export type ToldField = keyof typeof LEADER_TOLD_COPY

/** A write's told fields moved to the leader's copies (every other field as it was). */
export function toldIntoLeaderCopies<P extends Record<string, unknown>>(patch: P): P {
  let out: Record<string, unknown> | null = null
  for (const [field, copy] of Object.entries(LEADER_TOLD_COPY)) {
    if (!(field in patch)) continue
    out ??= { ...patch }
    out[copy] = out[field]
    delete out[field]
  }
  return (out ?? patch) as P
}

/**
 * The leader's copies count only while a host judges the row: once it is the leader's own again
 * (session-tracker.ts takeSeedBack) the leader writes the row's own fields, and a copy from before
 * would stand for what it no longer holds.
 */
const copiesCount = (row: { judge?: SessionRecord['judge'] }) => row.judge === 'host'

type InstructionCopies = Partial<Pick<SessionRecord, 'taskRoutingNoted' | 'taskRoutingNotedByLeader' | 'judge'>>
type PlaceCopies = Partial<Pick<SessionRecord, 'placeNoted' | 'placeNotedByLeader' | 'judge'>>

/** The instruction records of a row: its own, then the leader's copy. */
export function instructionsToldCopies(row: InstructionCopies): SessionInstructionsNoted[] {
  return [row.taskRoutingNoted, copiesCount(row) ? row.taskRoutingNotedByLeader : undefined].filter((n): n is SessionInstructionsNoted => !!n)
}

/** The place records of a row, the leader's copy first: the leader is the one that tells a place (place-notice.ts). */
export function placeToldCopies(row: PlaceCopies): SessionPlaceNoted[] {
  return [copiesCount(row) ? row.placeNotedByLeader : undefined, row.placeNoted].filter((n): n is SessionPlaceNoted => !!n)
}

/** When a compaction hook last restated the output mode on this row, by either server. */
export function outputModeHookAtOf(row: Partial<Pick<SessionRecord, 'outputModeHookAt' | 'outputModeHookAtByLeader' | 'judge'>>): string | undefined {
  const times = [row.outputModeHookAt, copiesCount(row) ? row.outputModeHookAtByLeader : undefined].filter((t): t is string => !!t)
  return times.sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0]
}

/** Whether the session was told the workspace notice under `key`, by either server (workspaces/remake.ts). */
export function workspaceToldOf(row: Partial<Pick<SessionRecord, 'workspaceTold' | 'workspaceToldByLeader' | 'judge'>>, key: string): boolean {
  return row.workspaceTold === key || (copiesCount(row) && row.workspaceToldByLeader === key)
}

/**
 * The leader's own told state of a host's row once the host read a new compaction boundary (its
 * row change moved `lastCompactUuid`), applied to `next` where the leader writes that change
 * (session-tracker.ts applyHostChannelBatch). The host does this for a row it runs (place-notice.ts
 * notePlaceCompaction), but its writes of leader fields were left out, and it never sees the
 * leader's copies (2026-11-24: 24 rich-output resets and 3 hint states in a day): the summary
 * dropped the rich-output instruction and it was never sent again. As there:
 * - the output mode is "never told" again unless the compaction hook restated it for this boundary;
 * - a hint, the changed instructions or the place the hook stated for this boundary (made after the
 *   boundary before it, and close to this one) are carried onto it, so they are not told again.
 */
export function leaderToldAtBoundary(before: SessionRecord, next: SessionRecord, now = Date.now()): void {
  const boundary = next.lastCompactUuid
  if (!boundary || boundary === before.lastCompactUuid) return
  // An older boundary replayed after a newer one: nothing of it applies any more.
  if (before.lastCompactAt && next.lastCompactAt && Date.parse(next.lastCompactAt) <= Date.parse(before.lastCompactAt)) return
  // Measured from when the host read the boundary: its change may reach the leader much later (a replay).
  const readAt = Date.parse(next.lastCompactAt ?? '') || now
  // Close to that read either side (a hook may run just before or after it), and after the boundary before.
  const answered = (at: number) => answersBoundary(at, before.lastCompactAt, readAt) && Math.abs(readAt - at) < HOOK_BOUNDARY_MS
  const modeHookAt = outputModeHookAtOf(before)
  if (!answered(modeHookAt ? Date.parse(modeHookAt) : NaN)) delete (next as Partial<SessionRecord>).output_mode_injected
  const hintState = hintStateAtBoundary(before.hintState, boundary, answered)
  if (hintState) next.hintState = hintState
  for (const field of ['taskRoutingNotedByLeader', 'placeNotedByLeader'] as const) {
    const stated = before[field]
    if (!stated?.byHookAt || !answered(Date.parse(stated.byHookAt))) continue
    const { prior: _prior, ...rest } = stated
    ;(next as unknown as Record<string, unknown>)[field] = { ...rest, compactUuid: boundary }
  }
}
