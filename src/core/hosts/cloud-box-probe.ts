/**
 * Primary side of the cloud box host: is this Mac paired with a companion, and
 * can that companion host this Mac's sessions? Feeds the leaf state in
 * cloud-box-host.ts, which config-manager injects into `config.hosts`.
 *
 * Paired = the same test cloud-bridge-config.ts applies: the data repo has a
 * `cloud` (or `origin`) remote carrying a device token, and `cloud_bridge` is
 * not turned off. Capable = the companion's /api/v1/status carries
 * `daemonTunnel` (absent on an older build) with `enabled: true`.
 *
 * Every step is bounded and none of it runs on a request path: the pairing is
 * read at boot (async git, 3s cap) and the status probe runs in the background
 * every few minutes, so a companion that hangs costs nothing but a stale answer.
 */

import { CLOUD_MODE, IS_EPHEMERAL } from '../../constants.js'
import { log } from '../../logging/index.js'
import {
  CLOUD_BOX_EXEC_OFF,
  CLOUD_BOX_OTHER_MAC_SENTENCE,
  capabilityFromStatus,
  cloudBoxRefusal,
  getCloudBoxState,
  setCloudBoxState,
  tunnelUrlFor,
  type CloudBoxCapability,
  type CloudBoxState,
} from './cloud-box-host.js'

const PROBE_INTERVAL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 5_000
const PAIRING_TIMEOUT_MS = 3_000

interface Pairing { domain: string; token: string; secure: boolean }

let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<CloudBoxState | null> | null = null

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(t))
}

