/**
 * Cloud-replica file-content relay (WALNUT_CLOUD_MODE only).
 *
 * GET /api/v1/file-content on a REPLICA used to answer 501 for any `host=`
 * read ("the bridge has no arbitrary-read channel"). That made every phone
 * file preview through the cloud companion a dead end — including files that
 * live on a host whose daemon is DIRECTLY connected to this box's /bridge.
 *
 * New model (the daemon-principle shape, CLAUDE.md): the daemon does the
 * host-local work — path sandbox (traversal/absolute checks, realpath
 * secret-path denylist) and the 2MB size cap are enforced HOST-SIDE by the
 * narrow `fs.readBounded` bridge command. Raw audio/video uses its guarded
 * 1 MB range branch without a total file-size cap; other formats retain the
 * whole-file cap. This module is the replica-side half: resolve the target host
 * ('' / absent → '__local__', the primary), bridgeRequest the read with a
 * deadline, and map the outcome onto the frozen v1 vocabulary:
 *
 *   daemon EFBIG            → 413 too_large  (friendly "open on your Mac")
 *   bridge down / timeout   → 503 bridge_offline (degraded, never hangs)
 *   old daemon (no command) → 501 not_supported_cloud (self-heals on the
 *                             next primary reconnect via auto-deploy)
 *   daemon EDENIED          → 403 not_supported_cloud
 *
 * A path in the PRIMARY's data dir (`~/.open-walnut/...`) has a git-synced
 * copy on this box: when the primary is offline, too old, or the file is over
 * the cap, that copy answers instead (file-content-replica-copy.ts). The
 * primary's "not found" and "refused" stay final.
 *
 * The replica ALSO pre-checks the obvious denials (traversal, secret paths)
 * to save a round trip — but the daemon is the authority; these checks are a
 * convenience, not the guarantee.
 */

import type { Request, Response } from 'express'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { log } from '../../logging/index.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { sendV1Error } from './v1-control-relay.js'
// ONE source of truth for which extensions ride the raw byte lane (see the
// note next to its use below — a copied table drifted and corrupted bytes).
import { RAW_INLINE_MIME, rawTextMime, attachmentDisposition } from './file-content.js'
import { resolveReplicaCopy } from './file-content-replica-copy.js'
import { BRIDGE_MEDIA_EXTENSIONS, serveBridgeMedia } from './file-content-bridge-media.js'

/** Primary box's daemon always registers under this bridge alias. */
const PRIMARY_BRIDGE_ALIAS = '__local__'

/** Hard cap on file bytes relayed over the bridge — one WS frame, far under
 *  the 32MB maxPayload kill line. MUST match FS_READ_BOUNDED_MAX_BYTES in
 *  both daemon twins. */
export const MAX_BRIDGE_FILE_BYTES = 2 * 1024 * 1024

/** One bounded read = one bridge round trip; a host that can't answer in
 *  this window gets a degraded 503, never a hung route. */
export const FILE_RELAY_TIMEOUT_MS = 15_000

/** JSON viewer payload truncation — same contract as file-content.ts. */
const MAX_TEXT_PAYLOAD = 512 * 1024

/** Resolve the `host=` query param to a bridge alias ('' / absent → primary). */
export function resolveBridgeHost(host: unknown): string {
  return typeof host === 'string' && host.length > 0 ? host : PRIMARY_BRIDGE_ALIAS
}

