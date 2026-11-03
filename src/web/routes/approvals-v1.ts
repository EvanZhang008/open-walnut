/**
 * Approvals (core/approvals/): a process asks a person to say yes before it goes on.
 *
 *   POST   /api/v1/approvals                 { what, detail?, mode?, timeout_ms?, cwd?, command? } → { approval, waitToken }
 *   GET    /api/v1/approvals?status=all      → { approvals, keys } (pending only by default)
 *   GET    /api/v1/approvals/:id             → { approval }
 *   POST   /api/v1/approvals/:id/wait        { token, wait_ms? } → { approval, used } (the asker; holds ≤ 12 s)
 *   POST   /api/v1/approvals/:id/cancel      { token, reason? } → { approval } (the asker)
 *   POST   /api/v1/approvals/:id/answer      { decision, keyId?, signature?, device? } → { approval } (a person only)
 *   GET    /api/v1/approvals/keys            → { keys } (public halves only)
 *   POST   /api/v1/approvals/keys            { publicKey, name, kind } → { key, enrollment? } (a person only)
 *   DELETE /api/v1/approvals/keys/:id        → { ok } (a person only)
 *
 * Who is a person here: a request with no session id, no automation mark from the CLI
 * (`x-walnut-caller-kind`), and an origin that is this computer or a paired device (the
 * phone, through the companion too), never a session on another host. That is one of the
 * team charter's approval gates, so an agent is refused (tests/core/agent-parity-ratchet.test.ts).
 * Known limit, the same as every person-only route: a process on this computer that leaves
 * those headers off passes as the person, and so does a holder of a paired device's token (the
 * companion forwards with the caller headers dropped). So a tap guards against an agent working
 * through Walnut's tools, not against a hostile process here. A biometric approval does not rest
 * on it: its Approve needs a device key's signature that only Face ID or Touch ID unlocks, and the
 * first key comes only from the paired iPhone app (keys.ts).
 */
import os from 'node:os'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { APPROVAL_WAIT_MAX_MS, type ApprovalDeviceKind, type ApprovalMode } from '../../core/approvals/types.js'
import { ambientTestRun } from '../../core/test-run.js'

export const approvalsV1Router = Router()

const HUMAN_ONLY = 'human_only'

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** A person: see the header. Answers the refusal itself and returns false otherwise. */
function personOnly(req: Request, res: Response, what: string): boolean {
  const origin = requestOrigin(req)
  const person = !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER)
    && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
  if (person) return true
  res.status(403).json({ error: `Only a person ${what}: an agent, a session or a script cannot.`, code: HUMAN_ONLY })
  return false
}

/** A test run never changes which devices sign the person's approvals. */
function notInTestRun(res: Response): boolean {
  if (!ambientTestRun()) return true
  res.status(403).json({ error: 'A test run cannot add or remove a device that signs approvals.', code: 'test_run' })
  return false
}

function leaderOnly(res: Response): boolean {
  if (!isFollower()) return false
  res.status(503).json({ error: 'Approvals are kept on the Mac, which does not answer right now.', code: 'leader_only' })
  return true
}

function param(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

async function answer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { ApprovalError } = await import('../../core/approvals/store.js')
    if (err instanceof ApprovalError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    next(err)
  }
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

/** Who asked: the session's task when a session did, its host, and what the CLI said of itself. */
async function requesterOf(req: Request, body: Record<string, unknown>) {
  const sid = header(req, 'x-walnut-caller-sid')
  const hostHeader = header(req, 'x-walnut-caller-host')
  const origin = requestOrigin(req)
  const out: { host: string; taskId?: string; taskTitle?: string; sessionId?: string; cwd?: string; command?: string } = {
    // The host is named only for a call that came through a host's gateway: a local caller
    // could put any name in the header and pass its ask off as another machine's.
    host: origin.startsWith('host:') ? (hostHeader && hostHeader !== LOCAL_ORIGIN ? hostHeader : origin.slice(5)) : os.hostname() || 'this computer',
  }
  if (sid && sid !== 'external') {
    const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
    const caller = await resolveCaller(sid)
    if (caller.kind === 'session') {
      out.sessionId = sid
      out.taskId = caller.record.taskId
      try {
        const { getTask } = await import('../../core/task-manager.js')
        out.taskTitle = (await getTask(caller.record.taskId)).title
      } catch { /* a task gone since: the id is enough */ }
    }
  }
  const cwd = str(body.cwd, 400)
  const command = str(body.command, 200)
  if (cwd) out.cwd = cwd
  if (command) out.command = command
  return out
}

approvalsV1Router.post('/approvals', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { createApproval } = await import('../../core/approvals/store.js')
    const { activeKeys } = await import('../../core/approvals/keys.js')
    const wanted: ApprovalMode = body.mode === 'biometric' ? 'biometric' : 'tap'
    let mode = wanted
    let downgraded: string | undefined
    if (wanted === 'biometric' && (await activeKeys()).length === 0) {
      mode = 'tap'
      downgraded = 'No device signs approvals yet (the Walnut iPhone app, or the Mac app on a Mac with Touch ID, sets one up), so this asks for a tap.'
    }
    const timeoutMs = typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined
    const { approval, waitToken } = await createApproval({
      what: String(body.what ?? ''),
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      mode, timeoutMs, downgraded,
      requester: await requesterOf(req, body),
      testRun: ambientTestRun(),
    })
    return { approval, waitToken, ...(downgraded ? { downgraded } : {}) }
  })
})

