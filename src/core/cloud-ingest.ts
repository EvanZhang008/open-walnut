/**
 * Mac side of POST /bridge/ingest (src/web/routes/bridge-ingest.ts): the lane
 * that carries projection and transcript uploads to the cloud companion over
 * short HTTPS requests instead of the daemon's long-lived bridge socket.
 *
 * The rule that matters is what a failure does. A network error, a timeout or a
 * 5xx is 'failed', and the caller must NOT retry the same bytes on the bridge:
 * the field failure this lane exists for damages upload bytes in transit, and
 * the bridge is the one connection whose loss costs the phone everything at
 * once. The self-heal sweep retries on the next tick. Only a replica that does
 * not have the route (404/405, older code) or refuses the credential (401/403)
 * answers 'unsupported', which sends the payload down the legacy bridge lane and
 * rests this lane for UNSUPPORTED_BACKOFF_MS.
 *
 * Bodies are gzip'd off the event loop (libuv pool): the 1.6MB task list is
 * ~150KB on the wire, ten times fewer bytes exposed to the same damage.
 */

import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { log } from '../logging/index.js'

const gzip = promisify(zlib.gzip)

/**
 * 'unread': delivered, and the companion said it no longer reads this payload (a
 * session projection once it lists sessions from its copy, stage 2c of
 * docs/plan/walnut-companion-unified-replica.md): the caller stops pushing it there.
 */
export type CloudIngestOutcome = 'sent' | 'unread' | 'failed' | 'unsupported'

const INGEST_TIMEOUT_MS = 30_000
const UNSUPPORTED_BACKOFF_MS = 10 * 60_000
let timeoutMs = INGEST_TIMEOUT_MS
const ENDPOINT_TTL_MS = 10 * 60_000
const ENDPOINT_MISS_TTL_MS = 60_000

let unsupportedUntil = 0
let endpoint: { at: number; value: { url: string; token: string } | null } | null = null
let endpointLookup: Promise<{ url: string; token: string } | null> | null = null
let lookupGen = 0

/**
 * The ingest URL for a bridge URL: ws→http, wss→https, the `/bridge` path gains
 * `/ingest`. A bridge URL on another path means a proxy layout this side cannot
 * guess, so it answers the origin's /bridge/ingest. Null for anything unparseable.
 */
export function ingestUrlFromBridgeUrl(bridgeUrl: string): string | null {
  let u: URL
  try { u = new URL(bridgeUrl) } catch { return null }
  const proto = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:'
    : u.protocol === 'ws:' || u.protocol === 'http:' ? 'http:' : null
  if (!proto) return null
  const trimmed = u.pathname.replace(/\/+$/, '')
  const path = trimmed.endsWith('/bridge') ? `${trimmed}/ingest` : '/bridge/ingest'
  return `${proto}//${u.host}${path}`
}

/**
 * Where and as whom: exactly what the local daemon's bridge is configured with
 * (getBridgeConfigForHost('__local__'): the companion's /bridge URL, honouring
 * `cloud_bridge.enabled` / `cloud_bridge.url`, and the `bridge-local` machine
 * token). Cached, 10 minutes when found and 1 minute when not; a refused token
 * drops the cache (see postToCloudIngest).
 *
 * One lookup at a time: concurrent cold pushes share it. With an empty token
 * cache the lookup MINTS the machine token, and parallel mints of one name
 * revoke each other on the companion's "already exists" path.
 */
function resolveEndpoint(): Promise<{ url: string; token: string } | null> {
  if (endpoint && Date.now() - endpoint.at < (endpoint.value ? ENDPOINT_TTL_MS : ENDPOINT_MISS_TTL_MS)) {
    return Promise.resolve(endpoint.value)
  }
  if (endpointLookup) return endpointLookup
  const gen = ++lookupGen
  endpointLookup = lookupEndpoint(gen).finally(() => { if (gen === lookupGen) endpointLookup = null })
  return endpointLookup
}

