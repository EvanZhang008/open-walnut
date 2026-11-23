/**
 * An engine CLI's own sign-in and install, per host (core/agents/engine-sign-in.ts; the host's
 * daemon does each step there). Mounted beside enginesRouter under /api/engines:
 *
 *   GET    /:id/sign-in?host=&fresh=1      one host's EngineSignInStatus
 *   GET    /:id/sign-in/hosts              { engine, hosts: EngineSignInStatus[] }, this machine first; dials no host
 *                                            (one without an open link reads connected: false until its own row is asked)
 *   POST   /:id/sign-in        {host, restart?}       { host, id, link, startedAt, expiresAt, phase, reused? }
 *   POST   /:id/sign-in/finish {host, id, code}       { status }  (400 bad_code / invalid_code / no_sign_in, 504 timeout)
 *   POST   /:id/sign-in/cancel {host, id?}            { cancelled }
 *   POST   /:id/sign-out       {host}                 { status }  (the CLI's own account sign-out on that host; a person only)
 *   PUT    /:id/api-key        {key, host?}           { apiKey: {set}, status? }   (a person only: 403 human_only)
 *   DELETE /:id/api-key?host=                         { apiKey: {set}, status? }   (a person only)
 *   POST   /:id/install        {host}                 202 InstallState (state 'running'); 409 installed
 *   GET    /:id/install?host=                         InstallState (idle | running | done | failed)
 *
 * Every failure answers `{ error, code }` with the status the core gave it. Every route has a
 * deadline (the core's, per daemon ask), so none hangs on a host that does not answer. Who may:
 * a sign-in's start, finish and cancel are open to agents too (a person still opens the link and
 * pastes the code only they have); the API key and the account's sign-out are the user's own
 * credentials, so only a person changes them (`personOnly`). Each write logs who asked (`by`).
 */
import { Router, type Request, type Response } from 'express'
import {
  EngineSignInError,
  apiKeyOfInput,
  cancelEngineSignIn,
  engineInstallStatus,
  engineSignInHosts,
  engineSignInSpec,
  engineSignInStatus,
  finishEngineSignIn,
  setEngineApiKey,
  signOutEngine,
  startEngineInstall,
  startEngineSignIn,
} from '../../core/agents/engine-sign-in.js'
import { resolveHostParam } from './engines.js'
import { isPersonNotAutomation } from './person-caller.js'
import { log } from '../../logging/index.js'

export const engineSignInRouter = Router()

function by(req: Request): string {
  const sid = req.headers['x-walnut-caller-sid']
  return typeof sid === 'string' && sid.trim() ? `session:${sid.trim().slice(0, 100)}` : 'person'
}

function answer(res: Response, err: unknown, ctx: Record<string, unknown>): void {
  if (err instanceof EngineSignInError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  log.web.warn('engine sign-in request failed', { ...ctx, error: message })
  res.status(500).json({ error: message, code: 'failed' })
}

/** The engine and host of a request, or null after answering 404 / 400. */
async function target(req: Request, res: Response, raw: unknown): Promise<{ engine: string; host: string } | null> {
  const engine = String(req.params.id)
  if (!engineSignInSpec(engine)) { res.status(404).json({ error: `engine '${engine}' has no sign-in`, code: 'unknown_engine' }); return null }
  const host = await resolveHostParam(raw)
  if (!host) { res.status(400).json({ error: `unknown host '${String(raw)}'`, code: 'unknown_host' }); return null }
  return { engine, host }
}

/** The API key and the sign-out: a person's own request only (routes/person-caller.ts), never a session or a browser under automation. */
function personOnly(req: Request, res: Response): boolean {
  if (isPersonNotAutomation(req)) return false
  res.status(403).json({ error: "Only the user sets or removes an engine's API key or signs its account out", code: 'human_only' })
  return true
}

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {})

engineSignInRouter.get('/:id/sign-in/hosts', async (req, res) => {
  const engine = String(req.params.id)
  if (!engineSignInSpec(engine)) { res.status(404).json({ error: `engine '${engine}' has no sign-in`, code: 'unknown_engine' }); return }
  try { res.json({ engine, hosts: await engineSignInHosts(engine) }) } catch (err) { answer(res, err, { engine, op: 'hosts' }) }
})

