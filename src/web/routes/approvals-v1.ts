/**
 * Approvals (core/approvals/): a process asks a person to say yes before it goes on.
 *
 *   POST   /api/v1/approvals                 { what, detail?, mode?, timeout_ms?, cwd?, command? } → { approval, waitToken }
 *   GET    /api/v1/approvals?status=all      → { approvals, keys } (pending only by default)
 *   GET    /api/v1/approvals/:id             → { approval }
 *   POST   /api/v1/approvals/:id/wait        { token, wait_ms? } → { approval, used } (the asker; holds ≤ 12 s)
 *   POST   /api/v1/approvals/:id/cancel      { token, reason? } → { approval } (the asker)
 *   POST   /api/v1/approvals/:id/answer      { decision, digest?, device? } → { approval } (a person only)
 *
 * Any device the person is signed in on answers, with one tap (core/approvals/types.ts): no device
 * key, no device an approval is bound to. An older client's `keyId`/`signature` on an answer, and an
 * older asker's `mode: 'biometric'` or `signing_key_id(s)`, are taken and ignored; `keys` in the list
 * stays, always empty, for the iPhone apps that still read it.
 *
 * Who is a person here: a request with no session id, no automation mark from the CLI
 * (`x-walnut-caller-kind`), and an origin that is this computer or a paired device (the
 * phone, through the companion too), never a session on another host. That is one of the
 * team charter's approval gates, so an agent is refused (tests/core/agent-parity-ratchet.test.ts).
 * Known limit, the same as every person-only route: a process on this computer that leaves
 * those headers off passes as the person, and so does a holder of a paired device's token (the
 * companion forwards with the caller headers dropped). So it guards against an agent working
 * through Walnut's tools and its own session, not against a hostile process here.
 */
import os from 'node:os'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { LOCAL_ORIGIN, hostOrigin } from '../../lib/caller-origin.js'
import { isPersonNotAutomation } from './person-caller.js'
import { APPROVAL_WAIT_MAX_MS, type ApprovalDeviceKind, type ApprovalRequester } from '../../core/approvals/types.js'
import { ambientTestRun } from '../../core/test-run.js'
import type { SessionProc } from '../../core/approvals/caller-proof.js'
import { clause } from '../../utils/format.js'
import { notSeenInsideWhy } from '../../core/approvals/seen-inside.js'

export const approvalsV1Router = Router()