async function lookupEndpoint(gen: number): Promise<{ url: string; token: string } | null> {
  let value: { url: string; token: string } | null = null
  try {
    const { getBridgeConfigForHost } = await import('../integrations/cloud-bridge-config.js')
    const cfg = await getBridgeConfigForHost('__local__')
    const url = cfg.enabled && cfg.url ? ingestUrlFromBridgeUrl(cfg.url) : null
    if (url && cfg.token) value = { url, token: cfg.token }
  } catch { value = null }
  if (gen === lookupGen) endpoint = { at: Date.now(), value } // a reset in between wins
  return value
}

function unreadAnswer(text: string): boolean {
  try {
    return (JSON.parse(text) as { unread?: unknown } | null)?.unread === true
  } catch {
    return false
  }
}

/** Is the lane worth trying right now (no known refusal in the last 10 minutes)? */
export function cloudIngestResting(): boolean {
  return Date.now() < unsupportedUntil
}

/**
 * POST one cache payload. `dataJson` is the payload already serialized (the
 * caller hashed and sized exactly these bytes). Never rejects.
 *
 * The rest is checked again once a slot is ours: pushes queued behind the
 * in-flight cap when a 401 lands must not go out. On the companion every wrong
 * token is a strike on the caller's IP (10 in 60s = 429 for everything from it,
 * the phone behind the same NAT and the daemon's bridge re-dial included), and a
 * queued burst used to deliver 11 of them. Now at most MAX_IN_FLIGHT per rest.
 */