/** host[:port] names this machine (a companion started by a test). */
export function isLoopbackDomain(domain: string): boolean {
  const host = domain.startsWith('[') ? domain.slice(1, domain.indexOf(']')) : domain.replace(/:\d+$/, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

async function readPairing(): Promise<Pairing | null> {
  const [{ getCloudRemoteCredentialsAsync }, { getConfig }] = await Promise.all([
    import('../../integrations/git-sync.js'),
    import('../config-manager.js'),
  ])
  try {
    if ((await getConfig()).cloud_bridge?.enabled === false) return null
  } catch { /* unreadable config: the remote decides, as for the bridge */ }
  const pairing = await getCloudRemoteCredentialsAsync()
  // An ephemeral server runs on a COPY of the real data dir, pairing and
  // cached machine token included: dialling that companion would put a test
  // server on the real Mac's daemon on the box. Only a loopback companion (one
  // a test started) is ever its cloud box.
  if (pairing && IS_EPHEMERAL && !isLoopbackDomain(pairing.domain)) return null
  return pairing
}

/** One status read. null = no answer worth keeping (network, non-200): the last answer stands. */
export async function probeCapability(p: Pairing): Promise<CloudBoxCapability | null> {
  const url = `${p.secure ? 'https' : 'http'}://${p.domain}/api/v1/status`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${p.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status !== 200) {
      log.session.warn('cloud box: companion status probe refused', { domain: p.domain, status: res.status })
      return null
    }
    return capabilityFromStatus(await res.json().catch(() => null))
  } catch (err) {
    log.session.info('cloud box: companion status probe failed', {
      domain: p.domain, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Read the pairing and publish the row (capability carried over for the same box). */
async function applyPairing(): Promise<{ pairing: Pairing | null }> {
  let pairing: Pairing | null
  try {
    pairing = await withDeadline(readPairing(), PAIRING_TIMEOUT_MS, 'reading the cloud pairing')
  } catch (err) {
    // Could not tell: keep whatever we had rather than make a host vanish.
    log.session.warn('cloud box: pairing read failed', { error: err instanceof Error ? err.message : String(err) })
    return { pairing: null }
  }
  if (!pairing) {
    setCloudBoxState(null)
    return { pairing: null }
  }
  const prev = getCloudBoxState()
  const same = prev !== null && prev.domain === pairing.domain && prev.secure === pairing.secure
  setCloudBoxState({
    domain: pairing.domain, secure: pairing.secure,
    capability: same ? prev.capability : 'unknown', checkedAt: same ? prev.checkedAt : null,
  })
  return { pairing }
}

async function probeAndApply(pairing: Pairing): Promise<void> {
  let capability = await probeCapability(pairing)
  const current = getCloudBoxState()
  if (!capability || !current || current.domain !== pairing.domain) return
  // "Another Mac is connected" comes from a mint, never from the status: a
  // status that says ready does not clear it (the next dial asks again).
  if (capability === 'ready' && current.capability === 'other_mac') capability = 'other_mac'
  if (capability !== current.capability) {
    log.session.info('cloud box: companion capability', { domain: pairing.domain, capability, was: current.capability })
  }
  setCloudBoxState({ ...current, capability, checkedAt: Date.now() })
}

async function refreshInner(): Promise<CloudBoxState | null> {
  const { pairing } = await applyPairing()
  if (pairing) await probeAndApply(pairing)
  return getCloudBoxState()
}

/** Re-read the pairing and re-probe the companion. Single-flight; never rejects. */
export function refreshCloudBoxHost(): Promise<CloudBoxState | null> {
  if (CLOUD_MODE) return Promise.resolve(null)
  if (inFlight) return inFlight
  inFlight = refreshInner().catch(() => getCloudBoxState()).finally(() => { inFlight = null })
  return inFlight
}

/**
 * Boot: wait for the PAIRING (bounded, ~20ms of async git) so the first host
 * lists and the session reconciler already see the row, then leave the status
 * probe to the background: a slow companion must never delay startup.
 */
export async function startCloudBoxHost(): Promise<void> {
  if (CLOUD_MODE) return
  stopCloudBoxHost()
  const { pairing } = await applyPairing()
  if (pairing) void probeAndApply(pairing).catch(() => { /* logged inside */ })
  timer = setInterval(() => { void refreshCloudBoxHost() }, PROBE_INTERVAL_MS)
  timer.unref?.()
}

export function stopCloudBoxHost(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** The tunnel said something the status probe had not: record it at once. */
export function noteCloudBoxCapability(capability: CloudBoxCapability): void {
  const s = getCloudBoxState()
  if (!s || s.capability === capability) return
  setCloudBoxState({ ...s, capability, checkedAt: Date.now() })
}

/**
 * The refusal a dial gives without dialling. Like cloudBoxRefusal, except for
 * "another Mac is connected": only a mint can tell whether that Mac let go, so
 * the dial (a Retry, the slow reconnect) asks the companion again.
 */
export function refusalBeforeDial(): string | null {
  const s = getCloudBoxState()
  return s?.capability === 'other_mac' ? null : cloudBoxRefusal(s)
}

export interface CloudTunnelEndpoint { url: string; headers: Record<string, string>; domain: string; token: string }

/** What describeTunnelRefusal says for a 401: the companion no longer accepts this Mac's machine token. */
const CREDENTIAL_REJECTED = 'Cloud companion tunnel failed: the companion rejected this Mac\'s credential (HTTP 401)'

async function readPairingOrThrow(): Promise<Pairing> {
  const pairing = await withDeadline(readPairing(), PAIRING_TIMEOUT_MS, 'reading the cloud pairing')
  if (!pairing) throw new Error('Cloud companion tunnel failed: this Mac is not paired with a cloud companion')
  return pairing
}

function otherMacConnected(): Error {
  noteCloudBoxCapability('other_mac')
  return new Error(CLOUD_BOX_OTHER_MAC_SENTENCE)
}

/** A second refusal inside the re-mint window: the dead token is gone, and a person's Retry mints the next one. */
export const CREDENTIAL_AWAITS_RETRY = 'Cloud companion tunnel failed: the companion refused this Mac\'s credential again; Retry to get a new one'

async function endpointFor(pairing: Pairing): Promise<CloudTunnelEndpoint> {
  const { getPrimaryMachineToken, machineTokenAwaitsRetry, machineTokenConflict } = await import('../../integrations/cloud-bridge-config.js')
  const token = await getPrimaryMachineToken(pairing)
  if (!token) {
    if (machineTokenConflict('__local__')) throw otherMacConnected()
    if (machineTokenAwaitsRetry('__local__')) throw new Error(CREDENTIAL_AWAITS_RETRY)
    throw new Error('Cloud companion tunnel failed: the companion did not issue this Mac a machine credential')
  }
  return { url: tunnelUrlFor(pairing), headers: { Authorization: `Bearer ${token}` }, domain: pairing.domain, token }
}

/**
 * Where and with what to dial the tunnel. Read fresh on every dial (cheap
 * async git) so a re-pairing to another companion is picked up by the next
 * reconnect instead of dialling the old box forever.
 */
export async function resolveCloudTunnelEndpoint(): Promise<CloudTunnelEndpoint> {
  return endpointFor(await readPairingOrThrow())
}

/**
 * Dial the tunnel with `connect`. A 401 means the companion stopped accepting
 * this Mac's machine token (revoked, or lost with the companion's auth.json):
 * drop it, mint a new one once, and dial again. A mint the companion refuses
 * because another Mac holds its machine credentials throws that sentence.
 */
export async function openCloudTunnel(connect: (endpoint: CloudTunnelEndpoint) => Promise<void>): Promise<void> {
  const pairing = await readPairingOrThrow()
  const endpoint = await endpointFor(pairing)
  try {
    await connect(endpoint)
    return
  } catch (err) {
    if (!(err instanceof Error) || err.message !== CREDENTIAL_REJECTED) throw err
    const { recoverMachineToken, machineTokenAwaitsRetry } = await import('../../integrations/cloud-bridge-config.js')
    const outcome = await recoverMachineToken('__local__', endpoint.token, pairing)
    if (outcome === 'conflict') throw otherMacConnected()
    if (outcome !== 'reminted') throw machineTokenAwaitsRetry('__local__') ? new Error(CREDENTIAL_AWAITS_RETRY) : err
    log.session.info('cloud box: dialling again with a new machine credential', { domain: pairing.domain })
  }
  await connect(await endpointFor(pairing))
}

/**
 * The sentence for a refused tunnel upgrade. Every one of them is recognised
 * by the host connect classifier (host-connect-hint.ts), so the chip, picker
 * and banner say the same thing.
 */
export function describeTunnelRefusal(status: number, refusal: string | undefined, detail: string): string {
  if (refusal === 'cloud_exec_off') {
    noteCloudBoxCapability('exec_off')
    return `${CLOUD_BOX_EXEC_OFF} (cloud.exec.enabled is off there)`
  }
  const tail = detail.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (refusal === 'not_primary') return 'Cloud companion tunnel failed: the companion did not accept this Mac\'s machine credential'
  if (refusal === 'daemon_start_failed') return `Cloud companion tunnel failed: the companion could not start its session daemon${tail ? ` (${tail})` : ''}`
  if (status === 401) return CREDENTIAL_REJECTED
  return `Cloud companion tunnel failed: HTTP ${status}${tail ? ` (${tail})` : ''}`
}