/** Why a daemon-side bounded read failed, keyed off the twins' error tags. */
export type BridgeReadFailure =
  | { kind: 'needs_upgrade' }
  | { kind: 'too_large' }
  | { kind: 'not_found' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

/** Classify a daemon `{ok:false, error}` reply. Single source of the ladder —
 *  the twins tag errors (EFBIG/ENOENT/EDENIED/…), old daemons answer
 *  'unknown command' or the bridge allowlist's 'not permitted over bridge'. */
export function classifyBridgeReadFailure(reason: string): BridgeReadFailure {
  if (reason.startsWith('unknown command') || reason.includes('not permitted over bridge')) {
    return { kind: 'needs_upgrade' }
  }
  if (reason.includes('(EFBIG)')) return { kind: 'too_large' }
  if (reason.includes('(ENOENT)') || reason.includes('(ENOTFILE)') || reason.includes('(ENOTDIR)')) {
    return { kind: 'not_found' }
  }
  if (reason.includes('(EDENIED)') || reason.includes('(EACCES)') || reason.includes('(EPERM)')) {
    return { kind: 'denied' }
  }
  return { kind: 'error', message: reason }
}

const FRIENDLY_TOO_LARGE =
  'File is too large to preview through the cloud companion (max 2 MB) — open it on your Mac.'
const FRIENDLY_NEEDS_UPGRADE =
  "File previews aren't available from this host yet — its daemon upgrades automatically on the next reconnect. Try again in a minute."

// ── Raw-mode content types ──────────────────────────────────────────────────
// RAW_INLINE_MIME is IMPORTED from file-content.ts (top of this file), not
// copied: it used to be a hand-maintained twin and silently fell behind when
// office types were added there. Drift is not cosmetic — an extension missing
// from the table falls to the text lane below, which utf-8-decodes the bytes
// and hands the client a mangled zip that looks like a corrupt document.
// Raw media uses the guarded range lane. Other formats keep the whole-file cap.

/** Detect binary content by scanning for NUL bytes in the first 8KB. */
function isBinaryBuffer(buffer: Buffer): boolean {
  const scanLen = Math.min(buffer.length, 8192)
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/** Result of one bounded bridge read. */
export type BridgeReadResult =
  | { status: 'ok'; buf: Buffer }
  | { status: 'failed'; failure: BridgeReadFailure }
  | { status: 'offline'; message: string }

/** One fs.readBounded round trip with the relay deadline. Never throws. */
async function bridgeReadFile(hostAlias: string, filePath: string): Promise<BridgeReadResult> {
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  let reply: Record<string, unknown>
  const startedAt = Date.now()
  try {
    reply = await bridgeRequest(hostAlias, 'fs.readBounded', { path: filePath }, FILE_RELAY_TIMEOUT_MS)
  } catch (err) {
    // Bridge down AND request timeout both degrade to "host unreachable" —
    // the phone's remedy is identical (wait for the host to reconnect).
    const message = err instanceof BridgeOfflineError
      ? `No live bridge for host: ${hostAlias}`
      : (err instanceof Error ? err.message : String(err))
    log.web.warn('cloud file-content relay failed (bridge)', {
      host: hostAlias, path: filePath, error: message, ms: Date.now() - startedAt,
    })
    return { status: 'offline', message }
  }
  if (reply.ok !== true || typeof reply.data !== 'string') {
    const reason = String(reply.error ?? 'unknown daemon error')
    log.web.info('cloud file-content relay refused by daemon', {
      host: hostAlias, path: filePath, reason, ms: Date.now() - startedAt,
    })
    return { status: 'failed', failure: classifyBridgeReadFailure(reason) }
  }
  const buf = Buffer.from(reply.data, 'base64')
  // Replica-side backstop for the daemon's own cap (a stale twin must not
  // push an oversized frame onward to the phone).
  if (buf.length > MAX_BRIDGE_FILE_BYTES) {
    return { status: 'failed', failure: { kind: 'too_large' } }
  }
  log.web.info('cloud file-content relay served', {
    host: hostAlias, path: filePath, size: buf.length, ms: Date.now() - startedAt,
  })
  return { status: 'ok', buf }
}

/**
 * Replica-side pre-checks (convenience, not the guarantee — the daemon
 * re-checks everything host-side). Returns the normalized path or null after
 * answering the response itself.
 */
function precheckPath(res: Response, rawPath: unknown): string | null {
  if (!rawPath || typeof rawPath !== 'string') {
    sendV1Error(res, 400, 'bad_request', 'Missing or invalid path parameter')
    return null
  }
  if (rawPath.includes('..')) {
    sendV1Error(res, 400, 'bad_request', 'Invalid path')
    return null
  }
  // `~`/`~/…` stays as-is (the daemon expands it against the HOST's home);
  // anything else must be absolute.
  if (rawPath !== '~' && !rawPath.startsWith('~/') && !path.isAbsolute(rawPath)) {
    sendV1Error(res, 400, 'bad_request', 'Path must be absolute')
    return null
  }
  return rawPath
}

/** Map a failed/offline read onto the response. JSON mode keeps the viewer
 *  contract (not-found and transport failures are 200 payloads with `error`
 *  set); everything else uses the frozen v1 error envelope. */
function answerFailure(
  res: Response,
  result: Exclude<BridgeReadResult, { status: 'ok' }>,
  mode: 'json' | 'raw',
  ext: string,
): void {
  if (result.status === 'offline') {
    sendV1Error(res, 503, 'bridge_offline', `The file's host isn't reachable right now — try again when it reconnects (${result.message})`)
    return
  }
  const f = result.failure
  switch (f.kind) {
    case 'needs_upgrade':
      sendV1Error(res, 501, 'not_supported_cloud', FRIENDLY_NEEDS_UPGRADE)
      return
    case 'too_large':
      sendV1Error(res, 413, 'too_large', FRIENDLY_TOO_LARGE)
      return
    case 'denied':
      sendV1Error(res, 403, 'not_supported_cloud', 'Path not permitted')
      return
    case 'not_found':
      if (mode === 'json') {
        // Legacy viewer contract: missing files are 200 with `error` set.
        res.json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: ext })
      } else {
        res.status(404).type('text/plain').send('File not found')
      }
      return
    case 'error':
      if (mode === 'json') {
        res.json({ content: null, size: 0, truncated: false, binary: false, error: `Cannot read file on host: ${f.message}`, extension: ext })
      } else {
        sendV1Error(res, 502, 'bad_gateway', `Cannot read file on host: ${f.message}`)
      }
      return
  }
}