export async function postToCloudIngest(
  kind: 'projection-upsert' | 'transcript-upsert',
  dataJson: string,
): Promise<CloudIngestOutcome> {
  if (cloudIngestResting()) return 'unsupported'
  const ep = await resolveEndpoint()
  if (!ep) return 'unsupported' // no companion configured: the legacy lane decides
  await acquireSlot()
  const started = Date.now()
  let status = 0
  try {
    if (cloudIngestResting()) return 'unsupported' // refused while this one waited for a slot
    const body = await gzip(Buffer.from(`{"kind":${JSON.stringify(kind)},"data":${dataJson}}`, 'utf8'))
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ep.token}`,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    status = res.status
    // Read whole (it also releases the socket): a few bytes of JSON.
    const answer = await res.text().catch(() => '')
    if (res.ok) return unreadAnswer(answer) ? 'unread' : 'sent'
    if (status === 404 || status === 405 || status === 401 || status === 403) {
      unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      endpoint = null // a refused token may be re-minted before the lane is tried again
      log.session.info('cloud ingest: lane unavailable, using the bridge for 10 minutes', { kind, status })
      return 'unsupported'
    }
    log.session.warn('cloud ingest: push refused', { kind, status, ms: Date.now() - started })
    return 'failed'
  } catch (err) {
    log.session.warn('cloud ingest: push failed', {
      kind, status, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err),
    })
    return 'failed'
  } finally {
    releaseSlot()
  }
}

export type CloudReplicaReply =
  | { ok: true; reply: Record<string, unknown> }
  | { ok: false; outcome: 'failed' | 'unsupported'; status?: number; error?: string; body?: Record<string, unknown> }

let replicaUnsupportedUntil = 0

/** The pooled keep-alive socket was closed by the far side just as this request
 *  went out on it (ECONNRESET / EPIPE / undici "other side closed"): no answer
 *  was read, and a fresh connection is worth one more try. Never a timeout. */
function staleSocketReset(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === 'TimeoutError' || err.name === 'AbortError') return false
  const code = (err as { cause?: { code?: unknown } }).cause?.code
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET'
}

/** The waits before a replica or journal step goes once more after its connection broke. */
const STEP_RETRY_MS = [2_000, 5_000]
let stepRetryMs = STEP_RETRY_MS

/**
 * Send an idempotent step, again on a fresh connection when one broke before an
 * answer, at most twice more: the first retry at once after a reused socket was
 * reset, else after 2 s; the second after 5 s (a 4 MB letter body sent across the
 * internet lost its connection on the first inbox copy round, 2026-10-21, as the
 * build upload's chunks did). A deadline is never sent again: the companion may
 * still be working on it.
 */
async function sendStep(send: () => Promise<globalThis.Response>): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (err) {
      if (!(err instanceof Error) || err.name === 'TimeoutError' || err.name === 'AbortError' || attempt >= stepRetryMs.length) throw err
      const wait = attempt === 0 && staleSocketReset(err) ? 0 : stepRetryMs[attempt]
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }
}

/** A request's error with its cause: fetch says only "fetch failed", the cause says why. */
function stepError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: { code?: unknown; message?: unknown } }).cause
  const detail = cause ? (typeof cause.code === 'string' ? cause.code : typeof cause.message === 'string' ? cause.message : '') : ''
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message
}

/** A companion is set up and the replica lane is not resting: worth building a manifest for. */
export async function cloudReplicaAvailable(): Promise<boolean> {
  if (Date.now() < replicaUnsupportedUntil || cloudIngestResting()) return false
  return (await resolveEndpoint()) !== null
}

/**
 * POST one step of the companion's task copy to /bridge/replica (the route
 * beside /bridge/ingest, same machine credential, same gzip) and return its
 * JSON answer. Never rejects. A companion without the route (404/405) rests
 * this lane for 10 minutes without resting the ingest lane: an older companion
 * still takes projections. A refused credential rests both.
 *
 * Both steps are idempotent (a manifest, or rows written as they are), so a
 * request whose connection broke before any answer goes out again on a fresh one
 * (sendStep) instead of failing the whole round.
 */
export async function postToCloudReplica(payload: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<CloudReplicaReply> {
  if (Date.now() < replicaUnsupportedUntil || cloudIngestResting()) return { ok: false, outcome: 'unsupported' }
  const ep = await resolveEndpoint()
  if (!ep) return { ok: false, outcome: 'unsupported' }
  const url = ep.url.replace(/\/ingest$/, '/replica')
  await acquireSlot()
  let status = 0
  try {
    const body = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'))
    const send = (): Promise<globalThis.Response> => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    })
    const res = await sendStep(send)
    status = res.status
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.ok && json) return { ok: true, reply: json }
    // The route is there but this one kind is not (core/replication/kind-follower.ts):
    // the kind rests on its own (kind-leader.ts), the other kinds keep going.
    if (status === 404 && json?.error === 'unknown_kind') return { ok: false, outcome: 'unsupported', status, error: 'unknown_kind' }
    // An older companion without the route: a 404, or its app shell for an unknown path.
    if (status === 404 || status === 405 || (res.ok && !json)) {
      replicaUnsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      log.session.info('cloud replica: the companion keeps no task copy yet (older build), asking again in 10 minutes', { status })
      return { ok: false, outcome: 'unsupported', status }
    }
    if (status === 401 || status === 403) {
      unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      endpoint = null
      return { ok: false, outcome: 'unsupported', status }
    }
    // The answer's own fields (a refusal names how many rows it would remove) go with it.
    return { ok: false, outcome: 'failed', status, error: typeof json?.error === 'string' ? json.error : undefined, ...(json ? { body: json } : {}) }
  } catch (err) {
    return { ok: false, outcome: 'failed', status, error: stepError(err) }
  } finally {
    releaseSlot()
  }
}

/**
 * One command of the Mac's handover to the companion's journal (`POST
 * /bridge/journal`, web/routes/bridge-journal.ts; stage 3 of
 * docs/plan/walnut-companion-unified-replica.md): `offline.drain`, `offline.ack`
 * or `offline.blob`, answered with a daemon's reply shape. Throws when it got no
 * answer (the handover keeps the records for its next run); a refusal is the
 * answer `{ok:false, error}`. Each command is idempotent (a redrain hands out the
 * same frozen records), so a connection that broke before any answer is tried
 * again (sendStep).
 */
export async function postToCloudJournal(cmd: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  if (cloudIngestResting()) throw new Error('the companion refused this Mac\'s credential')
  const ep = await resolveEndpoint()
  if (!ep) throw new Error('no cloud companion is set up')
  const url = ep.url.replace(/\/ingest$/, '/journal')
  await acquireSlot()
  try {
    const body = await gzip(Buffer.from(JSON.stringify({ cmd, params }), 'utf8'))
    const send = (): Promise<globalThis.Response> => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    })
    const res = await sendStep(send)
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.status === 401 || res.status === 403) {
      unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      endpoint = null
      throw new Error(`the companion refused this Mac's credential (${res.status})`)
    }
    if (!json) throw new Error(`the companion answered ${res.status} without a journal answer (an older build)`)
    return json
  } finally {
    releaseSlot()
  }
}

