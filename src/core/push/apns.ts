/**
 * APNs sender — token-based auth (ES256 JWT) over HTTP/2 to Apple.
 *
 * WHY this replaced the Expo path: the iOS app is native SwiftUI with no Expo
 * runtime, so it can never mint an `ExponentPushToken[...]`. `exp.host` only
 * accepts those, which made the old sender structurally dead — it would have
 * rejected every token the real app can produce. The app registers with APNs
 * directly and hands us a raw hex device token, so we talk to Apple directly.
 *
 * CREDENTIAL BOUNDARY (read this before debugging "no push arrived"): sending
 * needs an **APNs auth key**, which is NOT the App Store Connect API key used
 * for TestFlight uploads. Both are `.p8` files and look identical on disk, but
 * they live in different key namespaces: an ASC key presented to APNs is
 * rejected with `403 InvalidProviderToken`. Until an APNs key is configured,
 * every send here degrades honestly — a logged reason plus a `configured:false`
 * status on `GET /api/push/status` — and never throws into a caller's event
 * handler. Setup steps: docs/reference/ios-push-notifications.md.
 *
 * Runs on the PRIMARY only. Letters live on the primary (a replica relays every
 * human-inbox route there), so the primary's store is the sole producer of
 * letter events and therefore the sole sender — which is also the box the key
 * sits on. See src/web/routes/push.ts for how a replica forwards registrations.
 */

import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { getConfig } from '../config-manager.js'
import { log } from '../../logging/index.js'

/** The app's bundle id — the APNs topic, unless overridden. */
export const DEFAULT_APNS_TOPIC = 'dev.openwalnut.ios'

export type ApnsEnvironment = 'production' | 'sandbox'

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

/**
 * A send must never pin the event loop or a caller's turn. Apple's own p99 is
 * well under a second; anything past this is a network problem, not a slow push.
 */
const SEND_TIMEOUT_MS = 10_000

/** Apple caps a provider token's life at 1h; refresh early so none goes stale mid-send. */
const JWT_TTL_MS = 45 * 60 * 1000

export interface ApnsCredential {
  keyId: string
  teamId: string
  /** PEM/PKCS#8 private key text read from the AuthKey_*.p8 file. */
  privateKey: string
  topic: string
}

/** Why a send can't happen, in words a human can act on. */
export interface ApnsStatus {
  configured: boolean
  reason?: string
  environment: ApnsEnvironment
  topic: string
  /** Last send failure, so a silent-push report has something to look at. */
  lastError?: { at: string; message: string }
}

let lastError: { at: string; message: string } | undefined
/** The missing-credential warning is logged once per process, not once per letter. */
let warnedMissing = false

export function recordApnsError(message: string): void {
  lastError = { at: new Date().toISOString(), message }
}

interface ApnsSettings {
  keyId?: string
  teamId?: string
  keyPath?: string
  topic: string
  environment: ApnsEnvironment
}

/**
 * Resolve APNs settings from config, with env-var overrides.
 *
 * The private KEY never goes in config — only a path to it. Config is a file
 * other machines can end up holding; a signing key that can push to every
 * paired device is not something to copy around by accident.
 */