/**
 * Serve GET /api/v1/file-content on a CLOUD replica — both the JSON viewer
 * payload and `raw=1` byte mode.
 *
 * Two lanes:
 * - A no-host path inside the replica's OWN safe roots (/tmp/open-walnut
 *   stream mirrors) keeps the pre-relay behavior: served from local disk by
 *   the shared core (which applies its own CLOUD_MODE confinement).
 * - Everything else relays to the target host's daemon over the bridge
 *   ('' / absent → the primary '__local__') via the bounded fs.readBounded.
 */
export async function serveCloudFileContent(req: Request, res: Response): Promise<void> {
  const filePath = precheckPath(res, req.query.path)
  if (filePath === null) return
  const hostAlias = resolveBridgeHost(req.query.host)
  const raw = req.query.raw === '1' || req.query.raw === 'true'
  const download = req.query.download === '1' || req.query.download === 'true'
  const ext = path.extname(filePath).slice(1).toLowerCase()

  const {
    assertPathAllowed, isSecretPath, cloudLocalReadAllowed,
    readFileContentPayload, serveRawFileContent, FileContentError,
  } = await import('./file-content.js')

  // Lane 1: replica-local safe-root read (no host targeting) — unchanged
  // pre-relay behavior, shared core sandbox included. Only when the file is
  // actually PRESENT here: the primary owns the canonical /tmp/open-walnut
  // contents (e.g. attached images), so a locally-missing path falls through
  // to the bridge instead of answering a false "File not found".
  const explicitHost = typeof req.query.host === 'string' && req.query.host.length > 0
  const locallyPresent = await fsp.stat(filePath).then((st) => st.isFile()).catch(() => false)
  if (!explicitHost && locallyPresent && cloudLocalReadAllowed(filePath) && !isSecretPath(filePath)) {
    try {
      if (raw) {
        await serveRawFileContent(req, res, filePath, undefined, download)
      } else {
        res.json(await readFileContentPayload(filePath, undefined))
      }
    } catch (err) {
      if (err instanceof FileContentError) {
        sendV1Error(res, err.statusCode, err.statusCode === 403 ? 'not_supported_cloud' : 'bad_request', err.message)
        return
      }
      throw err
    }
    return
  }

  // Lane 2: bridge relay. Cheap replica-side pre-checks first (the daemon
  // re-checks everything host-side with the TARGET host's homedir — these
  // only save a round trip for pattern-based refusals).
  try {
    // A non-empty host means isRemote inside assertPathAllowed: the local
    // safe-root confinement is skipped (this read runs on the TARGET host's
    // daemon), while the traversal guard stays.
    assertPathAllowed(filePath, hostAlias, 'read')
  } catch (err) {
    if (err instanceof FileContentError) {
      sendV1Error(res, err.statusCode, err.statusCode === 403 ? 'not_supported_cloud' : 'bad_request', err.message)
      return
    }
    throw err
  }
  if (isSecretPath(filePath)) {
    sendV1Error(res, 403, 'not_supported_cloud', 'Path not permitted')
    return
  }

  const media = raw && BRIDGE_MEDIA_EXTENSIONS.has(ext)
  const result = media
    ? await serveBridgeMedia(req, res, hostAlias, filePath, RAW_INLINE_MIME[ext]!, download)
    : await bridgeReadFile(hostAlias, filePath)
  if (result === null) return // Media stream (including disconnect) handled its response.
  if (result.status !== 'ok') {
    if (hostAlias === PRIMARY_BRIDGE_ALIAS && copyMayAnswer(result)) {
      const copy = await resolveReplicaCopy(filePath)
      if (copy) {
        await serveReplicaCopy(req, res, filePath, copy, { raw, download, ext, why: failureLabel(result) })
        return
      }
    }
    answerFailure(res, result, raw ? 'raw' : 'json', ext)
    return
  }
  const buf = result.buf

  if (raw) {
    // hasOwn guard: a file named e.g. "x.constructor" must not hit Object.prototype.
    const inlineType = Object.hasOwn(RAW_INLINE_MIME, ext) ? RAW_INLINE_MIME[ext] : undefined
    if (download || inlineType) {
      res.status(200).set({
        'Content-Type': inlineType ?? 'application/octet-stream',
        'Content-Length': String(buf.length),
        ...(download ? { 'Content-Disposition': attachmentDisposition(filePath) } : {}),
      })
      res.end(buf)
      return
    }
    const ctype = rawTextMime(ext)
    res.type(ctype).send(buf.toString('utf-8'))
    return
  }

  res.json(jsonPayloadFromBuffer(buf, ext, true))
}