let hostReplicaUnsupportedUntil = 0

/** The companion takes the notes, memory and skills copy: set up, not resting, and not an older build. */
export async function cloudHostReplicaAvailable(): Promise<boolean> {
  if (Date.now() < hostReplicaUnsupportedUntil || cloudIngestResting()) return false
  return (await resolveEndpoint()) !== null
}

/**
 * One command of the Mac's notes, memory and skills round for the companion
 * (`POST /bridge/host-replica`, web/routes/bridge-host-replica.ts; stage 4 of
 * docs/plan/walnut-companion-unified-replica.md), answered with a daemon's reply
 * shape: `{ok:true, ...}` or `{ok:false, error, errorKind?}`. Never rejects: no
 * answer is `{ok:false}`. An older companion without the door (a 404, or its app
 * shell for an unknown path) rests this lane for 10 minutes. Each command is
 * idempotent, so a connection that broke before any answer is tried again (sendStep).
 */
export async function postToCloudHostReplica(cmd: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  if (Date.now() < hostReplicaUnsupportedUntil || cloudIngestResting()) return { ok: false, error: 'the companion does not take this copy now', errorKind: 'unsupported' }
  const ep = await resolveEndpoint()
  if (!ep) return { ok: false, error: 'no cloud companion is set up', errorKind: 'unsupported' }
  const url = ep.url.replace(/\/ingest$/, '/host-replica')
  await acquireSlot()
  try {
    const body = await gzip(Buffer.from(JSON.stringify({ cmd, params }), 'utf8'))
    const send = (): Promise<globalThis.Response> => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    })
    const res = await sendStep(send)
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.status === 401 || res.status === 403) {
      unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      endpoint = null
      return { ok: false, error: `the companion refused this Mac's credential (${res.status})`, errorKind: 'unsupported' }
    }
    if (res.status === 404 || res.status === 405 || !json || typeof json.ok !== 'boolean') {
      hostReplicaUnsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      log.session.info('cloud replica: the companion keeps no notes copy yet (older build), asking again in 10 minutes', { status: res.status })
      return { ok: false, error: `the companion answered ${res.status} without a copy answer (an older build)`, errorKind: 'unsupported' }
    }
    return json
  } catch (err) {
    return { ok: false, error: stepError(err) }
  } finally {
    releaseSlot()
  }
}

/** A companion build changed: an older one's rest of the notes copy ends. */
export function forgetCloudHostReplicaRest(): void {
  hostReplicaUnsupportedUntil = 0
}

export interface CloudSessionSend {
  host: string
  sessionId: string
  message: string
  uuid: string
  markers: Array<{ message: string; messageId: string }>
  stopFence: string | null
  lostPid?: number
}

let sendCredentialRecovery: Promise<void> | null = null

export function recoverCloudSessionCredential(deadToken: string): Promise<void> {
  endpoint = null
  sendCredentialRecovery ??= (async () => {
    const { getCloudRemoteCredentialsAsync } = await import('../integrations/git-sync.js')
    const cloud = await getCloudRemoteCredentialsAsync({ strict: true })
    if (cloud) {
      const { recoverMachineToken } = await import('../integrations/cloud-bridge-config.js')
      await recoverMachineToken('__local__', deadToken, cloud)
    }
  })().catch(() => {}).finally(() => { endpoint = null; sendCredentialRecovery = null })
  return sendCredentialRecovery
}

export async function cloudSessionEndpoint(): Promise<{ url: string; token: string } | null> {
  if (sendCredentialRecovery) await sendCredentialRecovery
  const ep = await resolveEndpoint()
  return ep ? { url: ep.url.replace(/\/ingest$/, ''), token: ep.token } : null
}

