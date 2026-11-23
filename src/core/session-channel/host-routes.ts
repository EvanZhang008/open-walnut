/**
 * The routes a leader calls on a host that runs and judges its sessions (host-api.ts), served on
 * the host replica's leader door (replica/leader-door.ts): only streams the Mac opened reach them.
 *
 *   start      the bundle answers this start's leader reads (host-port.ts StartBundles), a large
 *              prompt is spilled to a file of this host's own, then the host's runner starts it
 *   send / interrupt   the very bus events the leader's own runner takes, on this host's bus
 *   call       one member of HOST_CALL_ALLOWLIST (host-calls.ts) on the runner, the native session
 *              or the ACP session; a member that returns an undo (markExpectedTeardown) gives back an
 *              id the leader undoes with `undoExpectedTeardown`; `bashCallMatchingOp` is
 *              bashCallMatching with the op and file the leader's predicate would test
 *   drop       the sessions the leader deleted: this host drops its rows of them (leader-drops.ts)
 *   channel    a WebSocket whose frames are the channel's (channel.ts HostChannel.attach)
 *   credential the door credential the leader issues this host (host-credential-file.ts), on this
 *              door only: never through `call`
 *   doors      the leader's door list (`/host-api/doors`, host-credential-file.ts answerDoorsRoute),
 *              on this door only: never through `call`
 *
 * `call` answers the same session routes from frames a leader sends on a socket this host dialed
 * into its door (host-dialer.ts): one route table, whichever link carried the request.
 *
 * The switch is asked on every start: off, a start answers `host_runs_sessions_off`; the sessions
 * this host already runs keep their other routes and the channel.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from '#ws'
import { hostCallAllowed, hostCallArgs } from './host-calls.js'
import { checkPermissionAnswer } from './host-permission.js'
import { isChannelFrame, type HostChannel } from './channel.js'
import { HOST_CHANNEL_PATH, HOST_SESSIONS_OFF, HOST_SESSIONS_PATH, NOT_OWN_SESSION, type CallBody, type QueuedLine, type StartBody } from './host-api.js'
import type { StartBundles } from './host-port.js'
import type { SessionRecord } from '../types.js'
import { HOST_CREDENTIAL_PATH, HOST_DOORS_PATH } from './door-wire.js'
import { answerCredentialRoute, answerDoorsRoute, type CredentialRouteOptions } from './host-credential-file.js'

/** The largest body a route reads (a start's large prompt rides it). */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** How long an undo of an expected teardown is kept for the leader to call. */
const UNDO_TTL_MS = 10 * 60_000
/** How long a spilled start prompt is kept for its session to read (a resume may read it again). */
export const SPILL_TTL_MS = 3 * 24 * 60 * 60_000

/** Remove the spilled prompts older than SPILL_TTL_MS (each start sweeps before it spills). */
export async function sweepSpilledPrompts(dir: string, now = Date.now()): Promise<number> {
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!/^prompt-[0-9a-f]+\.txt$/.test(name)) continue
    const p = path.join(dir, name)
    try {
      if (now - (await fsp.stat(p)).mtimeMs > SPILL_TTL_MS) { await fsp.rm(p, { force: true }); removed++ }
    } catch { /* gone already */ }
  }
  return removed
}

type AnyFn = (...args: unknown[]) => unknown
/** The runner as the routes use it (SessionRunner). */
export interface HostRunnerLike {
  startSession(data: Record<string, unknown> & { taskId: string; message: string }, framedBy?: string): Promise<{ claudeSessionId: string; title: string }>
  findSessionByClaudeId(sid: string): object | undefined
  findAcpSession(sid: string): object | undefined
  getOrAttachLiveSession?(sid: string): Promise<object | undefined | null>
  findOrAttachAcpSession?(sid: string): Promise<object | undefined | null>
}

