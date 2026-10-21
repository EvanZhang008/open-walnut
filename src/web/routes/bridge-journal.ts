/**
 * POST /bridge/journal on the cloud companion: the Mac drains the writes the
 * companion took while it was away (docs/plan/walnut-companion-unified-replica.md,
 * stage 3; core/companion-journal.ts). The same three commands a host daemon
 * answers, with its reply shapes, so the Mac's handover (core/offline-handover.ts)
 * runs unchanged over it:
 *
 *   {cmd:'offline.drain', params:{home, kinds}}  -> {ok, records, more, now}
 *   {cmd:'offline.ack',   params:{home, seqs}}   -> {ok, remaining, ignored?}
 *   {cmd:'offline.blob',  params:{sha, offset}}  -> {ok, sha, offset, size, data, done}
 *
 * `home` is the Mac's data dir; the companion has one Mac and one journal, so it
 * is not used to pick one. A refusal answers `{ok:false, error, code, why?}` with
 * 200, as a daemon's error reply reaches the handover (`code` is what the Mac's
 * blob reader reads). Only the Mac's machine credential passes (bridge-ingest.ts
 * authenticate), checked before the body is read.
 */

import express, { Router, type Request, type Response } from 'express'
import * as j from '../../core/companion-journal.js'
import { authenticate, parseErrors } from './bridge-ingest.js'

export const BRIDGE_JOURNAL_PATH = '/bridge/journal'
const BODY_LIMIT = '256kb'

async function journal(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { cmd?: unknown; params?: unknown }
  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>
  switch (body.cmd) {
    case 'offline.drain': {
      const kinds = Array.isArray(params.kinds) ? params.kinds.filter((k): k is string => typeof k === 'string') : null
      const out = await j.drainCompanionJournal(kinds)
      res.json(out.ok ? out : { ok: false, error: `offline.drain: ${out.error}`, code: 'journal_unwritable', ...(out.why ? { why: out.why } : {}) })
      return
    }
    case 'offline.ack': {
      if (!Array.isArray(params.seqs)) {
        res.status(400).json({ ok: false, error: 'offline.ack: missing seqs', code: 'bad_request' })
        return
      }
      const r = j.ackCompanionJournal(params.seqs)
      res.json(r.ok ? r : { ok: false, error: `offline.ack: ${r.error}`, code: 'journal_unwritable' })
      return
    }
    case 'offline.blob': {
      const r = j.readCompanionJournalBlob(params.sha, params.offset)
      res.json(r.ok ? r : { ok: false, error: `offline.blob: ${r.message}`, code: r.code })
      return
    }
    default:
      res.status(400).json({ ok: false, error: 'unknown command', code: 'bad_request' })
  }
}

export function createBridgeJournalRouter(): Router {
  const router = Router()
  router.post(
    '/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: BODY_LIMIT }),
    (req, res, next) => { void journal(req, res).catch(next) },
  )
  router.use(parseErrors)
  return router
}