export function postToCloudSessionSend(payload: CloudSessionSend): Promise<Record<string, unknown> | null> {
  return postCloudSession('/send', payload)
}

export interface CloudSessionPermission {
  host: string
  sessionId: string
  requestId: string
  allow: boolean
  message?: string
  answers?: Record<string, string>
}

export function postToCloudSessionPermission(payload: CloudSessionPermission): Promise<Record<string, unknown> | null> {
  return postCloudSession('/send/permission', payload)
}

async function postCloudSession(path: string, payload: CloudSessionSend | CloudSessionPermission): Promise<Record<string, unknown> | null> {
  const ep = await cloudSessionEndpoint()
  if (!ep) return null
  const { SendOutcomeUnknownError } = await import('../providers/delivery-failure.js')
  let body: string
  try { body = await (await import('../lib/cloud-session-payload.js')).encodeCloudSessionPayload(payload) }
  catch { return null }
  try {
    const res = await fetch(`${ep.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(25_000),
    })
    const reply = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.ok && reply && typeof reply.ok === 'boolean') return reply
    if (res.status === 401 || res.status === 403) {
      endpoint = null
      if (res.status === 401) void recoverCloudSessionCredential(ep.token)
    }
    if ([401, 403, 404, 405, 413].includes(res.status) || reply?.sent === false) return null
    throw new SendOutcomeUnknownError('The companion did not confirm the session send')
  } catch (err) {
    if (err instanceof SendOutcomeUnknownError) throw err
    throw new SendOutcomeUnknownError('The connection to the companion failed during the session send')
  }
}

/** At most MAX_IN_FLIGHT requests at once: a burst of transcript exports must
 *  not open a TLS connection per session. */
const MAX_IN_FLIGHT = 2
let inFlight = 0
const slotWaiters: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve() }
  return new Promise((resolve) => { slotWaiters.push(() => { inFlight++; resolve() }) })
}

function releaseSlot(): void {
  inFlight--
  slotWaiters.shift()?.()
}

/**
 * Per-key latest-wins serialization: one request in flight per key, and while
 * it runs only the NEWEST waiting payload is kept (every caller that joined the
 * wait gets that send's outcome). Two task-list exports seconds apart must never
 * land out of order, and a slow link must not queue megabytes of stale copies.
 */
type Waiting = {
  run: () => Promise<unknown>
  promise: Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}
type Lane = { running: boolean; waiting: Waiting | null }
const lanes = new Map<string, Lane>()

export function runLatestPerKey<T>(key: string, run: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key)
  if (!lane) { lane = { running: false, waiting: null }; lanes.set(key, lane) }
  if (!lane.running) return drive(key, lane, run)
  if (lane.waiting) {
    lane.waiting.run = run // newest payload wins; joiners share its outcome
    return lane.waiting.promise as Promise<T>
  }
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
  lane.waiting = { run, promise, resolve, reject }
  return promise as Promise<T>
}

function drive<T>(key: string, lane: Lane, run: () => Promise<T>): Promise<T> {
  lane.running = true
  const p = (async () => run())()
  const next = (): void => {
    const w = lane.waiting
    lane.waiting = null
    if (w) {
      drive(key, lane, w.run).then(w.resolve, w.reject)
      return
    }
    lane.running = false
    if (lanes.get(key) === lane) lanes.delete(key)
  }
  p.then(next, next)
  return p
}

/** Tests only. `timeoutMs` shortens the request deadline (default 30s). */
export function _resetCloudIngestForTesting(opts: { timeoutMs?: number; stepRetryMs?: number[] } = {}): void {
  stepRetryMs = opts.stepRetryMs ?? STEP_RETRY_MS
  unsupportedUntil = 0
  replicaUnsupportedUntil = 0
  hostReplicaUnsupportedUntil = 0
  endpoint = null
  endpointLookup = null
  sendCredentialRecovery = null
  lookupGen++
  lanes.clear()
  inFlight = 0
  slotWaiters.length = 0
  timeoutMs = opts.timeoutMs ?? INGEST_TIMEOUT_MS
}
