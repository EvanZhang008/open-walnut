/**
 * Git smart HTTP endpoint for the cloud data hub.
 *
 * Serves the bare hub repo (<WALNUT_GIT_HUB_DIR>/walnut-data.git) over HTTP by
 * spawning `git http-backend` as a CGI child. This is the missing sync piece
 * for cloud mode: the security group only allows 443/80, so the Mac pushes and
 * pulls the data repo through Caddy → this endpoint instead of SSH.
 *
 * Routes (mounted at /git/data in server.ts, cloud mode only):
 *   GET  /info/refs?service=git-upload-pack|git-receive-pack
 *   POST /git-upload-pack      (fetch/clone)
 *   POST /git-receive-pack     (push)
 *
 * Auth: a device token (src/core/device-auth.ts) presented EITHER as
 * `Authorization: Bearer <token>` OR as the password half of HTTP Basic —
 * git's native scheme (`https://walnut:<token>@host/git/data` or a credential
 * helper; the username is ignored). Missing/invalid credentials get a 401
 * with `WWW-Authenticate: Basic` so the git CLI knows to prompt and retry.
 *
 * Middleware-order contract (see server.ts): this router is mounted BEFORE
 * compression() and express.json(). Git POST bodies are raw binary streams a
 * body parser must not consume, and pack responses must not be re-compressed.
 * Git clients often gzip their request bodies (`Content-Encoding: gzip`);
 * we gunzip in-process before piping to http-backend's stdin so the CGI
 * always sees a plain body (and CONTENT_LENGTH is dropped in that case —
 * http-backend falls back to reading stdin to EOF).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateBearerCredential } from '../middleware/auth.js'
import { recordAuthFailure, isAuthRateLimited } from '../middleware/auth-rate-limit.js'
import { log } from '../../logging/index.js'

/** Fixed repo name inside the hub dir — one data repo per companion box. */
const HUB_REPO_NAME = 'walnut-data.git'

/** Max bytes of CGI header block we are willing to buffer before bailing. */
const MAX_CGI_HEADER_BYTES = 64 * 1024

/** Directory containing the bare hub repo. Read per-request (test-friendly). */
function hubDir(): string {
  return process.env.WALNUT_GIT_HUB_DIR ?? '/var/lib/walnut/git'
}

function requestIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Pull the device token out of the Authorization header. Accepts Bearer
 * (walnut-native) and Basic (git-native; token travels as the password).
 */
function extractCredential(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  if (header.startsWith('Bearer ')) return header.slice(7).trim() || null
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8')
      const colon = decoded.indexOf(':')
      if (colon === -1) return null
      // Username is ignored — the device token is the password.
      return decoded.slice(colon + 1) || null
    } catch {
      return null
    }
  }
  return null
}

/** 401 + Basic challenge — required for the git CLI to prompt/retry with creds. */
function challenge(res: Response): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="walnut-git", charset="UTF-8"')
  res.status(401).type('text/plain').send('Authentication required')
}

/**
 * Router-level auth. The global /api auth middleware does not cover /git,
 * so this router enforces device-token auth itself.
 */
async function gitAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = requestIp(req)
  if (isAuthRateLimited(ip)) {
    log.web.warn('git-http: auth rate limited', { ip })
    res.status(429).type('text/plain').send('Too many authentication failures. Try again later.')
    return
  }

  const credential = extractCredential(req)
  if (!credential) {
    // No credential at all is the NORMAL first leg of the git handshake
    // (anonymous probe → 401 → retry with creds), not an attack — do not
    // count it toward the rate limit or every push would burn budget.
    challenge(res)
    return
  }

  try {
    const cred = await validateBearerCredential(credential)
    if (!cred) {
      recordAuthFailure(ip)
      log.web.warn('git-http: invalid credential', { ip })
      challenge(res)
      return
    }
    ;(req as Request & { gitRemoteUser?: string }).gitRemoteUser = cred.name
    next()
  } catch (err) {
    log.web.error('git-http auth error', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).type('text/plain').send('Internal auth error')
  }
}

/** Find the end of the CGI header block: \r\n\r\n (git's style) or \n\n. */
function findHeaderEnd(buf: Buffer): { idx: number; sepLen: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { idx: crlf, sepLen: 4 }
  if (lf !== -1) return { idx: lf, sepLen: 2 }
  return null
}

/**
 * Spawn `git http-backend` as CGI and bridge req/res:
 *   req body (gunzipped if needed) → stdin
 *   stdout → parse `Status:`/header lines until blank line → stream body to res
 */
