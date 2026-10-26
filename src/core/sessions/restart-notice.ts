/**
 * Restart notice: the first message into a session after a restart killed its
 * process carries the facts of that restart (what cut it off, that /tmp was
 * cleared, whether its working directory survived), in the same queue row, so
 * it costs no turn of its own.
 *
 * It rides on WHICHEVER message reaches the session first: the auto-recover
 * resume, a human typing, a peer task, a trigger. A human who resumes the
 * session before the recovery queue gets to it must not take the facts away
 * from the agent. Told once per loss (`restartLoss.told`). Best effort: nothing
 * here ever fails a send.
 */

import { log } from '../../logging/index.js'
import { createEnvelopeKit } from '../peers/envelope-kit.js'
import { buildRestartNotice } from './restart-loss.js'

const kit = createEnvelopeKit()

export interface PendingRestartNotice {
  text: string
  markTold: () => Promise<void>
}

/** A notice claimed by a send not yet written stays claimed this long. */
const CLAIM_MS = 60_000
const claims = new Map<string, { at: string; ms: number }>()

export async function pendingRestartNotice(sessionId: string): Promise<PendingRestartNotice | null> {
  try {
    // The leader owns the records; a replica's copy may lag and is not its to mark.
    const { role } = await import('../server-role.js')
    if (role() !== 'leader') return null
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    const loss = record?.restartLoss
    // Unclassified ('pending') has no facts yet; the next message carries it.
    if (!record || !loss || loss.told || loss.state === 'pending') return null
    const claim = claims.get(sessionId)
    if (claim && claim.at === loss.at && Date.now() - claim.ms < CLAIM_MS) return null
    claims.set(sessionId, { at: loss.at, ms: Date.now() })
    const text = kit.buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut', outcome: 'restarted', note: 'automated Walnut status notice' },
      body: buildRestartNotice(loss, { host: record.host_label ?? record.host }),
    })
    return {
      text,
      markTold: async () => {
        const { updateSessionRecordConditionally } = await import('../session-tracker.js')
        await updateSessionRecordConditionally(
          sessionId,
          { restartLoss: { ...loss, told: true } } as Record<string, unknown>,
          (current) => current.restartLoss?.at === loss.at && JSON.stringify(current.restartLoss) === JSON.stringify(loss),
          { preserveLastActiveAt: true },
        ).then(async (written) => {
          // The loss moved on (queued → sent) between read and write: set only the flag.
          if (written) return
          const cur = await getSessionByClaudeId(sessionId)
          if (cur?.restartLoss?.at !== loss.at || cur.restartLoss.told) return
          await updateSessionRecordConditionally(
            sessionId,
            { restartLoss: { ...cur.restartLoss, told: true } } as Record<string, unknown>,
            (current) => JSON.stringify(current.restartLoss) === JSON.stringify(cur.restartLoss),
            { preserveLastActiveAt: true },
          )
        })
        if (claims.get(sessionId)?.at === loss.at) claims.delete(sessionId)
        log.session.info('restart notice queued', { sessionId, cause: loss.cause, lost: loss.lost })
      },
    }
  } catch (err) {
    log.session.warn('restart notice skipped', { sessionId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