export interface HostRoutesOptions {
  /** hostRunsSessionsAnyNow (switch.ts); asked per request. */
  enabled(): Promise<boolean>
  runner(): Promise<HostRunnerLike>
  bundles: StartBundles
  /** The channel this host keeps for its Walnut, or null while it has none. */
  channel(): HostChannel | null
  /** A bus event for this host's runner (SESSION_SEND, SESSION_INTERRUPT). */
  emit(name: string, data: unknown, source: string): void
  /**
   * Queue a send's lines on this host (session-message-queue.ts), before its SESSION_SEND: the
   * runner drains the queue. `source`: the send's bus source (who a line with no sender is from).
   */
  enqueue(sid: string, lines: QueuedLine[], source: string): Promise<void>
  /** The leader deleted these sessions: drop this host's rows of them; answered once each is a `drop` record. */
  drop?(sids: string[]): Promise<number>
  /** Where a start's large prompt is spilled (0700, files 0600). */
  spillDir: string
  /**
   * Is `sid` one of this host's own sessions (its row rowOwnedHere)? A call or an interrupt of any
   * other is refused: a copied row of a session the leader runs here never reaches its process
   * through these routes. Absent (tests): every sid passes.
   */
  owns?(sid: string): Promise<boolean>
  /** The session controls of host-calls.ts `lifecycle` (sessions/session-lifecycle.ts); tests pass their own. */
  lifecycle?: Record<string, (sid: string, ...args: unknown[]) => Promise<unknown>>
  /** The op test of a Bash call (lib/walnut-op-command.ts commandRunsOp); tests pass their own. */
  commandRunsOp?(command: string, op: string, file?: string): boolean
  /** The door credential route (host-credential-file.ts); absent: it answers 404. */
  credential?: CredentialRouteOptions
  /**
   * A start with a preassigned id makes that session this host's from its first write, whatever
   * copy of the leader's row is here or comes later (session-db.ts claimStartingRow; a resume gives
   * the leader's row for a host whose copy has none yet); `release` when the start ended without a
   * session here. Absent (tests): nothing is claimed.
   */
  claim?: { take(sid: string, leaderRow?: SessionRecord): void; release(sid: string): void }
  /**
   * Why a session a resume names is not at rest here (a session of it in the runner, its CLI in
   * the runtime, or no word from the runtime), or null when nothing of it runs. Absent: this host
   * takes no resume (it answers `resume_unsupported`).
   */
  notAtRest?(sid: string): Promise<string | null>
  now?: () => number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface HostSessionRoutes {
  /** True when the request was one of these routes (and was answered). */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** One session route from a leader's call frame (host-dialer.ts): its answer. The credential route is never one. */
  call(method: string, pathname: string, body: unknown): Promise<{ status: number; body: unknown }>
  /** True when the upgrade was the channel's (and was taken). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** The answer of every route of a host whose switch is off (or that has no routes at all). */
export function answerHostSessionsOff(res: ServerResponse): void {
  sendJson(res, 503, { ok: false, error: HOST_SESSIONS_OFF })
}

/** The same answer to a channel upgrade: a plain HTTP response on the socket, then closed. */
export function refuseChannelUpgrade(socket: Duplex): void {
  const text = JSON.stringify({ ok: false, error: HOST_SESSIONS_OFF })
  try {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`)
  } catch { socket.destroy() }
}

/** Is this path one of the host session routes (the door answers them off without the routes)? */
export function isHostSessionsPath(pathname: string): boolean {
  return pathname === HOST_CHANNEL_PATH || pathname === HOST_CREDENTIAL_PATH || pathname === HOST_DOORS_PATH || pathname.startsWith(HOST_SESSIONS_PATH + '/')
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(Object.assign(new Error('the body is not JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/** A value as JSON carries it: a function is left out, an object that cannot be written is null. */
function jsonValue(v: unknown): unknown {
  if (v === undefined || typeof v === 'function') return null
  try { return JSON.parse(JSON.stringify(v)) as unknown } catch { return null }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A start's own key for its bundle: its preassigned session id, else one made for it (R2-M5). */
function startIdOf(body: StartBody): string {
  const pre = (body as { preassignedSessionId?: unknown }).preassignedSessionId
  return typeof pre === 'string' && pre ? pre : `start-${crypto.randomBytes(8).toString('hex')}`
}

/** A session id the leader may name for a start (event-types.ts checks it at the leader's edge; a file is named by it here). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export { NOT_OWN_SESSION }
/** A session or runtime id as a file name takes it: letters, digits, '-' and '_' (acp-<hex>, a UUID). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function createHostSessionRoutes(o: HostRoutesOptions): HostSessionRoutes {
  const now = o.now ?? Date.now
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  const undos = new Map<string, { fn: () => void; until: number }>()

  const keepUndo = (fn: () => void): string => {
    const at = now()
    for (const [id, u] of undos) if (u.until <= at) undos.delete(id)
    const id = crypto.randomBytes(12).toString('hex')
    undos.set(id, { fn, until: at + UNDO_TTL_MS })
    return id
  }

  async function start(body: StartBody): Promise<{ status: number; body: unknown }> {
    if (!body || typeof body.taskId !== 'string' || typeof body.message !== 'string') return { status: 400, body: { ok: false, error: 'taskId and message are required', why: 'bad_request' } }
    if (body.resumeSessionId !== undefined) return resume(body)
    const pre = (body as { preassignedSessionId?: unknown }).preassignedSessionId
    if (pre !== undefined && (typeof pre !== 'string' || !UUID_V4.test(pre))) return { status: 400, body: { ok: false, error: 'preassignedSessionId must be a v4 UUID', why: 'bad_request' } }
    // Ids that name files or sessions on this host: one plain name each, never a path (R2-L2).
    for (const k of ['runtimeId', 'forkedFromSessionId', 'fromPlanSessionId'] as const) {
      const v = (body as Record<string, unknown>)[k]
      if (v !== undefined && v !== null && (typeof v !== 'string' || !SAFE_ID.test(v))) return { status: 400, body: { ok: false, error: `${k} is not a session id`, why: 'bad_request' } }
    }
    const { largePrompt, largePromptPath, startBundle, busSource, ...rest } = body
    const data: Record<string, unknown> & { taskId: string; message: string } = { ...rest }
    if (typeof largePrompt === 'string' && largePrompt.length > 0) {
      await fsp.mkdir(o.spillDir, { recursive: true, mode: 0o700 })
      await sweepSpilledPrompts(o.spillDir, now()).catch(() => 0)
      const file = path.join(o.spillDir, `prompt-${crypto.randomBytes(8).toString('hex')}.txt`)
      await fsp.writeFile(file, largePrompt, { mode: 0o600 })
      data.largePromptFile = { localPath: file, originalLength: largePrompt.length }
      // The message points at the leader's file, which is not here: point it at this host's.
      if (typeof largePromptPath === 'string' && largePromptPath.length > 1) data.message = data.message.split(largePromptPath).join(file)
    }
    // The session runs on this host, through its own runtime: no host to dial from here.
    delete data.host
    // The answer waits for the CLI's own word (its init, or its failure), never for a timer here:
    // a "no" while a CLI it spawned still starts would leave a session the leader takes back (R2-H2).
    data.waitForSpawn = true
    const startId = startIdOf(body)
    if (startBundle) o.bundles.put(startId, body.taskId, startBundle, body.preassignedSessionId)
    if (pre) {
      try { o.claim?.take(pre) } catch (err) { o.log?.('warn', 'host sessions: a start could not claim its session\'s row', { taskId: body.taskId, sessionId: pre, error: errText(err) }) }
    }
    let runner: HostRunnerLike | null = null
    try {
      runner = await o.runner()
      const r = await o.bundles.run(startId, () => runner!.startSession(data, busSource))
      return { status: 200, body: { ok: true, sessionId: r.claudeSessionId, title: r.title } }
    } catch (err) {
      // A start that threw after its session came up here is this host's: said as taken, so the
      // leader never runs it itself (its row and facts tell the rest).
      if (pre && runner && (runner.findSessionByClaudeId(pre) || runner.findAcpSession(pre))) {
        o.log?.('warn', 'host sessions: a start threw after its session came up; answered as taken', { taskId: body.taskId, sessionId: pre, error: errText(err) })
        return { status: 200, body: { ok: true, sessionId: pre, title: '' } }
      }
      if (pre) {
        try { o.claim?.release(pre) } catch (e) { o.log?.('warn', 'host sessions: a failed start\'s claim was not released', { sessionId: pre, error: errText(e) }) }
      }
      const why = typeof (err as { why?: unknown })?.why === 'string' ? (err as { why: string }).why : 'start_failed'
      o.log?.('warn', 'host sessions: a start failed', { taskId: body.taskId, error: errText(err) })
      return { status: 200, body: { ok: false, error: errText(err), why } }
    } finally {
      o.bundles.clear(startId)
    }
  }

  /**
   * A start that resumes a session its leader ran until now (host-api.ts ResumeFields): refused
   * while anything of it runs here; else its row is this host's, its lines are queued here as a
   * send's are (by their row ids, once) and the runner drains them, which resumes the CLI session.
   * The answer comes once the lines are queued: what the resume did comes back on the channel.
   */
  async function resume(body: StartBody): Promise<{ status: number; body: unknown }> {
    const sid = body.resumeSessionId
    const row = body.resumeRow
    if (typeof sid !== 'string' || !SAFE_ID.test(sid)) return { status: 400, body: { ok: false, error: 'resumeSessionId is not a session id', why: 'bad_request' } }
    if (row !== undefined && (!row || typeof row !== 'object' || row.claudeSessionId !== sid)) return { status: 400, body: { ok: false, error: 'resumeRow is not the row of the session it resumes', why: 'bad_request' } }
    if (!o.notAtRest) return { status: 200, body: { ok: false, error: 'this host does not resume sessions', why: 'resume_unsupported' } }
    // Checked before the row is claimed: a refusal leaves nothing here. Nothing else starts a CLI of
    // it meanwhile: its leader delivers to it only through this resume until the answer comes.
    const busy = await o.notAtRest(sid)
    if (busy) {
      o.log?.('info', 'host sessions: a resume was refused, the session is not at rest here', { sessionId: sid, why: busy })
      return { status: 200, body: { ok: false, error: `the session is not at rest on this host: ${busy}`, why: 'not_at_rest' } }
    }
    try { o.claim?.take(sid, row) } catch (err) {
      return { status: 200, body: { ok: false, error: `the session's row could not be made this host's: ${errText(err)}`, why: 'resume_failed' } }
    }
    const source = typeof body.busSource === 'string' && body.busSource ? body.busSource : 'host-api'
    const lines = Array.isArray(body.queued) ? body.queued.filter((l) => l && typeof l.message === 'string') : []
    try {
      if (lines.length > 0) await o.enqueue(sid, lines, source)
    } catch (err) {
      try { o.claim?.release(sid) } catch { /* the sweep gives it back */ }
      o.log?.('warn', 'host sessions: a resume could not queue its lines', { sessionId: sid, error: errText(err) })
      return { status: 200, body: { ok: false, error: `the resume's lines were not queued: ${errText(err)}`, why: 'resume_failed' } }
    }
    o.emit('session:send', { sessionId: sid, message: '' }, source)
    o.log?.('info', 'host sessions: a session its leader ran is resumed here', { sessionId: sid, lines: lines.length })
    return { status: 200, body: { ok: true, sessionId: sid, title: '' } }
  }

  async function call(body: CallBody): Promise<{ status: number; body: unknown }> {
    if (!body || typeof body.sid !== 'string' || typeof body.member !== 'string' || typeof body.target !== 'string') {
      return { status: 400, body: { ok: false, error: 'sid, target and member are required' } }
    }
    if (!hostCallAllowed(body.target, body.member)) return { status: 403, body: { ok: false, error: 'not_allowed' } }
    if (o.owns && !(await o.owns(body.sid))) return { status: 403, body: { ok: false, error: NOT_OWN_SESSION } }
    const args = Array.isArray(body.args) ? body.args : []
    if (body.member === 'undoExpectedTeardown') {
      const u = undos.get(String(args[0] ?? ''))
      undos.delete(String(args[0] ?? ''))
      if (u) u.fn()
      return { status: 200, body: { ok: true, value: !!u } }
    }
    // A control the host carries out whole for its own session (host-calls.ts `lifecycle`).
    if (body.target === 'lifecycle') {
      const lifecycle = o.lifecycle ?? await import('../sessions/session-lifecycle.js')
      const fn = (lifecycle as unknown as Record<string, unknown>)[body.member]
      if (typeof fn !== 'function') return { status: 200, body: { ok: false, error: 'no_such_member' } }
      return { status: 200, body: { ok: true, value: jsonValue(await (fn as AnyFn)(...hostCallArgs('lifecycle', body.sid, args))) } }
    }
    const runner = await o.runner()
    let target: Record<string, unknown> | null
    if (body.target === 'runner') target = runner as unknown as Record<string, unknown>
    else if (body.target === 'acp') target = (runner.findAcpSession(body.sid) ?? await runner.findOrAttachAcpSession?.(body.sid) ?? null) as Record<string, unknown> | null
    else target = (runner.findSessionByClaudeId(body.sid) ?? await runner.getOrAttachLiveSession?.(body.sid) ?? null) as Record<string, unknown> | null
    if (!target) return { status: 200, body: { ok: false, error: 'no_live_session' } }
    // An answer to a prompt names a request this very session holds now (host-permission.ts).
    const permission = checkPermissionAnswer(body.sid, body.member, args, target, o.log)
    if (!permission.ok) return { status: permission.status, body: { ok: false, error: permission.error } }
    if (body.member === 'bashCallMatchingOp') {
      const a = (args[0] ?? {}) as { op?: unknown; file?: unknown; taken?: unknown }
      const runsOp = o.commandRunsOp ?? (await import('../../lib/walnut-op-command.js')).commandRunsOp
      const op = String(a.op ?? '')
      const file = typeof a.file === 'string' ? a.file : undefined
      const taken = new Set(Array.isArray(a.taken) ? a.taken.map(String) : [])
      const fn = target.bashCallMatching as ((m: (c: string) => boolean, t: ReadonlySet<string>) => string | undefined) | undefined
      return { status: 200, body: { ok: true, value: jsonValue(fn?.call(target, (c: string) => runsOp(c, op, file), taken)) } }
    }
    if (body.member === 'prepareOutbound') {
      const transport = target.transport as { prepareOutbound?: AnyFn } | null | undefined
      const out = transport?.prepareOutbound ? await transport.prepareOutbound.apply(transport, args) : args[0]
      return { status: 200, body: { ok: true, value: jsonValue(out) } }
    }
    const fn = target[body.member]
    if (typeof fn !== 'function') return { status: 200, body: { ok: false, error: 'no_such_member' } }
    // The sid is the body's (host-calls.ts hostCallArgs): a runner member takes it first.
    const out = await (fn as AnyFn).apply(target, hostCallArgs(body.target, body.sid, args))
    if (body.member === 'markExpectedTeardown') {
      return { status: 200, body: { ok: true, value: typeof out === 'function' ? { undoId: keepUndo(out as () => void) } : null } }
    }
    // A live object found or attached: the leader holds its own proxy, it needs only to know.
    if (body.member === 'getOrAttachLiveSession' || body.member === 'findOrAttachAcpSession') return { status: 200, body: { ok: true, value: { found: !!out } } }
    return { status: 200, body: { ok: true, value: jsonValue(out) } }
  }

  async function serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      if (pathname === HOST_CREDENTIAL_PATH || pathname === HOST_DOORS_PATH) {
        if (!o.credential) { req.resume(); return sendJson(res, 404, { ok: false, error: 'not_found' }) }
        const r = await (pathname === HOST_CREDENTIAL_PATH ? answerCredentialRoute : answerDoorsRoute)(await readJson(req), o.credential)
        return sendJson(res, r.status, r.body)
      }
      const op = pathname.slice(HOST_SESSIONS_PATH.length + 1)
      // The switch decides only where a NEW session runs: a session this host already runs keeps
      // taking its sends, interrupts and calls, and keeps reporting, after the switch went off.
      if (op === 'start' && !(await o.enabled())) { req.resume(); return answerHostSessionsOff(res) }
      const r = await route(op, await readJson(req))
      sendJson(res, r.status, r.body)
    } catch (err) {
      const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500
      o.log?.('warn', 'host sessions: a route failed', { path: pathname, error: errText(err) })
      if (!res.headersSent) sendJson(res, status, { ok: false, error: errText(err) })
    }
  }

  /** One session route (`op` under HOST_SESSIONS_PATH) with its body read: its answer. */
  async function route(op: string, body: unknown): Promise<{ status: number; body: unknown }> {
    if (op === 'start') {
      if (!(await o.enabled())) return { status: 503, body: { ok: false, error: HOST_SESSIONS_OFF } }
      return start(body as StartBody)
    }
    if (op === 'send' || op === 'interrupt') {
      const b = body as { sessionId?: unknown; busSource?: unknown }
      if (typeof b?.sessionId !== 'string' || !b.sessionId) return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      // Only a session this host owns, or one starting here now: an interrupt reaches a process, and a
      // send to a session this host does not have would be queued here for nobody while the leader
      // drops its lines as delivered (round 3 MF2). Refused, the leader keeps them and tries again.
      if (o.owns && !(await o.owns(b.sessionId)) && !(op === 'send' && o.bundles.startingSid(b.sessionId))) {
        return { status: 403, body: { ok: false, error: NOT_OWN_SESSION } }
      }
      const { busSource, queued, holdOnly, ...payload } = b as Record<string, unknown>
      const source = typeof busSource === 'string' && busSource ? busSource : 'host-api'
      // A send's lines are queued here first, as the leader's send route queues them for its own
      // runner: the SESSION_SEND only tells the runner to drain.
      if (op === 'send') {
        const lines = Array.isArray(queued)
          ? (queued as QueuedLine[]).filter((l) => l && typeof l.message === 'string')
          : typeof payload.message === 'string' && payload.message ? [{ message: payload.message }] : []
        if (lines.length > 0) await o.enqueue(b.sessionId, lines, source)
        // Held rows handed over with their hold (sessions/handed-holds.ts): queued, nothing delivered.
        if (holdOnly === true) return { status: 200, body: { ok: true } }
      }
      o.emit(op === 'send' ? 'session:send' : 'session:interrupt', payload, source)
      return { status: 200, body: { ok: true } }
    }
    if (op === 'call') return call(body as CallBody)
    if (op === 'drop') {
      const sids = Array.isArray((body as { sids?: unknown })?.sids) ? ((body as { sids: unknown[] }).sids).filter((x): x is string => typeof x === 'string' && x !== '') : null
      if (!sids || !o.drop) return { status: 400, body: { ok: false, error: 'sids are required' } }
      return { status: 200, body: { ok: true, dropped: await o.drop(sids) } }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  }

  function attach(ws: WebSocket, channel: HostChannel): void {
    const handlers = channel.attach({
      send: (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)) },
      close: (why) => { try { ws.close(1000, (why ?? '').slice(0, 120)) } catch { ws.terminate() } },
    })
    ws.on('message', (raw) => {
      let frame: unknown
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (isChannelFrame(frame)) handlers.onFrame(frame)
    })
    ws.on('close', () => handlers.onClose())
    ws.on('error', () => { /* the close follows */ })
  }

  return {
    handle(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://host').pathname
      if (!isHostSessionsPath(pathname) || pathname === HOST_CHANNEL_PATH) return false
      void serve(req, res, pathname)
      return true
    },
    async call(method, pathname, body) {
      if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
      if (!pathname.startsWith(HOST_SESSIONS_PATH + '/')) return { status: 404, body: { ok: false, error: 'not_found' } }
      try {
        return await route(pathname.slice(HOST_SESSIONS_PATH.length + 1), body)
      } catch (err) {
        o.log?.('warn', 'host sessions: a route failed', { path: pathname, error: errText(err) })
        return { status: 500, body: { ok: false, error: errText(err) } }
      }
    },
    upgrade(req, socket, head) {
      const pathname = new URL(req.url ?? '/', 'http://host').pathname
      if (pathname !== HOST_CHANNEL_PATH) return false
      void Promise.resolve().then(() => {
        const channel = o.channel()
        if (!channel) return refuseChannelUpgrade(socket)
        wss.handleUpgrade(req, socket, head, (ws) => attach(ws, channel))
      }, () => refuseChannelUpgrade(socket))
      return true
    },
    close() {
      for (const c of wss.clients) c.terminate()
      wss.close()
      undos.clear()
    },
  }
}
