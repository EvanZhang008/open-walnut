/**
 * Agents and the vault (core/vault/agent.ts, docs/reference/passwords.md "Agents"):
 *
 *   GET  /api/v1/vault/agent/items?q=&site=        → { items }   what an agent may ask for, no secrets
 *   POST /api/v1/vault/agent/use                   { item, fields?, purpose, scope?, cwd?, command? }
 *                                                  → { status: 'released', values, ... } | { status: 'pending', requestId, waitToken, ... }
 *   POST /api/v1/vault/agent/use/:id/wait          { token, wait_ms? } → released | pending | expired | canceled (403 denied)
 *   POST /api/v1/vault/agent/use/:id/cancel        { token }
 *
 * and the person's own view of it (a vault session, vault-v1.ts's gate):
 *
 *   GET  /api/v1/vault/agent/log                   → { entries }
 *   GET  /api/v1/vault/agent/policy                → { agents, grants }
 *   PUT  /api/v1/vault/agent/policy                { agents: off | ask | allow }
 *   POST /api/v1/vault/agent/grants/end            → { grants, asks }
 *
 * Any caller may ask (a session, a script, a person's shell); who asked is recorded and shown
 * on the approval. A test run is refused: the vault is the person's real one. The companion
 * never carries `/vault` (v1-forward/policy.ts) and a follower holds no vault.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower, role } from '../../core/server-role.js'
import { ambientTestRun } from '../../core/test-run.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import type { ApprovalCreator, ApprovalWaiter } from '../../core/vault/agent.js'

export const vaultAgentV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function param(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

function here(res: Response): boolean {
  res.setHeader('Cache-Control', 'no-store')
  if (role() !== 'leader' || isFollower()) {
    res.status(503).json({ error: 'Passwords are kept on the Mac, which does not answer right now.', code: 'vault_not_here' })
    return false
  }
  if (ambientTestRun()) {
    res.status(403).json({ error: 'A test run cannot use the vault: it is the person\'s real one.', code: 'test_run' })
    return false
  }
  return true
}

/** The person's own routes: no session caller, no automation mark, this machine or a paired device, and a vault session. */
async function person(req: Request, res: Response): Promise<boolean> {
  const origin = requestOrigin(req)
  const ok = !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER) && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
  if (!ok) {
    res.status(403).json({ error: 'Only a person changes what agents may use.', code: 'human_only' })
    return false
  }
  const s = await import('../../core/vault/sessions.js')
  if (s.useSession(header(req, s.SESSION_HEADER))) return true
  res.status(401).json({ error: 'The vault is locked in this window: unlock it with the master password.', code: 'vault_session_needed' })
  return false
}

async function run(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { VaultError } = await import('../../core/vault/store.js')
    const { ApprovalError } = await import('../../core/approvals/store.js')
    if (err instanceof VaultError || err instanceof ApprovalError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    next(err)
  }
}

/** The switch, read from the sealed policy (the vault must be open). */
async function agentsSwitch() {
  const { closeIfNobody } = await import('./vault-v1.js')
  await closeIfNobody()
  const { readPolicy } = await import('../../core/vault/policy.js')
  return (await readPolicy()).agents
}

const createApproval: ApprovalCreator = async (input) => {
  const { createApproval: create } = await import('../../core/approvals/store.js')
  const { activeKeys } = await import('../../core/approvals/keys.js')
  // Every vault ask is signed with Face ID or Touch ID wherever a device can sign (the phone,
  // the Mac app); a window with Passwords unlocked may also approve one that is not sensitive.
  const signs = (await activeKeys()).length > 0
  const mode: 'tap' | 'biometric' = signs ? 'biometric' : 'tap'
  const downgraded = input.biometric && !signs
    ? 'This item asks for Face ID or Touch ID, but no device signs approvals yet (the Walnut iPhone app sets one up), so a window with Passwords unlocked approves it.'
    : undefined
  const { approval, waitToken } = await create({ what: input.what, detail: input.detail, mode, timeoutMs: input.timeoutMs, requester: input.requester, downgraded, testRun: input.testRun, guard: input.biometric ? 'vault-sensitive' : 'vault' })
  const { cancelInternal } = await import('../../core/approvals/store.js')
  return {
    id: approval.id, waitToken, mode, expiresAt: approval.expiresAt, ...(downgraded ? { downgraded } : {}),
    cancel: () => cancelInternal(approval.id, 'agent access changed while asking').then(() => undefined, () => undefined),
  }
}

const waitApproval: ApprovalWaiter = async (id, token, waitMs) => {
  const { waitApproval: wait } = await import('../../core/approvals/store.js')
  const r = await wait(id, token, waitMs)
  const a = r.approval
  const by = a.answer ? `${a.answer.device.name}${a.answer.mode === 'biometric' ? ', with Face ID or Touch ID' : ''}` : undefined
  return { status: a.status, used: r.used, ...(by ? { answeredBy: by } : {}) }
}