engineSignInRouter.get('/:id/sign-in', async (req, res) => {
  const t = await target(req, res, req.query.host)
  if (!t) return
  try { res.json(await engineSignInStatus(t.engine, t.host, { fresh: req.query.fresh === '1' })) } catch (err) { answer(res, err, { ...t, op: 'status' }) }
})

engineSignInRouter.post('/:id/sign-in', async (req, res) => {
  const t = await target(req, res, body(req).host)
  if (!t) return
  try {
    const started = await startEngineSignIn(t.engine, t.host, { restart: body(req).restart === true })
    log.web.info('engine sign-in started', { ...t, id: started.id, by: by(req) })
    res.json(started)
  } catch (err) { answer(res, err, { ...t, op: 'start' }) }
})

engineSignInRouter.post('/:id/sign-in/finish', async (req, res) => {
  const t = await target(req, res, body(req).host)
  if (!t) return
  const id = typeof body(req).id === 'string' ? (body(req).id as string).slice(0, 100) : ''
  if (!id) { res.status(400).json({ error: 'id is required', code: 'no_sign_in' }); return }
  try {
    // The code goes to the daemon as it came; it is checked there and never logged.
    const status = await finishEngineSignIn(t.engine, t.host, id, body(req).code)
    log.web.info('engine sign-in finished', { ...t, id, by: by(req) })
    res.json({ status })
  } catch (err) { answer(res, err, { ...t, op: 'finish' }) }
})

engineSignInRouter.post('/:id/sign-in/cancel', async (req, res) => {
  const t = await target(req, res, body(req).host)
  if (!t) return
  const id = typeof body(req).id === 'string' ? (body(req).id as string).slice(0, 100) : undefined
  try { res.json(await cancelEngineSignIn(t.engine, t.host, id)) } catch (err) { answer(res, err, { ...t, op: 'cancel' }) }
})

engineSignInRouter.post('/:id/sign-out', async (req, res) => {
  if (personOnly(req, res)) return
  const t = await target(req, res, body(req).host)
  if (!t) return
  try {
    const status = await signOutEngine(t.engine, t.host)
    log.web.info('engine sign-out', { ...t, by: by(req) })
    res.json({ status })
  } catch (err) { answer(res, err, { ...t, op: 'sign-out' }) }
})

/** The key is one setting for every host; `host` only picks which host's status comes back with it. */
async function apiKeyWrite(req: Request, res: Response, key: string | null, hostRaw: unknown): Promise<void> {
  const engine = String(req.params.id)
  if (!engineSignInSpec(engine)) { res.status(404).json({ error: `engine '${engine}' has no sign-in`, code: 'unknown_engine' }); return }
  try {
    const apiKey = await setEngineApiKey(engine, key)
    log.web.info('engine api key changed', { engine, set: apiKey.set, by: by(req) })
    const host = hostRaw === undefined ? null : await resolveHostParam(hostRaw)
    res.json({ apiKey, ...(host ? { status: await engineSignInStatus(engine, host) } : {}) })
  } catch (err) { answer(res, err, { engine, op: 'api-key' }) }
}

engineSignInRouter.put('/:id/api-key', async (req, res) => {
  if (personOnly(req, res)) return
  let key: string
  try { key = apiKeyOfInput(body(req).key) } catch (err) { answer(res, err, { op: 'api-key' }); return }
  await apiKeyWrite(req, res, key, body(req).host)
})

engineSignInRouter.delete('/:id/api-key', async (req, res) => {
  if (personOnly(req, res)) return
  await apiKeyWrite(req, res, null, req.query.host)
})

engineSignInRouter.post('/:id/install', async (req, res) => {
  const t = await target(req, res, body(req).host)
  if (!t) return
  try {
    const state = await startEngineInstall(t.engine, t.host)
    log.web.info('engine install asked', { ...t, by: by(req) })
    res.status(state.state === 'running' ? 202 : 200).json(state)
  } catch (err) { answer(res, err, { ...t, op: 'install' }) }
})

engineSignInRouter.get('/:id/install', async (req, res) => {
  const t = await target(req, res, req.query.host)
  if (!t) return
  try { res.json(await engineInstallStatus(t.engine, t.host)) } catch (err) { answer(res, err, { ...t, op: 'install-status' }) }
})