const HUMAN_ONLY = 'human_only'

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** A person: see the header. Answers the refusal itself and returns false otherwise. */
function personOnly(req: Request, res: Response, what: string): boolean {
  // A browser under automation on the person's own install (Playwright, headless Chromium) is not them.
  if (isPersonNotAutomation(req)) return true
  res.status(403).json({ error: `Only a person ${what}: an agent, a session or a script cannot.`, code: HUMAN_ONLY })
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
    ...(origin.startsWith('host:') ? {} : { local: true }),
  }
  let sessionLive = false
  let daemonSid: string | undefined
  if (sid && sid !== 'external') {
    const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
    const caller = await resolveCaller(sid)
    // A session id is a name, not a proof: it counts only from the host that session runs on, so
    // a script on one host cannot take another host's session (and its task's grants) by naming it.
    if (caller.kind === 'session' && await (await import('../../core/hosts/session-host-origin.js')).fromHost(caller.record.host, origin)) {
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
    // The terminal's key (core/terminal-key.ts): a session's first terminal is its
    // id, another one `<id>__term<n>`. Its own shell proves the caller; the task is the session's.
    const { parseTerminalKey } = await import('../../core/terminal-key.js')
    const terminalSession = parseTerminalKey(terminal).sessionId
    const shell = await terminalShell(terminal)
    const seen = await localCallerIdentity({ conn, sessionId: terminalSession, sessionProcs: shell ? [shell] : [], notSession })
    if (seen.identity === 'verified') {
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const rec = await getSessionByClaudeId(terminalSession).catch(() => null)
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
  const why = notSeenInsideWhy(requester)
  if (!why) return
  throw new E(403, 'unverified_session', `A single-use approval needs the asking process seen inside its session, and ${clause(why)}. Run walnut approve from that session's own shell on this machine, with the walnut CLI reaching Walnut over HTTP.`)
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
async function terminalShell(terminalKey: string): Promise<SessionProc | undefined> {
  try {
    const { dtachPidPath } = await import('../terminal/spawn.js')
    const fs = await import('node:fs/promises')
    const [first, second] = (await fs.readFile(dtachPidPath(terminalKey), 'utf8')).split('\n')
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
    const requester = await requesterOf(req, body)
    // `mode` and `signing_key_id(s)` from an older asker are ignored: every approval is answered
    // with a tap on any device the person is signed in on (core/approvals/types.ts).
    if (singleUse && (!requester.sessionId || !requester.taskId)) {
      throw new ApprovalError(403, 'strict_approval_required', 'A single-use approval needs the task session that asks it.')
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
    // An explicit ask (`walnut approve` in a script, hook or CI step, or approval_request) always
    // asks the person, whatever the Approvals switch says: the person put it there to be asked
    // (2026-11-12, the user). The switch covers only Walnut's own asks (core/approvals/ask-me.ts),
    // so its card offers no "stop asking me" (`outsideSwitch`).
    const { approval, waitToken } = await createApproval({
      outsideSwitch: true,
      what: String(body.what ?? ''),
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      // What a script attaches (`--detail`): a diff, a command's context. Its words are `what` and `--why`.
      detailRole: 'technical',
      timeoutMs,
      requester,
      ...(singleUse ? { singleUse: true } : {}),
      context,
      ...(body.request_only === true ? { requestOnly: true } : {}),
      // An ask that is not a script blocking on its own --timeout (request-only, or the op with no
      // timeout) stays open until the person answers, while they are away too.
      untilBack: body.request_only === true || timeoutMs === undefined,
      testRun: ambientTestRun(),
    })
    // An asker that said no why gets a summary Walnut writes, in the background (summary.ts).
    const { scheduleApprovalSummary } = await import('../../core/approvals/summary.js')
    scheduleApprovalSummary(approval)
    return { approval, waitToken }
  })
})

approvalsV1Router.get('/approvals', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  void answer(res, next, async () => {
    const { listApprovals } = await import('../../core/approvals/store.js')
    const status = req.query.status === 'all' ? 'all' : 'pending'
    // `askMe`: the person's Approvals switch (ask-me.ts), so a script that asks with --single-use
    // (always asked) can read it and skip its own ask while approvals are off. `keys` is always
    // empty: no device key exists any more, and an iPhone app built before that still decodes it.
    const { asksPerson } = await import('../../core/approvals/ask-me.js')
    return { approvals: await listApprovals({ status, viewer: ambientTestRun() }), keys: [], askMe: await asksPerson() }
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
    })
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

/** How recent the master password must be for a yes that needs it (an agent's locked-note ask). */
const PASSWORD_PROOF_MS = 2 * 60_000

/** This window typed the master password (or used the Mac's keychain) in the last two minutes. */
async function passwordJustTypedHere(req: Request): Promise<boolean> {
  const s = await import('../../core/vault/sessions.js')
  await (await import('../../core/vault/session-store.js')).sessionsRestored()
  const { deviceOf } = await import('./vault-v1.js')
  const at = s.sessionUnlockedAt(header(req, s.SESSION_HEADER), deviceOf(req))
  return at !== null && Date.now() - at <= PASSWORD_PROOF_MS
}

approvalsV1Router.post('/approvals/:id/answer', (req: Request, res: Response, next: NextFunction) => {
  if (leaderOnly(res)) return
  // The one condition: a person, on any device they are signed in on (see the header).
  if (!personOnly(req, res, 'answers an approval')) return
  void answer(res, next, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { answerApproval, getApproval, visibleTo, ApprovalError } = await import('../../core/approvals/store.js')
    // A test run answers only its own approvals, and the person never answers a test run's by accident.
    const target = await getApproval(param(req.params.id))
    if (!target || !visibleTo(target, ambientTestRun())) throw new ApprovalError(404, 'not_found', 'No such approval.')
    // An agent's ask for a locked note: a yes needs the master password, so Passwords unlocked in
    // this window (docs/reference/locked-notes.md). A no needs nothing.
    // "ai can also do it with my password" (2026-11-24): the yes goes with the master password typed for it.
    if (body.decision === 'approve' && target.needsPasswords && !(await passwordJustTypedHere(req))) {
      throw new ApprovalError(401, 'master_password_needed', 'Approving this needs your Passwords master password, typed for this approval: approve it in Walnut on your Mac or in the web console, where it asks for it.')
    }
    const device = (body.device ?? {}) as Record<string, unknown>
    const deviceName = (req as Request & { deviceName?: string }).deviceName
    const kinds: ApprovalDeviceKind[] = ['iphone', 'mac-app', 'web']
    const kind = kinds.includes(device.kind as ApprovalDeviceKind) ? device.kind as ApprovalDeviceKind : deviceName ? 'iphone' : 'web'
    // An older iPhone app's keyId and signature are not read: its tap counts like any other.
    const approval = await answerApproval(param(req.params.id), {
      decision: body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : (String(body.decision ?? '') as 'approve'),
      ...(typeof body.digest === 'string' ? { digest: body.digest } : {}),
      device: { name: deviceName ?? str(device.name, 80) ?? (kind === 'web' ? 'Web console' : kind), kind },
    })
    return { approval }
  })
})