approvalsV1Router.get('/approvals', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const { listApprovals } = await import('../../core/approvals/store.js')
    const { listKeys } = await import('../../core/approvals/keys.js')
    const status = req.query.status === 'all' ? 'all' : 'pending'
    const keys = (await listKeys()).map(({ id, name, kind, status: s, createdAt, activatedAt, lastUsedAt }) => ({ id, name, kind, status: s, createdAt, activatedAt, lastUsedAt }))
    return { approvals: await listApprovals({ status, viewer: ambientTestRun() }), keys }
  })
})

approvalsV1Router.get('/approvals/keys', (_req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const { listKeys } = await import('../../core/approvals/keys.js')
    return { keys: (await listKeys()).map(({ enrollApprovalId: _e, ...k }) => k) }
  })
})

approvalsV1Router.post('/approvals/keys', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  if (!personOnly(req, res, 'adds a device that signs approvals')) return
  if (!notInTestRun(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { enrollKey } = await import('../../core/approvals/keys.js')
    const kind = body.kind === 'mac-app' ? 'mac-app' : body.kind === 'iphone' ? 'iphone' : ''
    // The first key only from the iPhone app with its paired device token (core/approvals/keys.ts).
    const firstAllowed = kind === 'iphone' && !!(req as Request & { deviceName?: string }).deviceName
    const out = await enrollKey({ publicKey: String(body.publicKey ?? ''), name: String(body.name ?? ''), kind: kind as 'iphone', firstAllowed })
    const { enrollApprovalId: _e, ...key } = out.key
    return { key, ...(out.enrollment ? { enrollment: out.enrollment } : {}) }
  })
})

approvalsV1Router.delete('/approvals/keys/:id', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  if (!personOnly(req, res, 'removes a device that signs approvals')) return
  if (!notInTestRun(res)) return
  void answer(res, next, async () => {
    const { removeKey } = await import('../../core/approvals/keys.js')
    await removeKey(param(req.params.id))
    return { ok: true }
  })
})

approvalsV1Router.get('/approvals/:id', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const { getApproval, viewOf, visibleTo, ApprovalError } = await import('../../core/approvals/store.js')
    const rec = await getApproval(param(req.params.id))
    if (!rec || !visibleTo(rec, ambientTestRun())) throw new ApprovalError(404, 'not_found', 'No such approval.')
    return { approval: viewOf(rec) }
  })
})

approvalsV1Router.post('/approvals/:id/wait', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { waitApproval } = await import('../../core/approvals/store.js')
    const waitMs = typeof body.wait_ms === 'number' && body.wait_ms >= 0 ? Math.min(APPROVAL_WAIT_MAX_MS, body.wait_ms) : APPROVAL_WAIT_MAX_MS
    return waitApproval(param(req.params.id), typeof body.token === 'string' ? body.token : undefined, waitMs)
  })
})

approvalsV1Router.post('/approvals/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { cancelApproval } = await import('../../core/approvals/store.js')
    const reason = str(body.reason, 200) ?? 'the asker stopped waiting'
    return { approval: await cancelApproval(param(req.params.id), typeof body.token === 'string' ? body.token : undefined, reason) }
  })
})

approvalsV1Router.post('/approvals/:id/answer', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  if (!personOnly(req, res, 'answers an approval')) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { answerApproval, getApproval, visibleTo, ApprovalError } = await import('../../core/approvals/store.js')
    const keys = await import('../../core/approvals/keys.js')
    // A test run answers only its own approvals, and the person never answers a test run's by accident.
    const target = await getApproval(param(req.params.id))
    if (!target || !visibleTo(target, ambientTestRun())) throw new ApprovalError(404, 'not_found', 'No such approval.')
    const device = (body.device ?? {}) as Record<string, unknown>
    const deviceName = (req as Request & { deviceName?: string }).deviceName
    const kinds: ApprovalDeviceKind[] = ['iphone', 'mac-app', 'web']
    const kind = kinds.includes(device.kind as ApprovalDeviceKind) ? device.kind as ApprovalDeviceKind : deviceName ? 'iphone' : 'web'
    const approval = await answerApproval(param(req.params.id), {
      decision: body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : (String(body.decision ?? '') as 'approve'),
      keyId: str(body.keyId, 80),
      signature: str(body.signature, 400),
      device: { name: deviceName ?? str(device.name, 80) ?? (kind === 'web' ? 'Web console' : kind), kind },
    }, async (id) => keys.activeKey(id))
    if (approval.answer?.keyId) await keys.touchKey(approval.answer.keyId)
    if (approval.enrollsKey) await keys.applyKeyApproval(approval)
    return { approval }
  })
})