vaultAgentV1Router.get('/vault/agent/items', async (req, res, next) => {
  if (!here(res)) return
  await run(res, next, async () => {
    const { agentItems } = await import('../../core/vault/agent.js')
    const q = typeof req.query.q === 'string' ? req.query.q : undefined
    const site = typeof req.query.site === 'string' ? req.query.site : undefined
    return { items: await agentItems({ query: q, site, agents: await agentsSwitch() }) }
  })
})

vaultAgentV1Router.post('/vault/agent/use', async (req, res, next) => {
  if (!here(res)) return
  await run(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { agentUse } = await import('../../core/vault/agent.js')
    const { requesterOf } = await import('./approvals-v1.js')
    const fields = Array.isArray(body.fields) ? body.fields.map(String) : typeof body.field === 'string' ? [body.field] : undefined
    return agentUse({
      item: String(body.item ?? ''),
      fields,
      purpose: String(body.purpose ?? ''),
      scope: body.scope === 'task' ? 'task' : 'once',
      requester: await requesterOf(req, body),
      agents: await agentsSwitch(),
    }, createApproval)
  })
})

vaultAgentV1Router.post('/vault/agent/use/:id/wait', async (req, res, next) => {
  if (!here(res)) return
  await run(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { agentWait } = await import('../../core/vault/agent.js')
    const { APPROVAL_WAIT_MAX_MS } = await import('../../core/approvals/types.js')
    const waitMs = typeof body.wait_ms === 'number' && body.wait_ms >= 0 ? Math.min(APPROVAL_WAIT_MAX_MS, body.wait_ms) : APPROVAL_WAIT_MAX_MS
    return agentWait(param(req.params.id), typeof body.token === 'string' ? body.token : '', waitMs, await agentsSwitch(), waitApproval)
  })
})

vaultAgentV1Router.post('/vault/agent/use/:id/cancel', async (req, res, next) => {
  if (!here(res)) return
  await run(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { cancelApproval } = await import('../../core/approvals/store.js')
    const { agentForget } = await import('../../core/vault/agent.js')
    const id = param(req.params.id)
    await cancelApproval(id, typeof body.token === 'string' ? body.token : undefined, 'the agent stopped waiting')
    agentForget(id)
    return { ok: true }
  })
})

vaultAgentV1Router.get('/vault/agent/log', async (req, res, next) => {
  if (!here(res) || !(await person(req, res))) return
  await run(res, next, async () => {
    const { readAgentLog } = await import('../../core/vault/agent-log.js')
    return { entries: await readAgentLog(Math.min(500, Number(req.query.limit) || 200)) }
  })
})

vaultAgentV1Router.get('/vault/agent/policy', async (req, res, next) => {
  if (!here(res) || !(await person(req, res))) return
  await run(res, next, async () => {
    const { readPolicy } = await import('../../core/vault/policy.js')
    const { listGrants } = await import('../../core/vault/agent.js')
    return { ...(await readPolicy()), grants: listGrants() }
  })
})

vaultAgentV1Router.put('/vault/agent/policy', async (req, res, next) => {
  if (!here(res) || !(await person(req, res))) return
  await run(res, next, async () => {
    const { writePolicy } = await import('../../core/vault/policy.js')
    const { listGrants, endAllGrants, bumpAgentEpoch } = await import('../../core/vault/agent.js')
    const { readPolicy } = await import('../../core/vault/policy.js')
    const agents = (req.body as { agents?: string } | undefined)?.agents
    const before = (await readPolicy()).agents
    const out = await writePolicy({ agents: agents === 'off' || agents === 'allow' ? agents : 'ask' })
    // Any move of the switch stops releases still running under the old one.
    if (out.agents !== before) bumpAgentEpoch()
    if (out.agents === 'off') await endAgentAccess(endAllGrants())
    return { ...out, grants: listGrants() }
  })
})

/** End grants, and withdraw the asks still waiting so they leave the person's devices. */
export async function endAgentAccess(ended: { grants: number; asks: string[] }): Promise<{ grants: number; asks: number }> {
  const { cancelInternal } = await import('../../core/approvals/store.js')
  for (const id of ended.asks) await cancelInternal(id, 'the person ended agent access to Passwords').catch(() => undefined)
  return { grants: ended.grants, asks: ended.asks.length }
}

vaultAgentV1Router.post('/vault/agent/grants/end', async (req, res, next) => {
  if (!here(res) || !(await person(req, res))) return
  await run(res, next, async () => {
    const { endAllGrants } = await import('../../core/vault/agent.js')
    return endAgentAccess(endAllGrants())
  })
})
