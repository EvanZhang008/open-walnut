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

export type CloudIngestOutcome = 'sent' | 'failed' | 'unsupported'

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
    await res.arrayBuffer().catch(() => undefined) // release the socket
    if (res.ok) return 'sent'
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
  | { ok: false; outcome: 'failed' | 'unsupported'; status?: number; error?: string }

let replicaUnsupportedUntil = 0

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
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    })
    status = res.status
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.ok && json) return { ok: true, reply: json }
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
    return { ok: false, outcome: 'failed', status, error: typeof json?.error === 'string' ? json.error : undefined }
  } catch (err) {
    return { ok: false, outcome: 'failed', status, error: err instanceof Error ? err.message : String(err) }
  } finally {
    releaseSlot()
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
export function _resetCloudIngestForTesting(opts: { timeoutMs?: number } = {}): void {
  unsupportedUntil = 0
  replicaUnsupportedUntil = 0
  endpoint = null
  endpointLookup = null
  lookupGen++
  lanes.clear()
  inFlight = 0
  slotWaiters.length = 0
  timeoutMs = opts.timeoutMs ?? INGEST_TIMEOUT_MS
}