/** JSON viewer payload — same shape/truncation contract as the shared core. */
function jsonPayloadFromBuffer(buf: Buffer, ext: string, withHash: boolean): Record<string, unknown> {
  if (isBinaryBuffer(buf)) {
    return { content: null, size: buf.length, truncated: false, binary: true, extension: ext }
  }
  const content = buf.toString('utf-8')
  const truncated = content.length > MAX_TEXT_PAYLOAD
  return {
    content: truncated ? content.slice(0, MAX_TEXT_PAYLOAD) : content,
    size: content.length,
    truncated,
    binary: false,
    extension: ext,
    // Only a WHOLE read gets a hash (the editor's optimistic-lock token).
    ...(truncated || !withHash ? {} : { contentHash: computeContentHash(content) }),
  }
}

/** The primary could not, or would not, send the bytes: the synced copy may. A
 *  "not there" or "refused" answer from the primary is final. */
function copyMayAnswer(result: Exclude<BridgeReadResult, { status: 'ok' }>): boolean {
  if (result.status === 'offline') return true
  return result.failure.kind === 'too_large' || result.failure.kind === 'needs_upgrade'
}

function failureLabel(result: Exclude<BridgeReadResult, { status: 'ok' }>): string {
  return result.status === 'offline' ? 'primary_offline' : result.failure.kind
}

/**
 * Answer from this replica's git-synced copy of the primary's data dir. Raw
 * mode streams with Range support (no 2 MB cap: the bytes never cross the
 * bridge). The JSON payload carries no contentHash: a copy that may trail the
 * primary by one sync must never become an editor's write token.
 */
async function serveReplicaCopy(
  req: Request,
  res: Response,
  requestPath: string,
  copy: { localPath: string; size: number },
  opts: { raw: boolean; download: boolean; ext: string; why: string },
): Promise<void> {
  log.web.info('cloud file-content served from the synced copy', {
    path: requestPath, size: copy.size, why: opts.why,
  })
  res.set('X-Walnut-Served-From', 'replica-copy')
  if (opts.raw) {
    const { serveRawBytes } = await import('./file-content.js')
    const inlineType = Object.hasOwn(RAW_INLINE_MIME, opts.ext) ? RAW_INLINE_MIME[opts.ext] : undefined
    const ctype = opts.download || inlineType ? (inlineType ?? 'application/octet-stream') : rawTextMime(opts.ext)
    await serveRawBytes(req, res, copy.localPath, undefined, ctype, opts.download)
    return
  }
  if (copy.size <= MAX_BRIDGE_FILE_BYTES) {
    res.json(jsonPayloadFromBuffer(await fsp.readFile(copy.localPath), opts.ext, false))
    return
  }
  // Large file: the viewer only ever shows the first MAX_TEXT_PAYLOAD chars.
  const fh = await fsp.open(copy.localPath, 'r')
  try {
    const head = Buffer.alloc(MAX_TEXT_PAYLOAD)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const buf = head.subarray(0, bytesRead)
    if (isBinaryBuffer(buf)) {
      res.json({ content: null, size: copy.size, truncated: false, binary: true, extension: opts.ext })
      return
    }
    res.json({
      content: buf.toString('utf-8').replace(/\uFFFD+$/, ''),
      size: copy.size,
      truncated: true,
      binary: false,
      extension: opts.ext,
    })
  } finally {
    await fh.close()
  }
}
