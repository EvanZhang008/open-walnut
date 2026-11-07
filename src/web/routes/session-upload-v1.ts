/**
 * PUT /api/v1/sessions/:id/uploads/:uploadId?offset=&size=&name=&sha256=
 *
 * One chunk (raw bytes, at most UPLOAD_CHUNK_BYTES) of a file a phone attaches
 * to a session. The server only relays: the session's host writes it through
 * its daemon's `upload.part` (transfer-core.ts uploadPart), which picks the
 * path (the task's own directory) and checks the id and name itself.
 *
 * - Primary box, and a session the companion runs itself: the host's daemon
 *   connection ('__local__' for this machine).
 * - Companion, a session on another machine: the bridge to that host.
 * - PUT /api/v1/uploads/:uploadId (no session yet): the Mac's daemon, over the
 *   bridge on the companion (putLocalUploadChunk says why).
 *
 * Resumable: a chunk the host already holds is acknowledged without writing, a
 * chunk past what it holds answers 409 `upload_offset_mismatch` with `received`
 * (send from there), offset 0 starts over. The chunk that reaches `size` is the
 * last: the host checks `sha256` and answers `path`. See session-uploads.ts.
 */

import express, { type Request, type Response, type NextFunction } from 'express'
import { WALNUT_HOME } from '../../constants.js'
import { isCompanion } from '../../core/server-role.js'
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, UPLOAD_ID_RE, isUploadName } from '../../core/sessions/session-uploads.js'
import type { WritePartReply } from '../../providers/transfer-core.js'
import { sendError } from './cloud-send-words.js'
import { log } from '../../logging/index.js'

const SID_RE = /^[A-Za-z0-9_-]+$/
const SHA_RE = /^[0-9a-f]{64}$/
/** Per chunk over the bridge: a 2 MB part is ~2.7 MB of base64 in one frame. */
const BRIDGE_PART_TIMEOUT_MS = 60_000

const rawChunk = express.raw({ type: () => true, limit: UPLOAD_CHUNK_BYTES + 1024 })

/** The raw body, capped just above one chunk; a parser failure answers in the contract's shape. */
export function uploadChunkBody(req: Request, res: Response, next: NextFunction): void {
  rawChunk(req, res, (err?: unknown) => {
    if (!err) { next(); return }
    const e = err as { type?: string }
    if (e?.type === 'entity.too.large') sendError(res, 413, 'too_large', `A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes`)
    else sendError(res, 400, 'bad_request', 'The chunk could not be read')
  })
}

/** A refusal from the host, as the daemon names it. */
class HostRefusal extends Error {
  constructor(public code: string, message: string, public data: Record<string, unknown> = {}) { super(message) }
}
class NeedsUpgrade extends Error {}
class HostOffline extends Error {}

function intParam(v: unknown, max: number): number | null {
  if (typeof v !== 'string' || !/^\d{1,13}$/.test(v)) return null
  const n = Number(v)
  return n <= max ? n : null
}

interface Part { uploadId: string; name: string; size: number; offset: number; data: Buffer; sha256?: string }

/** The bridge path: the companion relays to the host the session runs on. */
async function viaBridge(sessionId: string, part: Part): Promise<WritePartReply> {
  const { resolveCloudSessionHost, PrimaryUnreachableError } = await import('../../core/sessions/cloud-session-host.js')
  let projected
  try {
    projected = await resolveCloudSessionHost(sessionId)
  } catch (err) {
    if (err instanceof PrimaryUnreachableError) throw new HostOffline(err.message)
    throw err
  }
  if (!projected) throw new HostRefusal('not_found', `Session not found: ${sessionId}`)
  // The host files it under the task IT started this session for.
  return bridgePart(projected.host, part, { sessionId })
}