function runHttpBackend(req: Request, res: Response, pathInfo: string): void {
  const repoRoot = hubDir()
  if (!fs.existsSync(path.join(repoRoot, HUB_REPO_NAME))) {
    res.status(404).type('text/plain').send('data hub repo not found')
    return
  }

  const qIdx = req.originalUrl.indexOf('?')
  const queryString = qIdx >= 0 ? req.originalUrl.slice(qIdx + 1) : ''
  const remoteUser = (req as Request & { gitRemoteUser?: string }).gitRemoteUser ?? 'walnut-device'
  const gzipped = /\bgzip\b/i.test(String(req.headers['content-encoding'] ?? ''))

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_PROJECT_ROOT: repoRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${HUB_REPO_NAME}${pathInfo}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: queryString,
    // REMOTE_USER also flips http-backend's receive-pack default to "enabled
    // for authenticated users" (we still set http.receivepack=true explicitly
    // in scripts/cloud/setup.sh as belt and braces).
    REMOTE_USER: remoteUser,
    REMOTE_ADDR: requestIp(req),
  }
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') env.CONTENT_TYPE = contentType
  // Only meaningful when we pass the body through untouched; after gunzip the
  // length differs, so drop it and let http-backend read stdin to EOF.
  const contentLength = req.headers['content-length']
  if (!gzipped && typeof contentLength === 'string') env.CONTENT_LENGTH = contentLength
  // Forward protocol v2 negotiation (git client sends `Git-Protocol: version=2`;
  // http-backend maps HTTP_GIT_PROTOCOL → GIT_PROTOCOL for upload-pack).
  const gitProtocol = req.headers['git-protocol']
  if (typeof gitProtocol === 'string') env.HTTP_GIT_PROTOCOL = gitProtocol

  const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] })

  let finished = false
  const fail = (status: number, message: string): void => {
    if (finished) return
    finished = true
    if (!res.headersSent) res.status(status).type('text/plain').send(message)
    else res.end()
    child.kill('SIGKILL')
  }

  child.on('error', (err) => {
    log.web.error('git-http: failed to spawn git http-backend', { error: err.message })
    fail(500, 'git http-backend unavailable')
  })

  // EPIPE on stdin (client aborted mid-body / backend exited early) must not crash.
  child.stdin.on('error', () => {})

  // ── Request body → stdin ──
  if (req.method === 'POST') {
    if (gzipped) {
      const gunzip = zlib.createGunzip()
      gunzip.on('error', (err) => {
        log.web.warn('git-http: bad gzip request body', { error: err.message })
        fail(400, 'invalid gzip request body')
      })
      req.pipe(gunzip).pipe(child.stdin)
    } else {
      req.pipe(child.stdin)
    }
  } else {
    child.stdin.end()
  }

  // ── stdout: CGI headers, then raw pack stream ──
  let headerBuf: Buffer = Buffer.alloc(0)
  let headersDone = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (finished) return
    if (headersDone) {
      // Manual backpressure — we can't use .pipe() because the first chunk(s)
      // were consumed by the header parser.
      if (!res.write(chunk)) {
        child.stdout.pause()
        res.once('drain', () => child.stdout.resume())
      }
      return
    }
    headerBuf = Buffer.concat([headerBuf, chunk])
    const sep = findHeaderEnd(headerBuf)
    if (!sep) {
      if (headerBuf.length > MAX_CGI_HEADER_BYTES) fail(502, 'malformed CGI response from git http-backend')
      return
    }
    let status = 200
    for (const line of headerBuf.subarray(0, sep.idx).toString('utf-8').split(/\r?\n/)) {
      const c = line.indexOf(':')
      if (c === -1) continue
      const name = line.slice(0, c).trim()
      const value = line.slice(c + 1).trim()
      if (name.toLowerCase() === 'status') status = parseInt(value, 10) || 200
      else res.setHeader(name, value)
    }
    res.status(status)
    headersDone = true
    const rest = headerBuf.subarray(sep.idx + sep.sepLen)
    headerBuf = Buffer.alloc(0)
    if (rest.length > 0 && !res.write(rest)) {
      child.stdout.pause()
      res.once('drain', () => child.stdout.resume())
    }
  })

  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-2000)
  })

  child.on('close', (code) => {
    if (finished) return
    finished = true
    if (!headersDone) {
      // Backend died before emitting any CGI headers.
      log.web.error('git-http: http-backend exited before headers', { code, stderr: stderrTail })
      if (!res.headersSent) res.status(502).type('text/plain').send('git http-backend failed')
      else res.end()
      return
    }
    if (code !== 0) {
      log.web.warn('git-http: http-backend nonzero exit', { code, stderr: stderrTail })
    }
    res.end()
  })

  // Client went away — reap the backend so pushes can't leave zombies.
  res.on('close', () => {
    if (!finished) {
      finished = true
      child.kill('SIGKILL')
    }
  })
}

export const gitHttpRouter = Router()
gitHttpRouter.use(gitAuthMiddleware)

// Smart-HTTP discovery: GET /info/refs?service=git-upload-pack|git-receive-pack
gitHttpRouter.get('/info/refs', (req, res) => runHttpBackend(req, res, '/info/refs'))
// Fetch/clone data channel
gitHttpRouter.post('/git-upload-pack', (req, res) => runHttpBackend(req, res, '/git-upload-pack'))
// Push data channel
gitHttpRouter.post('/git-receive-pack', (req, res) => runHttpBackend(req, res, '/git-receive-pack'))
