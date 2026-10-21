import express, { Router, type Request, type Response } from 'express'
import { authenticate, parseErrors } from './bridge-ingest.js'
import { bridgeHasCapability, bridgeRequest, bridgeRequestPrepared, BridgeOfflineError } from '../ws/bridge-registry.js'
import { decodeCloudSessionSend, InvalidCloudSessionPayloadError } from '../../lib/cloud-session-payload.js'
import { log } from '../../logging/index.js'

export const BRIDGE_SEND_PATH = '/bridge/send'
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HOST = /^[A-Za-z0-9_.-]{1,128}$/
async function send(req: Request, res: Response): Promise<void> {
  const deadline = Date.now() + 22_000
  let decoded
  try {
    decoded = await decodeCloudSessionSend(req.body, { timeoutMs: Math.min(10_000, deadline - Date.now()) })
  } catch (err) {
    res.status(err instanceof InvalidCloudSessionPayloadError ? 400 : 503).json({
      error: err instanceof InvalidCloudSessionPayloadError ? 'invalid_payload' : 'payload_unavailable', sent: false,
    })
    return
  }
  if (res.destroyed || res.writableEnded) return
  const { host, sessionId, uuid, lostPid, paramsJson } = decoded
  if (!bridgeHasCapability(host, 'send-dedupe-v1') || (lostPid !== undefined && !bridgeHasCapability(host, 'send-lost-line-v1'))) {
    res.status(409).json({ error: 'host_unavailable', sent: false })
    return
  }
  try {
    const target = await (await import('../../core/sessions/cloud-session-host.js')).resolveCloudSessionHost(sessionId)
    if (!target || target.host !== host) {
      res.status(409).json({ error: 'host_mismatch', sent: false })
      return
    }
    const { stopAskUnconfirmed } = await import('../../core/sessions/cloud-stop-fence.js')
    if (await stopAskUnconfirmed(sessionId, target.stopRequest)) {
      res.status(409).json({ error: 'stop_pending', sent: false })
      return
    }
  } catch {
    res.status(503).json({ error: 'host_unknown', sent: false })
    return
  }
  const remainingMs = Math.min(20_000, deadline - Date.now())
  if (remainingMs <= 0) {
    res.status(503).json({ error: 'host_unknown', sent: false })
    return
  }
  try {
    if (res.destroyed || res.writableEnded) return
    const reply = await bridgeRequestPrepared(host, 'send', paramsJson, remainingMs)
    log.web.info('primary session send via companion', { host, sessionId, uuid, ok: reply.ok === true })
    res.json(reply)
  } catch (err) {
    const sent = !(err instanceof BridgeOfflineError)
    res.status(503).json({ error: sent ? 'delivery_unconfirmed' : 'host_unavailable', sent })
  }
}

async function permission(req: Request, res: Response): Promise<void> {
  const deadline = Date.now() + 22_000
  const { host, sessionId, requestId, allow, message, answers } = req.body ?? {}
  if (typeof host !== 'string' || !HOST.test(host) || host === '__local__' || host === '__cloudbox__'
    || typeof sessionId !== 'string' || !ID.test(sessionId)
    || typeof requestId !== 'string' || !requestId || requestId.length > 256
    || typeof allow !== 'boolean' || (message !== undefined && typeof message !== 'string')
    || (answers !== undefined && (typeof answers !== 'object' || answers === null || Array.isArray(answers)
      || Object.values(answers).some((value) => typeof value !== 'string')))) {
    res.status(400).json({ error: 'invalid_payload', sent: false })
    return
  }
  if (!bridgeHasCapability(host, 'session-permission-v1')) {
    res.status(409).json({ error: 'host_unavailable', sent: false })
    return
  }
  try {
    const target = await (await import('../../core/sessions/cloud-session-host.js')).resolveCloudSessionHost(sessionId)
    if (!target || target.host !== host) {
      res.status(409).json({ error: 'host_mismatch', sent: false })
      return
    }
  } catch {
    res.status(503).json({ error: 'host_unknown', sent: false })
    return
  }
  const remainingMs = Math.min(20_000, deadline - Date.now())
  if (remainingMs <= 0) { res.status(503).json({ error: 'host_unknown', sent: false }); return }
  try {
    const reply = await bridgeRequest(host, 'session.permission', {
      sid: sessionId, requestId, allow, ...(message !== undefined ? { message } : {}),
      ...(answers !== undefined ? { answers } : {}),
    }, remainingMs)
    res.json(reply)
  } catch (err) {
    res.status(503).json({ error: 'delivery_unconfirmed', sent: !(err instanceof BridgeOfflineError) })
  }
}

export function createBridgeSendRouter(): Router {
  const router = Router()
  router.post('/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.raw({ type: 'application/json', limit: '32mb' }),
    (req, res, next) => { void send(req, res).catch(next) },
  )
  router.post('/permission',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: '1mb' }),
    (req, res, next) => { void permission(req, res).catch(next) },
  )
  router.use(parseErrors)
  return router
}
