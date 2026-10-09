/**
 * /api/v1 session stop, the cloud half of POST /sessions/:id/terminate (the
 * route stays in session-lifecycle-v1.ts), and the answer for a stop the host
 * has not confirmed yet. The phone's send path depends on both: the stop is
 * noted before the relay and kept once the primary answered
 * (core/sessions/cloud-stop-fence.ts), so a message held from before it never
 * runs, and a message sent while it is pending is refused (cloud-session-send.ts).
 */

import type { Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { classifyRelayReply, driveControlRelay, sendRelayReplyError, sendV1Error as sendError } from './v1-control-relay.js'

/**
 * The name of the session's host for a sentence: its label, else its alias,
 * "your Mac" for the primary's own sessions. Null when it cannot be told (then
 * the sentence says "the session's host").
 */
export async function sessionHostName(sessionId: string): Promise<string | null> {
  try {
    const { cloudSessionHostName } = await import('../../core/sessions/cloud-session-host.js')
    if (CLOUD_MODE) {
      const { readSessionProjection } = await import('../../core/session-projection.js')
      const row = (await readSessionProjection())?.sessions.find((r) => r.id === sessionId)
      return row ? cloudSessionHostName({ host: row.host === '' ? '__local__' : row.host, hostLabel: row.host_label }) : null
    }
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) return null
    if (!record.host) return cloudSessionHostName({ host: '__local__' })
    const { hostDisplayNameFor } = await import('../../core/hosts/host-display-name.js')
    return hostDisplayNameFor(record.host)
  } catch {
    return null
  }
}

// Existing clients treat every 2xx as stopped, so a pending confirmation must go through the error branch.
export async function sendStopPending(res: Response, sessionId: string): Promise<void> {
  const name = await sessionHostName(sessionId)
  sendError(res, 503, 'stop_pending',
    `Stop request saved, but ${name ?? "the session's host"} has not confirmed it yet. `
    + 'The session may still be running. Retry to check.')
}

/** CLOUD: relay the stop to the primary and answer the phone. */
export async function cloudTerminate(res: Response, sessionId: string, force: boolean): Promise<void> {
  // Noted BEFORE the relay: a phone message this companion holds from
  // before this stop must not run by the host's direct path, though the
  // primary's list may not show the stop for a while (cloud-stop-fence.ts).
  const { noteStopRequested, clearStopNote, noteStopAnswered } = await import('../../core/sessions/cloud-stop-fence.js')
  const stopAskedAt = await noteStopRequested(sessionId)
  const fate: { notSent?: boolean } = {}
  const reply = await driveControlRelay(res, 'terminate', sessionId, { force }, undefined, fate)
  // No stop was recorded when the ask never reached a socket (the Mac off the
  // companion: gate r3, N3), when the primary refused it (cron_owner, not
  // found), or when nobody could take it (no primary behind the daemon, an
  // older primary). Then the ask is closed, and a later send is not held for it.
  // An answer that was LOST keeps the note: the stop may have landed, and a
  // held message running past a stop is the worse mistake. Such an ask holds
  // the session's direct path until a stop recorded since shows up, the next
  // stop is answered, or 24 h pass (the bank's own horizon: cloud-stop-fence.ts).
  if (!reply ? fate.notSent === true : reply.ok !== true && stopProvablyNotRecorded(reply)) {
    await clearStopNote(sessionId, stopAskedAt)
  }
  if (!reply) return
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    const result = reply.result as Record<string, unknown>
    // The stop the primary recorded, kept BEFORE the phone hears the stop
    // finished: the next message is fenced by it, not by the older stop
    // the session list still shows (cloud-stop-fence.ts).
    await noteStopAnswered(sessionId, stopAskedAt, result.stopRequest)
    if (result.status === 'pending') {
      await sendStopPending(res, sessionId)
      return
    }
    res.status(200).json(result)
    return
  }
  sendRelayReplyError(res, reply)
}

/** A failed terminate reply that proves no stop was recorded (never a timeout: the stop may have landed). */
function stopProvablyNotRecorded(reply: Record<string, unknown>): boolean {
  const failure = classifyRelayReply(reply)
  if (failure.kind === 'needs_upgrade') return true
  if (failure.kind === 'bridge_offline') return failure.notSent === true
  return !/timed out|timeout/i.test(failure.message)
}
