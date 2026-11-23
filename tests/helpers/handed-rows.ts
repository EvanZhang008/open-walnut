/**
 * For tests of the leader's apply of a host's channel records that are not about who owns a
 * session: each session a batch's rows name (and each rename's new id) is handed to its host first
 * (src/core/session-channel/handed-sessions.ts handStart), as the leader's start hands it before
 * its born row comes; a patch of a handed session with no row here is asked for whole. Tests of the ownership rule itself call applyHostChannelBatch directly.
 */
import { applyHostChannelBatch, type HostChannelBatch } from '../../src/core/session-tracker.js'
import { handStart } from '../../src/core/session-channel/handed-sessions.js'

export async function applyHanded(batch: HostChannelBatch): ReturnType<typeof applyHostChannelBatch> {
  for (const r of batch.rows) await handStart(batch.hostId, r.sid, { taskId: typeof r.patch.taskId === 'string' ? r.patch.taskId : '' })
  for (const r of batch.renames) await handStart(batch.hostId, r.to)
  return applyHostChannelBatch(batch)
}
