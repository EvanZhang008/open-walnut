/**
 * Fleet secrets (core/secrets/fleet-secrets.ts): the Mac's secrets and the hosts
 * each is copied to. Additive to v1. No response ever carries a value.
 *
 *   GET    /api/v1/secrets?host=       → { active, secrets: [{ name, hosts, env, sessions, version, copies, ... }] }
 *   PUT    /api/v1/secrets/:name       { value?, hosts?, env?, sessions?, description?, create? } → { secret } (the user only)
 *
 * A save answers once its hosts have their copies or 8 s passed; a host that is
 * away (or slow) gets it in the background, and the row's copies say where it stands.
 *   DELETE /api/v1/secrets/:name       → { name, pending } (the user only)
 *   POST   /api/v1/secrets/:name/send  → { secret }: send it to its hosts again (after a host came back)
 *
 * A secret is a credential, which the team charter keeps for the user: a request
 * carrying a session id may list secrets and resend them, never add, change or delete
 * one, and neither may a paired device: only the person at this computer.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { isPersonAtThisMachine } from './expose.js'

export const secretsV1Router = Router()

function param(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

function leaderOnly(res: Response): boolean {
  if (!isFollower()) return false
  res.status(404).json({ error: 'Secrets are kept on the Mac', code: 'leader_only' })
  return true
}

/** Only the person at this computer (no session id, a local origin: expose.ts) adds, changes or deletes a secret. */
function humanOnly(req: Request, res: Response): boolean {
  if (isPersonAtThisMachine(req)) return false
  res.status(403).json({ error: 'Only the user, at this computer, adds, changes or deletes a secret', code: 'human_only' })
  return true
}

async function answer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { SecretsError } = await import('../../core/secrets/fleet-secrets.js')
    if (err instanceof SecretsError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    // Never echo the request: it may hold the value.
    next(new Error('The secret could not be saved'))
  }
}

secretsV1Router.get('/secrets', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  const host = typeof req.query.host === 'string' && req.query.host ? (req.query.host === 'local' ? '__local__' : req.query.host) : null
  void answer(res, next, async () => {
    const m = await import('../../core/secrets/fleet-secrets.js')
    const active = await m.fleetSecretsActive()
    return { active, secrets: active ? m.listSecrets().filter((s) => !host || s.hosts.includes(host)) : [] }
  })
})

secretsV1Router.put('/secrets/:name', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res) || humanOnly(req, res)) return
  const b = (req.body ?? {}) as Record<string, unknown>
  void answer(res, next, async () => ({
    secret: await (await import('../../core/secrets/fleet-secrets.js')).setSecret({
      name: param(req.params.name),
      ...(typeof b.value === 'string' ? { value: b.value } : {}),
      ...(Array.isArray(b.hosts) ? { hosts: b.hosts.map(String) } : {}),
      ...(typeof b.env === 'string' || b.env === null ? { env: b.env === '' ? null : (b.env as string | null) } : {}),
      ...(typeof b.sessions === 'boolean' ? { sessions: b.sessions } : {}),
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
      ...(b.create === true ? { create: true } : {}),
    }),
  }))
})

secretsV1Router.delete('/secrets/:name', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res) || humanOnly(req, res)) return
  void answer(res, next, async () => (await import('../../core/secrets/fleet-secrets.js')).deleteSecret(param(req.params.name)))
})

secretsV1Router.post('/secrets/:name/send', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const m = await import('../../core/secrets/fleet-secrets.js')
    const s = m.listSecrets().find((x) => x.name === param(req.params.name))
    if (!s) throw new m.SecretsError(`No secret ${param(req.params.name)}`, 404, 'not_found')
    await m.sendSoon([...new Set([...s.hosts, ...Object.keys(s.copies)])])
    return { secret: m.listSecrets().find((x) => x.name === s.name) ?? null }
  })
})
