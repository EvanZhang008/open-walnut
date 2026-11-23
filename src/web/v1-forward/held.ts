/**
 * The calls the companion keeps behind what it still holds for the Mac (proxy.ts heldFor,
 * policy.ts HELD_FOR_MAC): their type, why each answers here, and the companion's own check.
 */
import { heldKindsOf } from './policy.js'

/** A call of a held family (policy.ts HeldFamily); a session patch names its session. */
export type HeldCall = { family: 'task-writes' } | { family: 'inbox' } | { family: 'session-patch'; sessionId: string }

/** Why a call of a held family answers here (status().answeredHere). */
export const HELD_WHY: Record<HeldCall['family'], string> = { 'task-writes': 'queue-first', inbox: 'inbox-held', 'session-patch': 'session-held' }

/**
 * Whether the companion holds changes of the call's family for the Mac (ForwardDeps.heldFor): a
 * record of one of the family's kinds in its journal (policy.ts HELD_FOR_MAC; for a session patch,
 * one of that session), else the family's own queue (task ops queued or on their way, inbox flags
 * queued for an older Mac, a session's queued patches). A record of a kind the Mac no longer
 * drains (it went back to an older release) waits for nothing the Mac will do: it keeps no call.
 */
export async function companionHeldFor(call: HeldCall): Promise<boolean> {
  const { companionJournalRecords, macDrains } = await import('../../core/companion-journal.js')
  const kinds = heldKindsOf(call.family)
  const journaled = companionJournalRecords().filter((r) => kinds.has(r.kind) && macDrains(r.kind))
  if (call.family === 'session-patch') {
    return journaled.some((r) => r.sid === call.sessionId) || (await import('../../core/control-queue.js')).sessionPatchHeld(call.sessionId)
  }
  if (journaled.length > 0) return true
  if (call.family === 'inbox') return (await import('../../core/human-inbox/replica-state.js')).inboxFlagsQueued()
  const q = await import('../../core/task-queue.js')
  return q.liveTaskOpsInFlight() > 0 || (await q.queuedTaskOpCount()) > 0
}