/** One chunk over the bridge to `host`'s daemon, every failure named the contract's way. */
async function bridgePart(host: string, part: Part, extra: { sessionId?: string }): Promise<WritePartReply> {
  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  let res: Record<string, unknown>
  try {
    res = await bridgeRequest(host, 'upload.part', {
      uploadId: part.uploadId, name: part.name, size: part.size, offset: part.offset,
      data: part.data.toString('base64'), ...(part.sha256 ? { sha256: part.sha256 } : {}),
      ...extra,
    }, BRIDGE_PART_TIMEOUT_MS)
  } catch (err) {
    // No bridge, a timeout, a link that closed mid-chunk: all retry the chunk.
    throw new HostOffline(err instanceof Error ? err.message : String(err))
  }
  if (res.ok === true) return res as unknown as WritePartReply
  const error = String(res.error ?? 'upload.part failed')
  // An older daemon: no such command, or not on its bridge allowlist yet.
  if (error.startsWith('unknown command') || error.startsWith('command not permitted over bridge')) throw new NeedsUpgrade(error)
  const { ok: _ok, id: _id, error: _e, code, ...data } = res
  throw new HostRefusal(typeof code === 'string' ? code : 'failed', error.replace('upload.part failed: ', ''), data)
}

/** The daemon path: this machine's daemon, or the session's host over its tunnel. */
async function viaDaemon(sessionId: string, part: Part): Promise<WritePartReply> {
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) throw new HostRefusal('not_found', `Session not found: ${sessionId}`)
  return toHost(record.host || '__local__', part, { ...(record.taskId ? { taskId: record.taskId } : {}), sessionId })
}

/** One chunk onto `host` through its daemon connection, every failure named the contract's way. */
async function toHost(host: string, part: Part, owner: { taskId?: string; sessionId?: string }): Promise<WritePartReply> {
  const client = await import('../../core/transfer/daemon-transfer-client.js')
  const { DaemonNeedsUpgradeError } = await import('../../core/daemon-file-reader.js')
  try {
    return await client.uploadPart(host, {
      uploadId: part.uploadId, name: part.name, size: part.size, offset: part.offset, data: part.data,
      ...(part.sha256 ? { sha256: part.sha256 } : {}), ...owner, home: WALNUT_HOME,
    })
  } catch (err) {
    if (err instanceof DaemonNeedsUpgradeError) throw new NeedsUpgrade(err.message)
    if (err instanceof client.TransferHostOfflineError) throw new HostOffline(err.message)
    if (err instanceof client.TransferCommandError) throw new HostRefusal(err.code, err.message, err.data)
    // A timeout or a link that went away mid-chunk: retry the chunk.
    throw new HostOffline(err instanceof Error ? err.message : String(err))
  }
}

/** The chunk a request carries, or null after answering why it cannot be taken. */
function partOf(req: Request, res: Response): Part | null {
  const uploadId = String(req.params.uploadId ?? '')
  if (!UPLOAD_ID_RE.test(uploadId)) {
    sendError(res, 400, 'bad_request', 'Invalid upload id')
    return null
  }
  const name = req.query.name
  if (!isUploadName(name)) {
    sendError(res, 400, 'bad_request', 'name must be a plain file name (no slash, no leading dot, at most 200 bytes)')
    return null
  }
  const size = intParam(req.query.size, Number.MAX_SAFE_INTEGER)
  const offset = intParam(req.query.offset, Number.MAX_SAFE_INTEGER)
  const sha = typeof req.query.sha256 === 'string' && req.query.sha256 !== '' ? req.query.sha256.toLowerCase() : undefined
  if (size === null || offset === null || (sha !== undefined && !SHA_RE.test(sha))) {
    sendError(res, 400, 'bad_request', 'size and offset must be whole numbers; sha256 is 64 hex characters')
    return null
  }
  if (size > MAX_UPLOAD_BYTES) {
    sendError(res, 413, 'too_large', `A file can be at most ${MAX_UPLOAD_BYTES / 1024 ** 3} GB`)
    return null
  }
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (data.length > UPLOAD_CHUNK_BYTES) {
    sendError(res, 413, 'too_large', `A chunk can be at most ${UPLOAD_CHUNK_BYTES} bytes`)
    return null
  }
  if (offset + data.length > size) {
    sendError(res, 400, 'bad_request', 'The chunk ends past the file size')
    return null
  }
  return { uploadId, name, size, offset, data, ...(sha ? { sha256: sha } : {}) }
}