async function settings(): Promise<ApnsSettings> {
  let fromConfig: Record<string, unknown> = {}
  try {
    const config = await getConfig() as { push?: { apns?: Record<string, unknown> } }
    fromConfig = config.push?.apns ?? {}
  } catch {
    // A config read failure must not turn into a thrown push — fall through to
    // env vars and let the missing-credential path report it.
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const env = process.env
  const rawEnvironment = str(env.WALNUT_APNS_ENV) ?? str(fromConfig.environment)
  return {
    keyId: str(env.WALNUT_APNS_KEY_ID) ?? str(fromConfig.key_id),
    teamId: str(env.WALNUT_APNS_TEAM_ID) ?? str(fromConfig.team_id),
    keyPath: str(env.WALNUT_APNS_KEY_PATH) ?? str(fromConfig.key_path),
    topic: str(env.WALNUT_APNS_TOPIC) ?? str(fromConfig.topic) ?? DEFAULT_APNS_TOPIC,
    environment: rawEnvironment === 'sandbox' ? 'sandbox' : 'production',
  }
}

/** Cache the key file so a burst of letters doesn't re-read it per push. */
let keyCache: { path: string; pem: string } | undefined

async function loadCredential(s: ApnsSettings): Promise<ApnsCredential | { error: string }> {
  if (!s.keyId || !s.teamId || !s.keyPath) {
    const missing = [
      !s.keyId && 'key_id',
      !s.teamId && 'team_id',
      !s.keyPath && 'key_path',
    ].filter(Boolean).join(', ')
    return {
      error: `APNs auth key not configured (missing ${missing}). This is a DIFFERENT key from the `
        + 'App Store Connect API key used for TestFlight uploads — see '
        + 'docs/reference/ios-push-notifications.md',
    }
  }
  if (keyCache?.path !== s.keyPath) {
    try {
      const pem = await readFile(s.keyPath, 'utf-8')
      if (!pem.includes('PRIVATE KEY')) {
        return { error: `APNs key at ${s.keyPath} is not a PEM private key` }
      }
      keyCache = { path: s.keyPath, pem }
    } catch (err) {
      return {
        error: `APNs key unreadable at ${s.keyPath}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  return { keyId: s.keyId, teamId: s.teamId, privateKey: keyCache.pem, topic: s.topic }
}

/** Current sender status — what `GET /api/push/status` reports. */
export async function apnsStatus(): Promise<ApnsStatus> {
  const s = await settings()
  const cred = await loadCredential(s)
  const base = { environment: s.environment, topic: s.topic, ...(lastError ? { lastError } : {}) }
  if ('error' in cred) return { configured: false, reason: cred.error, ...base }
  return { configured: true, ...base }
}

// ── Provider token (JWT) ──

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let jwtCache: { key: string; token: string; expiresAt: number } | undefined

/**
 * Sign an APNs provider token.
 *
 * Two details that silently break this if changed: the signature must be raw
 * R||S (`ieee-p1363`), not the DER encoding `createSign` emits by default —
 * Apple answers `403 InvalidProviderToken` for DER, which reads exactly like a
 * wrong key. And `iss` is the TEAM id while `kid` is the KEY id; an ASC-style
 * JWT (issuer id in `iss`, an `aud` claim) is rejected the same way.
 */
export function signProviderToken(cred: ApnsCredential, now = Date.now()): string {
  // The cache key includes the KEY MATERIAL, not just its ids. Rotating a key in
  // place (same key id, new file) is exactly the recovery step the setup doc
  // tells the user to take, and a cache keyed on ids alone would keep signing
  // with the old key for the full 45-minute TTL.
  const cacheKey = `${cred.keyId}:${cred.teamId}:${cred.privateKey.length}:${cred.privateKey.slice(-24)}`
  if (jwtCache?.key === cacheKey && jwtCache.expiresAt > now) return jwtCache.token

  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cred.keyId, typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: cred.teamId, iat: Math.floor(now / 1000) }))
  const signer = createSign('SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign({ key: cred.privateKey, dsaEncoding: 'ieee-p1363' })
  const token = `${header}.${payload}.${b64url(signature)}`

  jwtCache = { key: cacheKey, token, expiresAt: now + JWT_TTL_MS }
  return token
}

/** Drop the cached provider token — used when Apple rejects it as expired. */
function invalidateProviderToken(): void { jwtCache = undefined }

// ── HTTP/2 transport ──

/**
 * One HTTP/2 session per environment, reused across pushes. APNs explicitly
 * asks providers to keep a connection open rather than reconnect per
 * notification, and a fresh TLS handshake per letter would dominate the latency.
 */
const sessions = new Map<ApnsEnvironment, ClientHttp2Session>()

function session(environment: ApnsEnvironment): ClientHttp2Session {
  const existing = sessions.get(environment)
  if (existing && !existing.closed && !existing.destroyed) return existing
  const next = connect(HOSTS[environment])
  // Only evict THIS session. An unconditional delete on a late 'close' would
  // evict whatever live successor had already replaced it in the map, leaking
  // the successor and reconnecting on every subsequent push.
  const evict = (): void => { if (sessions.get(environment) === next) sessions.delete(environment) }
  // A dead session must not be handed to the next push. Errors are recorded and
  // swallowed: an unhandled 'error' on an http2 session takes the process down,
  // and a push failure is never worth the server.
  next.on('error', (err) => {
    recordApnsError(`APNs connection error: ${err.message}`)
    log.notif.warn('apns: session error', { environment, error: err.message })
    evict()
  })
  next.on('close', evict)
  // Nothing should keep the process alive for an idle push connection.
  next.unref()
  sessions.set(environment, next)
  return next
}

/**
 * Drop a session that timed out.
 *
 * A half-open connection (Wi-Fi to LTE, a captive portal) emits NEITHER 'error'
 * nor 'close', so it stays `closed:false destroyed:false` and the pool keeps
 * handing it out: one timeout would otherwise poison every later push until the
 * process restarts. Closing the timed-out STREAM is not enough — the session
 * itself has to go.
 */
function discardSession(environment: ApnsEnvironment): void {
  const dead = sessions.get(environment)
  if (!dead) return
  sessions.delete(environment)
  try { dead.destroy() } catch { /* already gone */ }
}

/** Close the pooled connections (tests + shutdown). */
export function closeApnsSessions(): void {
  for (const [, s] of sessions) { try { s.close() } catch { /* already gone */ } }
  sessions.clear()
  jwtCache = undefined
  keyCache = undefined
}

export interface ApnsSendResult {
  /** Delivered to Apple (2xx). */
  ok: boolean
  status?: number
  /** Apple's machine-readable reason, e.g. 'BadDeviceToken', 'Unregistered'. */
  reason?: string
  /** True when this token is dead and should be dropped from config. */
  unregistered?: boolean
  error?: string
}

/** One notification to one device token. */
async function sendOne(
  cred: ApnsCredential,
  environment: ApnsEnvironment,
  deviceToken: string,
  payload: Record<string, unknown>,
  priority: number,
  collapseId?: string,
): Promise<ApnsSendResult> {
  const body = JSON.stringify(payload)
  return await new Promise<ApnsSendResult>((resolve) => {
    let settled = false
    const done = (r: ApnsSendResult): void => { if (!settled) { settled = true; resolve(r) } }
    let stream: ReturnType<ClientHttp2Session['request']>
    try {
      stream = session(environment).request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        authorization: `bearer ${signProviderToken(cred)}`,
        'apns-topic': cred.topic,
        'apns-push-type': 'alert',
        'apns-priority': String(priority),
        // Apple caps this at 64 bytes and rejects the whole request if longer.
        ...(collapseId ? { 'apns-collapse-id': collapseId.slice(0, 64) } : {}),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
    } catch (err) {
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }

    const timer = setTimeout(() => {
      try { stream.close() } catch { /* already closing */ }
      // The session is presumed half-open — see discardSession.
      discardSession(environment)
      done({ ok: false, error: `APNs send timed out after ${SEND_TIMEOUT_MS}ms` })
    }, SEND_TIMEOUT_MS)
    timer.unref?.()

    let status = 0
    let chunks = ''
    stream.on('response', (headers) => { status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0 })
    stream.setEncoding('utf-8')
    stream.on('data', (c: string) => { chunks += c })
    stream.on('error', (err: Error) => {
      clearTimeout(timer)
      done({ ok: false, error: err.message })
    })
    stream.on('end', () => {
      clearTimeout(timer)
      if (status >= 200 && status < 300) return done({ ok: true, status })
      let reason: string | undefined
      try { reason = (JSON.parse(chunks || '{}') as { reason?: string }).reason } catch { /* non-JSON */ }
      // 410 = the device uninstalled or reinstalled; 400/BadDeviceToken = the
      // token was never valid here (commonly a sandbox token sent to
      // production). Both mean "stop sending to this token".
      const unregistered = status === 410
        || reason === 'Unregistered' || reason === 'BadDeviceToken'
      if (reason === 'ExpiredProviderToken') invalidateProviderToken()
      done({ ok: false, status, reason, unregistered })
    })

    stream.end(body)
  })
}

export interface ApnsTarget {
  token: string
  environment?: ApnsEnvironment
}

export interface ApnsSendOutcome {
  /** False when nothing was even attempted (no credential / no tokens). */
  attempted: boolean
  reason?: string
  sent: number
  failed: number
  /** Tokens Apple says are dead — the caller prunes them from config. */
  deadTokens: string[]
}

/**
 * Send one notification to many device tokens.
 *
 * Never throws. A push is a courtesy on top of data that is already durable in
 * the letter store, so every failure here is reported and swallowed rather than
 * allowed to escape into an event-bus handler.
 */
export async function sendApns(
  targets: ApnsTarget[],
  payload: Record<string, unknown>,
  opts: { priority?: number; collapseId?: string } = {},
): Promise<ApnsSendOutcome> {
  if (targets.length === 0) return { attempted: false, reason: 'no registered device tokens', sent: 0, failed: 0, deadTokens: [] }

  const s = await settings()
  const cred = await loadCredential(s)
  if ('error' in cred) {
    // Once per process: a letter-per-minute agent must not fill the log with
    // the same configuration gap.
    if (!warnedMissing) {
      warnedMissing = true
      log.notif.warn('apns: cannot send — credential missing', { reason: cred.error })
    }
    recordApnsError(cred.error)
    return { attempted: false, reason: cred.error, sent: 0, failed: 0, deadTokens: [] }
  }

  const priority = opts.priority ?? 10
  const results = await Promise.all(targets.map(async (t) => {
    try {
      return {
        token: t.token,
        r: await sendOne(cred, t.environment ?? s.environment, t.token, payload, priority, opts.collapseId),
      }
    } catch (err) {
      return { token: t.token, r: { ok: false, error: err instanceof Error ? err.message : String(err) } as ApnsSendResult }
    }
  }))

  const deadTokens: string[] = []
  let sent = 0
  let failed = 0
  for (const { token, r } of results) {
    if (r.ok) { sent++; continue }
    failed++
    if (r.unregistered) deadTokens.push(token)
    const message = r.error ?? `${r.status ?? '?'} ${r.reason ?? 'unknown'}`
    recordApnsError(message)
    log.notif.warn('apns: send failed', {
      tokenPrefix: token.slice(0, 12), status: r.status, reason: r.reason, error: r.error,
    })
  }
  return { attempted: true, sent, failed, deadTokens }
}
