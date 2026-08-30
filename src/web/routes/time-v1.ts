/**
 * /api/v1 time tracking (additive, frozen contract) — the phone banks human time
 * into the SAME store the web console feeds.
 *
 *   POST /api/v1/time/heartbeats  { samples: [{ id?, ts, durationMs, kind,
 *                                   taskId?, sessionId?, source? }] } → 204
 *
 * Auth is inherited from the global /api authMiddleware (device Bearer tokens in
 * cloud mode, LAN bypass otherwise), exactly like the rest of the v1 family —
 * this router mounts inside apiV1Router and implements no auth of its own.
 *
 * ── Why this is NOT a 501 on a cloud REPLICA ─────────────────────────────────
 *
 * The internal /api/time family answers 501 on a replica because the store, the
 * rollup, and the collectors all live on the primary. But the phone mostly talks
 * to the REPLICA, so a 501 here would mean the phone's time is simply never
 * banked. Instead the batch is relayed to the primary over the established
 * `session.control` lane (`server.time.heartbeats`), which is also what keeps the
 * day keys right: a record's day is the LOCAL day of its `ts` on whichever box
 * sanitizes it, and only the primary runs in the user's own timezone.
 *
 * ── 204 means PERSISTED, 503 means "ask me again" ────────────────────────────
 *
 * The client queues and retries, so the two answers have to be honest:
 *   204  the samples reached the primary's day file (or the batch carried nothing
 *        usable — telemetry never errors for junk, and retrying junk helps nobody,
 *        so a dropped-as-invalid sample is deliberately indistinguishable from a
 *        banked one).
 *   503  `{ error: { code: 'primary_unreachable', message } }` — nothing was
 *        persisted; the caller keeps its samples and retries. ONE code for the two
 *        causes on purpose, because they mean the same thing to a client: the
 *        primary could not be reached (bridge down, its server down, or a primary
 *        that predates the action and self-heals on its next deploy), or the
 *        primary was reached but its disk write did not land in time. A 4xx would
 *        make the phone throw the data away, so no failure here is ever a 4xx.
 *
 * Retrying is only safe because the ingest ledger dedupes on each sample's `id`:
 * a resent batch is skipped rather than banked twice (core/time-tracking/ingest.ts).
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bankHeartbeatSamples, narrowRelaySamples } from '../../core/time-tracking/index.js'

export const timeV1Router = Router()

/** Box-level relay actions carry no real session id (same as routines/files). */
const SERVER_RELAY_SID = '__server__'

/**
 * Relay budget. Short on purpose: banking a batch is a fold plus an append, so a
 * primary that has not answered in this long is not going to; the client's next
 * flush carries the same samples. Nothing may pin a connection waiting on it.
 */
const RELAY_TIMEOUT_MS = 10_000

/**
 * Absent `source` on THIS endpoint means the iOS app. The v1 surface is the
 * mobile contract, and a phone that forgot the field would otherwise have its
 * time counted as browser time — silently wrong data is worse than a default.
 * An explicit `source` in the sample always wins.
 */
const V1_DEFAULT_SOURCE = 'ios' as const

// POST /api/v1/time/heartbeats
timeV1Router.post('/time/heartbeats', async (req: Request, res: Response) => {
  const samples = (req.body ?? {}).samples
  try {
    if (CLOUD_MODE) {
      await relayHeartbeats(samples, res)
      return
    }
    const outcome = await bankHeartbeatSamples(samples, { defaultSource: V1_DEFAULT_SOURCE })
    if (!outcome.durable) {
      // The rollup may already hold these samples, but the day file does not —
      // and 204 promises the day file. The client retries; the ledger keeps the
      // retry from folding anything twice.
      log.web.warn('v1 time heartbeats not durable yet — asking the client to retry', {
        banked: outcome.banked, deduped: outcome.deduped,
      })
      sendUnreachable(res, 'The primary could not persist the batch in time: keep it queued and retry')
      return
    }
    log.web.debug('v1 time heartbeats banked locally', {
      banked: outcome.banked, deduped: outcome.deduped, totalMs: outcome.totalMs,
    })
    res.status(204).end()
  } catch (err) {
    // Deliberately NOT the usual "telemetry answers 204 anyway": on this endpoint
    // 204 promises the samples are persisted, and the client throws them away on
    // it. An unexpected failure has to read as retry-later instead.
    log.web.warn('v1 time heartbeats failed unexpectedly', {
      error: err instanceof Error ? err.message : String(err),
    })
    if (res.headersSent) { res.end(); return }
    sendUnreachable(res)
  }
})

/** The one 503 this endpoint ever produces, in the frozen v1 error envelope. */
function sendUnreachable(
  res: Response,
  message = 'Time samples could not be banked on the primary box: keep them queued and retry',
): void {
  res.status(503).json({ error: { code: 'primary_unreachable', message } })
}

/**
 * REPLICA: forward the batch to the primary and translate its answer. The samples
 * are narrowed (count + field shape) first, because one oversized bridge frame
 * closes the socket every in-flight RPC shares.
 */
async function relayHeartbeats(samples: unknown, res: Response): Promise<void> {
  const narrowed = narrowRelaySamples(samples, V1_DEFAULT_SOURCE)
  if (narrowed.length === 0) {
    // Nothing to bank: answering 204 without spending a bridge RPC is both
    // cheaper and correct — a 503 would make the client retry an empty batch.
    res.status(204).end()
    return
  }
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(
    'server.time.heartbeats',
    SERVER_RELAY_SID,
    { samples: narrowed },
    RELAY_TIMEOUT_MS,
  )
  if (outcome.ok) {
    // `durable: false` = the primary folded but could not persist. Report it as
    // "not banked" so the phone retries; its dedupe ids make that a no-op for
    // anything that did land. A primary that predates the field answers without
    // it, and an old primary's silence must not be read as a failure.
    if (outcome.result.durable === false) {
      log.web.warn('v1 time heartbeats: the primary could not persist the batch', {
        samples: narrowed.length, banked: outcome.result.banked,
      })
      sendUnreachable(res, 'The primary could not persist the batch in time: keep it queued and retry')
      return
    }
    log.web.debug('v1 time heartbeats relayed to the primary', {
      samples: narrowed.length, banked: outcome.result.banked, deduped: outcome.result.deduped,
    })
    res.status(204).end()
    return
  }
  log.web.info('v1 time heartbeats could not reach the primary — client will retry', {
    samples: narrowed.length, failureKind: outcome.failure.kind, reason: outcome.failure.message,
  })
  sendUnreachable(res)
}