function answerReply(res: Response, part: Part, reply: WritePartReply): void {
  res.json({ received: reply.staged, size: part.size, done: reply.done === true, ...(reply.done && reply.path ? { path: reply.path } : {}) })
}

export async function putSessionUploadChunk(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = String(req.params.id ?? '')
    if (!SID_RE.test(sessionId)) {
      sendError(res, 400, 'bad_request', 'Invalid session or upload id')
      return
    }
    const part = partOf(req, res)
    if (!part) return
    const relayed = isCompanion() && !(await (await import('../../core/cloud-owned-session.js')).cloudOwnedSession(sessionId))
    let reply: WritePartReply
    try {
      reply = relayed ? await viaBridge(sessionId, part) : await viaDaemon(sessionId, part)
    } catch (err) {
      answerFailure(res, sessionId, part, err)
      return
    }
    if (reply.done) {
      log.web.info('session upload complete', { sessionId, uploadId: part.uploadId, size: part.size, relayed })
    }
    answerReply(res, part, reply)
  } catch (err) {
    next(err)
  }
}

/**
 * PUT /api/v1/uploads/:uploadId: the same chunk contract for a file that has no
 * session yet (the first message of a new session, Main's chat on the phone).
 * It lands on the Mac, in the folder beside the task directories; a session that
 * then runs on another host gets the file through
 * RemoteSessionManager.prepareOutbound, which ships such paths there.
 *
 * The companion never keeps such a file on its own disk. The session it is for
 * is started by the Mac (POST /sessions waits for the Mac), which reads the path
 * on its own disk; and the chunks of one upload split between the two servers
 * (a chunk over MAX_FORWARD_REQUEST_BYTES stays on the companion, a smaller last
 * one is forwarded to the Mac), so writing here would leave half a file on each.
 * It hands the chunk to the Mac's daemon over the bridge instead ('__local__',
 * the same lane a Mac session's upload takes), which files it where the Mac's
 * own route does. The Mac being away answers 503 bridge_offline, which the
 * client retries.
 */
export async function putLocalUploadChunk(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const part = partOf(req, res)
    if (!part) return
    let reply: WritePartReply
    try {
      reply = isCompanion() ? await bridgePart('__local__', part, {}) : await toHost('__local__', part, {})
    } catch (err) {
      answerFailure(res, '', part, err)
      return
    }
    if (reply.done) log.web.info('upload complete', { uploadId: part.uploadId, size: part.size })
    answerReply(res, part, reply)
  } catch (err) {
    next(err)
  }
}

function answerFailure(res: Response, sessionId: string, part: Part, err: unknown): void {
  if (err instanceof NeedsUpgrade) {
    sendError(res, 400, 'files_need_daemon_upgrade',
      "This session's host runs a Walnut daemon that cannot take files yet. It upgrades on its own the next time your Mac connects to it.")
    return
  }
  if (err instanceof HostOffline) {
    sendError(res, 503, 'bridge_offline', err.message)
    return
  }
  if (!(err instanceof HostRefusal)) throw err
  const have = typeof err.data.have === 'number' ? err.data.have : undefined
  switch (err.code) {
    case 'not_found': sendError(res, 404, 'not_found', err.message); return
    case 'gap':
    case 'size_mismatch':
      res.status(409).json({ error: { code: 'upload_offset_mismatch', message: err.message, received: Math.max(0, have ?? 0) } })
      return
    case 'checksum_mismatch':
      res.status(422).json({ error: { code: 'upload_checksum_mismatch', message: 'The file arrived different from what was sent. Send it again from the start.' } })
      return
    case 'no_space':
      sendError(res, 507, 'host_disk_full', "The session's host does not have room for this file.")
      return
    case 'too_large': sendError(res, 413, 'too_large', err.message); return
    case 'bad_request': sendError(res, 400, 'bad_request', err.message); return
    default:
      log.web.warn('session upload chunk failed on the host', { sessionId, uploadId: part.uploadId, code: err.code, error: err.message })
      sendError(res, 502, 'upload_failed', `The session's host could not save the file (${err.message}).`)
  }
}
