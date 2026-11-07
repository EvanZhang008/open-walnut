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
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN, hostOrigin } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { APPROVAL_WAIT_MAX_MS, type ApprovalDeviceKind, type ApprovalMode, type ApprovalRequester } from '../../core/approvals/types.js'
import { ambientTestRun } from '../../core/test-run.js'
import type { SessionProc } from '../../core/approvals/caller-proof.js'

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
export async function requesterOf(req: Request, body: Record<string, unknown>) {
  const sid = header(req, 'x-walnut-caller-sid')
  const hostHeader = header(req, 'x-walnut-caller-host')
  const origin = requestOrigin(req)
  const out: ApprovalRequester = {
    // The host is named only for a call that came through a host's gateway: a local caller
    // could put any name in the header and pass its ask off as another machine's.
    host: origin.startsWith('host:') ? (hostHeader && hostHeader !== LOCAL_ORIGIN ? hostHeader : origin.slice(5)) : os.hostname() || 'this computer',
  }
  let sessionLive = false
  let daemonSid: string | undefined
  if (sid && sid !== 'external') {
    const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
    const caller = await resolveCaller(sid)
    // A session id is a name, not a proof: it counts only from the host that session runs on, so
    // a script on one host cannot take another host's session (and its task's grants) by naming it.
    if (caller.kind === 'session' && hostOrigin(caller.record.host || LOCAL_ORIGIN) === origin) {
      out.sessionId = sid
      out.taskId = caller.record.taskId
      // A stopped session's pid may belong to anything by now.
      const live = caller.record.process_status === 'running' || caller.record.process_status === 'idle'
      sessionLive = live
      // The daemon knows an ACP session's worker by its runtime id.
      daemonSid = caller.record.acpRuntimeId || sid
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
  await proveIdentity(req, body, out, origin, sessionLive, daemonSid)
  return out
}

/**
 * Whether the asking process is inside the session it names (caller-proof.ts). A local request
 * is checked by the process holding the connection; a request a host's daemon relays cannot be
 * checked here yet, so it reads unverified. A local task terminal's request (its shell has
 * WALNUT_TERMINAL_SESSION_ID) names the task once its process descends from that terminal.
 */
async function proveIdentity(req: Request, body: Record<string, unknown>, out: ApprovalRequester, origin: string, sessionLive = false, daemonSid?: string): Promise<void> {
  const { inSessionByDaemon, isSelfCall, localCallerIdentity } = await import('../../core/approvals/caller-proof.js')
  // A host origin is the server's own relay of a host daemon's call. From any other process of
  // this machine the header is only a claim: the ask is that process's own, made on this machine
  // and named for no session.
  const conn = connOf(req)
  const claimed = origin.startsWith('host:') && !(conn && await isSelfCall(conn))
  if (claimed) {
    delete out.sessionId; delete out.taskId; delete out.taskTitle
    out.host = os.hostname() || 'this computer'
    out.relayClaimed = true
  }
  const local = claimed || (origin === LOCAL_ORIGIN && !header(req, 'x-walnut-caller-host'))
  const notSession = await localDaemonPids()
  if (out.sessionId) {
    // A host's relay (a remote daemon, or this Mac's own for a session's Walnut tools): the daemon
    // read the process on its gateway socket and said whether it runs inside the session
    // (caller-proof-v1). Only a token this process made names that word (relay-proof.ts).
    if (!local) {
      const { relayProofOf } = await import('../../core/approvals/relay-proof.js')
      const held = relayProofOf(header(req, 'x-walnut-caller-proof'))
      if (held && held.sid === out.sessionId && origin === hostOrigin(held.host) && sessionLive) {
        out.identity = held.proof.verified ? 'verified' : 'unverified'
        if (!held.proof.verified) out.check = held.proof.pid && !held.proof.unchecked ? 'outside' : 'unchecked'
        if (held.proof.process) out.process = held.proof.process
        if (held.proof.ranBy) {
          const { redactSensitiveText } = await import('../../logging/redact.js')
          out.ranBy = redactSensitiveText(held.proof.ranBy)
        }
        return
      }
      out.identity = 'unverified'; out.check = 'unchecked'; return
    }
    if (!conn || !sessionLive) { out.identity = 'unverified'; out.check = 'unchecked'; return }
    const seen = await localCallerIdentity({ conn, sessionId: daemonSid ?? out.sessionId, inSession: inSessionByDaemon, notSession })
    out.identity = seen.identity
    if (seen.check) out.check = seen.check
    if (seen.process) out.process = seen.process
    if (seen.ranBy) out.ranBy = seen.ranBy
    return
  }
  const terminal = str(body.terminal_session, 120)
  if (local && conn && terminal && /^[A-Za-z0-9_-]+$/.test(terminal)) {
    const shell = await terminalShell(terminal)
    const seen = await localCallerIdentity({ conn, sessionId: terminal, sessionProcs: shell ? [shell] : [], notSession })
    if (seen.identity === 'verified') {
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const rec = await getSessionByClaudeId(terminal).catch(() => null)
      if (rec?.taskId) {
        out.taskId = rec.taskId
        out.via = 'terminal'
        out.identity = 'verified'
        if (seen.ranBy) out.ranBy = seen.ranBy
        try {
          const { getTask } = await import('../../core/task-manager.js')
          out.taskTitle = (await getTask(rec.taskId)).title
        } catch { /* the id is enough */ }
        return
      }
    }
  }
  const seen = local && conn ? await localCallerIdentity({ conn, sessionProcs: [] }) : { identity: 'none' as const }
  out.identity = 'none'
  if ('process' in seen && seen.process) out.process = seen.process
  if ('ranBy' in seen && seen.ranBy) out.ranBy = seen.ranBy
  if ('user' in seen && seen.user) out.user = seen.user
}

/** A single-use step needs its asking process seen inside the session it names (403 otherwise). */
function assertSeenInside(requester: ApprovalRequester, E: new (status: number, code: string, message: string) => Error): void {
  if (requester.identity === 'verified' && requester.sessionId) return
  const why = !requester.sessionId
    ? 'the request names no session Walnut can check'
    : requester.check === 'outside'
      ? 'the asking process is not inside the session it names'
      : 'Walnut could not check that the asking process is inside the session it names (a call through a host daemon\'s socket, a remote host, or a check that timed out)'
  throw new E(403, 'unverified_session', `A single-use approval needs the asking process seen inside its session, and ${why}. Run walnut approve from that session's own shell on this machine, with the walnut CLI reaching Walnut over HTTP.`)
}

/** The connection this request came on, as the server sees both ends. */
function connOf(req: Request): import('../../core/approvals/caller-proof.js').Conn | undefined {
  const s = req.socket
  if (!s?.remoteAddress || !s.remotePort || !s.localAddress || !s.localPort) return undefined
  return { remoteAddress: s.remoteAddress, remotePort: s.remotePort, localAddress: s.localAddress, localPort: s.localPort }
}

/** This machine's daemon: it starts every session, so it is never one. */
async function localDaemonPids(): Promise<number[]> {
  try {
    const { localDaemonDirChoice } = await import('../../lib/daemon-dir.js')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const pid = Number((await fs.readFile(path.join(localDaemonDirChoice().dir, 'daemon.pid'), 'utf8')).trim())
    return Number.isInteger(pid) && pid > 1 ? [pid] : []
  } catch {
    return []
  }
}

/**
 * A local task terminal's dtach master, from its pid record: the pid and, on its second line, the
 * start time the master recorded for itself (`proc:<ticks>` on Linux, `ps:<lstart in UTC>`
 * elsewhere, dtach-master.ts). The process under that pid counts only while it is that one.
 */
async function terminalShell(sessionId: string): Promise<SessionProc | undefined> {
  try {
    const { dtachPidPath } = await import('../terminal/spawn.js')
    const fs = await import('node:fs/promises')
    const [first, second] = (await fs.readFile(dtachPidPath(sessionId), 'utf8')).split('\n')
    const pid = Number(first)
    if (!Number.isInteger(pid) || pid <= 1) return undefined
    const m = /^(proc|ps):(.+)$/.exec((second ?? '').trim())
    if (!m) return undefined
    return m[1] === 'proc' ? { pid, start: m[2]!.trim() } : { pid, startUtc: m[2]! }
  } catch {
    return undefined
  }
}

approvalsV1Router.post('/approvals', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { createApproval, ApprovalError } = await import('../../core/approvals/store.js')
    const singleUse = body.single_use === true
    const origin = requestOrigin(req)
    const requester = await requesterOf(req, body)
    const { activeKeys } = await import('../../core/approvals/keys.js')
    const wanted: ApprovalMode = body.mode === 'biometric' ? 'biometric' : 'tap'
    let mode = wanted
    let downgraded: string | undefined
    const keys = await activeKeys()
    if (singleUse && (wanted !== 'biometric' || !requester.sessionId || !requester.taskId
      || !keys.some((key) => key.id === body.signing_key_id))) {
      throw new ApprovalError(403, 'strict_approval_required', 'A single-use approval needs a task session and its enrolled signing device; it never falls back to a tap.')
    }
    if (wanted === 'biometric' && keys.length === 0) {
      mode = 'tap'
      downgraded = 'No device signs approvals yet (the Walnut iPhone app, or the Mac app on a Mac with Touch ID, sets one up), so this asks for a tap.'
    }
    // A single-use approval is the session's own step: Walnut must have seen the asking process
    // inside it, never only its name, and a check it could not make refuses too (fail closed).
    if (singleUse) assertSeenInside(requester, ApprovalError)
    const timeoutMs = typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined
    const { readAskerContext } = await import('../../core/approvals/asker-context.js')
    const context = await readAskerContext({
      ...(requester.sessionId ? { sessionId: requester.sessionId } : {}),
      ...(requester.taskId ? { taskId: requester.taskId } : {}),
      ...(str(body.why, 400) ? { why: str(body.why, 400) } : {}),
    })
    const { approval, waitToken } = await createApproval({
      what: String(body.what ?? ''),
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      mode, timeoutMs, downgraded,
      requester,
      ...(singleUse ? { singleUse: true, signingKeyId: String(body.signing_key_id) } : {}),
      context,
      ...(body.request_only === true ? { requestOnly: true } : {}),
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

approvalsV1Router.post('/approvals/:id/consume', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { consumeApproval } = await import('../../core/approvals/store.js')
    const { activeKey } = await import('../../core/approvals/keys.js')
    // The step is spent by the same session's own process, checked again here: a token another
    // process of this machine took cannot be spent by naming the asking session.
    const requester = await requesterOf(req, body)
    const { ApprovalError } = await import('../../core/approvals/store.js')
    assertSeenInside(requester, ApprovalError)
    return consumeApproval(param(req.params.id), {
      token: typeof body.token === 'string' ? body.token : '',
      digest: typeof body.digest === 'string' ? body.digest : '',
      detail: typeof body.detail === 'string' ? body.detail : '',
      requester,
    }, activeKey)
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

/**
 * An unsigned Approve of giving an agent a vault item. A tap from this machine is not enough:
 * any process here can send one (see the header), and an agent holds its own ask's id; a device
 * token is not enough either, since a process here can make one (devices.ts). The proof is a
 * device key's signature (answerApproval checks it) or a live Passwords unlock in this window (a
 * vault session, which only the master password buys). A sensitive item takes only a signature
 * while some device can sign.
 */
async function vaultApprover(req: Request, body: Record<string, unknown>, target: { mode: string; guard?: string }): Promise<boolean> {
  if (target.guard === 'vault-sensitive' && target.mode === 'biometric') return false
  const { useSession, SESSION_HEADER } = await import('../../core/vault/sessions.js')
  const { deviceOf } = await import('./vault-v1.js')
  const token = header(req, SESSION_HEADER) ?? (typeof body.vaultSession === 'string' ? body.vaultSession : undefined)
  return !!useSession(token, true, deviceOf(req))
}

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
    let proven = false
    if (target.guard && body.decision === 'approve' && !body.signature) {
      // Unsigned: only a Passwords unlock in this window proves it is the person (vaultApprover).
      // The same for an agent's buy, send or delete in the browser (`person`).
      if (!(await vaultApprover(req, body, target))) {
        if (target.guard === 'person') {
          throw new ApprovalError(403, 'proof_needed', 'Approve it on your iPhone with Face ID or in the Walnut Mac app with Touch ID (or unlock Passwords in this window): '
            + 'an agent\'s step that buys, sends or deletes needs proof that it is you saying yes.')
        }
        throw new ApprovalError(403, 'vault_unlock_needed', target.guard === 'vault-sensitive' && target.mode === 'biometric'
          ? 'This item needs Face ID or Touch ID: approve it on your iPhone or in the Walnut Mac app.'
          : 'Unlock Passwords in this window to approve, or approve on your iPhone with Face ID: giving an agent a password needs the master password or a device that signs.')
      }
      proven = true
    }
    const device = (body.device ?? {}) as Record<string, unknown>
    const deviceName = (req as Request & { deviceName?: string }).deviceName
    const kinds: ApprovalDeviceKind[] = ['iphone', 'mac-app', 'web']
    const kind = kinds.includes(device.kind as ApprovalDeviceKind) ? device.kind as ApprovalDeviceKind : deviceName ? 'iphone' : 'web'
    const approval = await answerApproval(param(req.params.id), {
      decision: body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : (String(body.decision ?? '') as 'approve'),
      keyId: str(body.keyId, 80),
      signature: str(body.signature, 400),
      device: { name: deviceName ?? str(device.name, 80) ?? (kind === 'web' ? 'Web console' : kind), kind },
      proven,
    }, async (id) => keys.activeKey(id))
    if (approval.answer?.keyId) await keys.touchKey(approval.answer.keyId)
    if (approval.enrollsKey) await keys.applyKeyApproval(approval)
    return { approval }
  })
})
