/**
 * POST /bridge/host-replica on the cloud companion: the Mac keeps this box's copy
 * of its notes, memory and skills (docs/plan/walnut-companion-unified-replica.md,
 * stage 4; core/companion-host-replica.ts). The commands a host daemon answers for
 * the same copy, with its reply shapes, so the Mac's round (core/host-replica.ts
 * syncHostReplica) runs unchanged over it:
 *
 *   {cmd:'replica.sync', params:{home, kind, entries, asOf, opts?, confirm?, confirmFor?}} -> {ok, need, entries, held, removed}
 *   {cmd:'replica.put',  params:{home, kind, files}}  -> {ok, stored, rejected, remaining}
 *   {cmd:'replica.drop', params:{home, kind}}         -> {ok, dropped}
 *   {cmd:'replica.status'}                            -> {ok, kinds}
 *
 * And the pictures and files of the notes (stage 4d, core/companion-attachment-copy.ts),
 * the copy a host daemon keeps too: `attachments.sync` {entries:[{k,h,n}], asOf} -> {ok, need, ...},
 * `attachments.put` {k, h, offset, data} -> {ok, have, stored}, `attachments.drop`,
 * `attachments.status`.
 *
 * A refusal answers `{ok:false, error, errorKind?}` with 200, as a daemon's error
 * reply reaches the round. Only the Mac's machine credential passes
 * (bridge-ingest.ts authenticate), checked before the body is read.
 */

import express, { Router, type Request, type Response } from 'express'
import { companionHostReplicaCommand, type HostReplicaReply } from '../../core/companion-host-replica.js'
import { companionAttachmentCommand } from '../../core/companion-attachment-copy.js'
import { authenticate, parseErrors } from './bridge-ingest.js'

export const BRIDGE_HOST_REPLICA_PATH = '/bridge/host-replica'
/** A put batch is 512 KB of bodies (a note is at most 1 MB), a picture chunk 2 MB (base64); a manifest of 20,000 notes stays under it. */
const BODY_LIMIT = '8mb'

async function hostReplica(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { cmd?: unknown; params?: unknown }
  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>
  const reply = typeof body.cmd === 'string' && body.cmd.startsWith('attachments.')
    ? await companionAttachmentCommand(body.cmd, params) as HostReplicaReply
    : companionHostReplicaCommand(body.cmd, params)
  if (!reply.ok && reply.errorKind === 'bad_request') {
    res.status(400).json(reply)
    return
  }
  res.json(reply)
}

export function createBridgeHostReplicaRouter(): Router {
  const router = Router()
  router.post(
    '/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: BODY_LIMIT }),
    (req, res, next) => { hostReplica(req, res).catch(next) },
  )
  router.use(parseErrors)
  return router
}
