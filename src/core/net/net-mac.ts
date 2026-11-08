/**
 * The host network from the Mac (docs/reference/host-network.md). With a cloud companion
 * paired, the companion keeps the member list and checks every join (core/net/net-store.ts,
 * routes/net-v1.ts); with none, this Mac keeps it (`net.joined`, core/net/net-rows.ts) and
 * its own walnut-net checks each join (core/net/net-local.ts). Either way this Mac:
 *
 *   - says its own network id to the companion (its key lives in its daemon's net state,
 *     never in the synced data dir), so every machine that joins lets it in;
 *   - reads the list and makes each `host` member one of its hosts, `transport: net`
 *     (core/hosts/link.ts), which DaemonConnection reaches through this Mac's walnut-net
 *     (core/hosts/net-link.ts): direct, or through the user's own relay;
 *   - hands its own daemon the list (it dials those machines, lets none of them in), and
 *     each machine it reaches the current list of Macs it should let in;
 *   - makes invites for the Settings page and watches them until the machine joined.
 *
 * Nothing here runs until the user makes the first invite (`net.enabled` in config),
 * so a Walnut with no companion or no use for the network never starts walnut-net.
 */
import os from 'node:os'
import { log } from '../../logging/index.js'
import { NetError } from './net-error.js'
import { joinedOf, localMembers, markRemoving, netRows, reconcileHosts, removalsPending, setJoined, type HostRows } from './net-rows.js'
import { clearLeftovers, leftoverJoins, type Daemon } from './net-local.js'
import { cutOffByNoRelay, relayChoice, relaysOfChoice, type RelayChoice } from './net-relay.js'
import { machineLinks, noteSeen, runningChoice, waitForModes } from './net-seen.js'
import { keepWhere, noteWhere, withWhere } from './net-where.js'

/** Why a throwaway server (a developer's test server, or the Demo) takes no part in the host network. */
async function notOnThisServer(): Promise<string> {
  const { IS_DEMO } = await import('../../constants.js')
  return `The host network runs only on your own Walnut, not ${IS_DEMO ? 'in the Demo' : 'on a test server'}.`
}

const CALL_TIMEOUT_MS = 15_000
const SYNC_EVERY_MS = 10 * 60_000

export { NetError }
export { netHostname } from './net-rows.js'

export interface NetMember { id: string; name: string; role: 'mac' | 'host'; platform?: string; addedAt?: number; addrs?: string[]; relays?: string[] }

export { relayChoice, type RelayChoice }

export interface NetState {
  enabled: boolean
  macId: string | null
  /** A cloud companion is paired (it keeps the list); else this Mac does. */
  companion: boolean
  /** The relay in use: the user's pick (`net.relay`), else `own` with a companion, `public` without. */
  relay: RelayChoice
  relays: string[]
  relayRoots: string[]
  members: NetMember[]
  syncedAt: number | null
  error: string | null
}

const state: NetState = { enabled: false, macId: null, companion: false, relay: 'public', relays: [], relayRoots: [], members: [], syncedAt: null, error: null }
// The relay this Mac's walnut-net was last configured with: on a change the machines are
// told first, while this Mac still reaches them the old way.
let appliedRelay: RelayChoice | null = null

async function companionPaired(): Promise<boolean> {
  const { getCloudPairingEndpointAsync } = await import('../pairing-targets.js')
  return !!(await getCloudPairingEndpointAsync())
}

/** The relay as config says now (not as of the last sync): what Settings shows. */
export async function relayNow(): Promise<{ companion: boolean; relay: RelayChoice }> {
  const { getConfig } = await import('../config-manager.js')
  const [cfg, companion] = await Promise.all([getConfig() as Promise<{ net?: { relay?: unknown } }>, companionPaired()])
  return { companion, relay: relayChoice(cfg.net?.relay, companion) }
}
let syncing: Promise<NetState> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let retry: ReturnType<typeof setTimeout> | null = null, retries = 0
const BOOT_RETRY_MS = 30_000, BOOT_RETRIES = 10
/** How long a relay change waits for this Mac's walnut-net to say what it runs. */
const MODES_WAIT_MS = 15_000

export async function companionCall(p: string, init: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  // A test server holds a copy of the real pairing: one call from it would put its key in
  // the Mac's place on the user's companion.
  if (!await netActive()) throw new NetError(409, 'test_server', await notOnThisServer())
  const [{ getCloudPairingEndpointAsync }, { machineProofHeaders }] = await Promise.all([
    import('../pairing-targets.js'), import('../../integrations/cloud-bridge-config.js'),
  ])
  const cloud = await getCloudPairingEndpointAsync()
  if (!cloud) throw new NetError(400, 'no_companion', 'Adding machines goes through your cloud companion; pair one first (Settings > Phones & Cloud).')
  const res = await fetch(`${cloud.origin}/api/v1${p}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${cloud.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...await machineProofHeaders() },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (res.status === 404 && (body.error as { code?: string } | undefined)?.code !== 'unknown_invite' && (body.error as { code?: string } | undefined)?.code !== 'not_member') {
    throw new NetError(409, 'companion_too_old', 'Your cloud companion is too old for the host network; update it first.')
  }
  return { status: res.status, body }
}

export function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  const e = body.error as { code?: unknown; message?: unknown } | string | undefined
  if (typeof e === 'string') return { code: 'refused', message: e }
  return { code: typeof e?.code === 'string' ? e.code : 'refused', message: typeof e?.message === 'string' ? e.message : 'The cloud companion refused' }
}

export async function localDaemon() {
  const { link } = await import('../hosts/link.js')
  const local = await link('__local__')
  if (!local.hasCapability('net-v1')) throw new NetError(409, 'daemon_too_old', "This machine's Walnut daemon has no host network yet; restart Walnut to update it.")
  return local
}

/** The relay part of a walnut-net config: the companion's relay, or a mode with none listed. */
function relayFields(s: NetState): Record<string, unknown> {
  if (s.relay === 'own') return { relays: s.relays, relayRoots: s.relayRoots }
  return { relayMode: s.relay, relays: [], relayRoots: [] }
}

/** What this Mac's own walnut-net is told: dial every host member, let none in. */
function macConfig(s: NetState): Record<string, unknown> {
  return {
    ...relayFields(s),
    // Where each one was last seen (net-where.ts): one not on this relay choice yet is found there.
    members: s.members.filter((m) => m.role === 'host' && m.id !== s.macId).map((m) => ({
      id: m.id, name: m.name, accept: false, ...(m.addrs?.length ? { addrs: m.addrs } : {}), ...(m.relays?.length ? { relays: m.relays } : {}),
    })),
  }
}

/** What each joined machine is told: let in this Mac (every `mac` member). */
function hostConfig(s: NetState): Record<string, unknown> {
  return {
    ...relayFields(s),
    members: s.members.filter((m) => m.role === 'mac').map((m) => ({ id: m.id, name: m.name, accept: true })),
  }
}

/** Endpoints Remove is taking out right now (this process): never put back on the list. */
const removing = new Set<string>()

/** Finish removals a restart cut short: the companion (if any) forgets the machine, its row goes. */
async function finishRemovals(companion: boolean): Promise<void> {
  for (const endpoint of await removalsPending()) {
    if (removing.has(endpoint)) continue
    if (companion) {
      const r = await companionCall(`/net/members/${endpoint}`, { method: 'DELETE' })
      if (r.status !== 200 && r.status !== 404) continue
    }
    await reconcileHosts([], { drop: endpoint })
    await setJoined(endpoint, null)
    await markRemoving(endpoint, false)
    log.session.info('net: finished a removal cut short', { endpoint })
  }
}

/**
 * Machines this Mac has that the companion's list lacks (a companion rebuilt without its
 * state forgets the list): put back, under the name this Mac shows. True when one was.
 */
async function restoreMissing(members: NetMember[]): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  const listed = new Set(members.map((m) => m.id))
  const pending = new Set(await removalsPending())
  const missing = netRows(((await getConfig()).hosts ?? {}) as HostRows).filter(([, h]) => !listed.has(h.endpoint) && !removing.has(h.endpoint) && !pending.has(h.endpoint))
  let any = false
  for (const [alias, h] of missing) {
    const name = typeof h.label === 'string' && h.label ? h.label : alias
    const r = await companionCall(`/net/members/${h.endpoint}`, { method: 'PUT', body: { name } })
    if (r.status === 200) {
      any = true
      log.session.warn('net: the companion had lost a machine; put it back', { host: alias })
    } else {
      log.session.warn('net: could not put a machine back on the list', { host: alias, status: r.status, error: errorOf(r.body).message })
    }
  }
  return any
}

/**
 * Hand one machine the current list, when it is connected (nothing is dialled for this).
 * Never one Remove is taking out: its `enabled: false` would be undone. The check sits
 * right before the send, so a push that passed it went out before Remove's message.
 */
async function pushToHost(name: string, endpoint: string, s: NetState): Promise<void> {
  const { peekDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = peekDaemonConnection(name)
  if (!conn?.connected || !conn.hasCapability('net-v1') || removing.has(endpoint)) return
  // An older daemon drops the relay mode and would run with no relay at all: it keeps the
  // companion's relay it has until it is updated.
  if (s.relay !== 'own' && !conn.hasCapability('net-join-v1')) {
    log.session.warn('net: a machine is too old for this relay choice; it keeps the one it has', { host: name, relay: s.relay })
  } else {
    try { await conn.send('net.configure', hostConfig(s), 20_000) } catch (err) { log.session.warn('net: could not hand a machine its member list', { host: name, error: (err as Error).message }) }
  }
  const local = await localDaemon().catch(() => null)
  if (local) await noteSeen(local, conn, name, endpoint, relaysOfChoice(s.relay, s.relays))
}

/** The machines to hand the list to: every net host row but those a Remove is taking out. */
async function pushTargets(): Promise<Array<[string, string]>> {
  const { getConfig } = await import('../config-manager.js')
  const pending = new Set(await removalsPending())
  return Object.entries((await getConfig()).hosts ?? {})
    .filter(([, h]) => h.transport === 'net' && typeof h.endpoint === 'string' && !pending.has(h.endpoint))
    .map(([name, h]) => [name, h.endpoint as string])
}

/** Every connected machine at once; a slow one holds up nothing (an invite never waits on it). */
async function pushToHosts(s: NetState): Promise<void> {
  await Promise.allSettled((await pushTargets()).map(([name, endpoint]) => pushToHost(name, endpoint, s)))
}

/**
 * Read the list (the companion's, or this Mac's own) and apply it here (single flight).
 * `enable` turns the network on first; a sync already running without it is waited for,
 * then one runs.
 */
export async function syncNet(opts: { enable?: boolean } = {}): Promise<NetState> {
  if (opts.enable) {
    if (syncing) await syncing.catch(() => {})
    await setEnabled(true)
  }
  syncing ??= runSync(opts)
  return syncing
}

function runSync(opts: { enable?: boolean }): Promise<NetState> {
  return (async () => {
    try {
      const { getConfig } = await import('../config-manager.js')
      const cfg = await getConfig() as { net?: { enabled?: boolean; relay?: unknown }; hosts?: Record<string, unknown> }
      state.enabled = cfg.net?.enabled === true
      // Read even while the network is off: a pick made before the first machine is kept.
      state.companion = await companionPaired()
      state.relay = relayChoice(cfg.net?.relay, state.companion)
      // A pick made before a companion was paired is void: unpaired later, the machines that
      // joined through it are on its relay, and an old No relay would cut them off unchecked.
      if (state.companion && cfg.net?.relay !== undefined) await clearPick()
      if (!state.enabled) return { ...state }
      // A test server holds a copy of the real config and pairing.
      if (!await netActive()) throw new NetError(409, 'test_server', await notOnThisServer())
      const local = await localDaemon()
      // An older daemon drops the relay mode, so its walnut-net would run with no relay at all.
      if (state.relay !== 'own' && !local.hasCapability('net-join-v1')) throw new NetError(409, 'daemon_too_old', "This machine's Walnut daemon is too old for public relays or no relay; restart Walnut to update it.")
      const ident = await local.send('net.identity', {}, 20_000) as { ok?: boolean; endpointId?: string; error?: string }
      if (!ident.ok || !ident.endpointId) throw new NetError(500, 'no_identity', `This machine's network key: ${ident.error ?? 'none'}`)
      state.macId = ident.endpointId
      // After a restart: the choice this Mac's walnut-net still runs on (it outlives the server).
      if (appliedRelay === null) appliedRelay = await runningChoice(local)
      await finishRemovals(state.companion)
      if (state.companion) await readCompanionList()
      else {
        if (!leftoversTaken) await takeLeftovers(local)
        // No companion: the list is this Mac's own.
        const skip = new Set([...removing, ...await removalsPending()])
        const now = await getConfig() as { net?: unknown; hosts?: Record<string, unknown> }
        state.members = localMembers((now.hosts ?? {}) as HostRows, now.net, state.macId, os.hostname().split('.')[0] || 'Mac', skip)
        state.relays = []
        state.relayRoots = []
      }
      // Each machine is dialled where it was last seen too.
      state.members = withWhere(state.members, ((await getConfig()) as { net?: unknown }).net, relaysOfChoice(state.relay, state.relays))
      // A new relay: the machines first, while this Mac still reaches them the old way.
      const relayMoved = appliedRelay !== null && appliedRelay !== state.relay
      // The machines go first, so this Mac must be able to follow: an older walnut-net here
      // (no relay mode in its status) would leave them on a relay it never comes to.
      if (relayMoved && state.relay !== 'own') {
        // Starting, or restarting for a change a moment ago: wait for it to say (bounded).
        const modes = await waitForModes(local, MODES_WAIT_MS)
        if (modes === null) throw new NetError(409, 'net_starting', "This machine's walnut-net is still starting; try again in a minute.")
        if (!modes) throw new NetError(409, 'net_too_old', "This machine's walnut-net is older than this Walnut; the relay changes once the new version is downloaded.")
      }
      if (relayMoved) await pushToHosts({ ...state })
      const conf = await local.send('net.configure', macConfig(state), 30_000) as { ok?: boolean; error?: string }
      if (!conf.ok) throw new NetError(500, 'net_start_failed', `This machine's walnut-net: ${conf.error ?? 'did not start'}`)
      appliedRelay = state.relay
      const changed = await reconcileHosts(state.members)
      if (changed.added.length || changed.removed.length) log.session.info('net: hosts updated from the member list', changed)
      await keepWhere(new Set(state.members.map((m) => m.id)))
      if (!relayMoved) void pushToHosts({ ...state })
      state.syncedAt = Date.now()
      state.error = null
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      log.session.warn('net: sync failed', { error: state.error })
      // Never synced since boot (walnut-net still starting, say): try again soon, not in 10 minutes.
      if (!state.syncedAt && timer && !retry && retries < BOOT_RETRIES) {
        retries++
        retry = setTimeout(() => { retry = null; if (state.enabled) void syncNet() }, BOOT_RETRY_MS)
        retry.unref?.()
      }
      if (err instanceof NetError && opts.enable) throw err
    } finally {
      syncing = null
    }
    return { ...state }
  })()
}

/** The companion's list (it is told this Mac's id, and given back machines it lost). */
async function readCompanionList(): Promise<void> {
  let info = await companionCall('/net/info', { method: 'GET' })
  if (info.status !== 200) { const e = errorOf(info.body); throw new NetError(info.status, e.code, e.message) }
  const listed = (info.body.members as NetMember[] | undefined) ?? []
  if (!listed.some((m) => m.role === 'mac' && m.id === state.macId)) {
    const put = await companionCall('/net/self', { method: 'PUT', body: { endpointId: state.macId, name: os.hostname().split('.')[0] || 'Mac' } })
    if (put.status !== 200) { const e = errorOf(put.body); throw new NetError(put.status, e.code, e.message) }
    info = await companionCall('/net/info', { method: 'GET' })
    if (info.status !== 200) { const e = errorOf(info.body); throw new NetError(info.status, e.code, e.message) }
  }
  if (await restoreMissing((info.body.members as NetMember[] | undefined) ?? [])) info = await companionCall('/net/info', { method: 'GET' })
  if (info.status !== 200) { const e = errorOf(info.body); throw new NetError(info.status, e.code, e.message) }
  state.relays = (info.body.relays as string[] | undefined) ?? []
  state.relayRoots = (info.body.relayRoots as string[] | undefined) ?? []
  state.members = (info.body.members as NetMember[] | undefined) ?? []
}

let leftoversTaken = false

/** Joins a stopped run never read: kept first, then walnut-net forgets that run's invites. */
async function takeLeftovers(local: Daemon): Promise<void> {
  const joins = await leftoverJoins(local)
  // walnut-net did not answer: the next sync looks again.
  if (!joins) return
  const { getConfig } = await import('../config-manager.js')
  for (const j of joins) {
    if (!joinedOf(((await getConfig()) as { net?: unknown }).net)[j.memberId]) {
      await setJoined(j.memberId, { name: j.name, ...(j.platform ? { platform: j.platform } : {}), addedAt: j.at })
      log.session.info('net: kept a machine that joined while Walnut restarted', { name: j.name })
    }
    await noteWhere(j.memberId, { addrs: Array.isArray(j.addrs) ? j.addrs : [] })
  }
  await clearLeftovers(local)
  leftoversTaken = true
}

async function clearPick(): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : null
    if (!net || !('relay' in net)) return { write: false, result: undefined }
    delete net.relay
    doc.net = net
    return { write: true, result: undefined }
  })
}

async function setEnabled(on: boolean): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : {}
    if (net.enabled === on) return { write: false, result: undefined }
    net.enabled = on
    doc.net = net
    return { write: true, result: undefined }
  })
}

let offConnected: (() => void) | null = null

/**
 * Only the user's real Walnut runs the network: a test or throwaway server (the test
 * runner, an ephemeral child, a data home in a temp or task dir, a fake HOME) has a copied
 * config, and would put its own key in the Mac's place on the companion.
 * WALNUT_NET_ACTIVE=1 / 0 decides instead.
 */
export async function netActive(): Promise<boolean> {
  const flag = process.env.WALNUT_NET_ACTIVE
  if (flag === '1') return true
  if (flag === '0') return false
  const [{ semanticLaneDecision }, { IS_EPHEMERAL, WALNUT_HOME }] = await Promise.all([
    import('../search/semantic-default.js'), import('../../constants.js'),
  ])
  return semanticLaneDecision({ env: { ...process.env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on
}

/**
 * At boot (the leader only): sync now and every 10 minutes while the network is on,
 * and hand a machine the list each time this Mac reaches it (it may have been away
 * when the list changed).
 */
export async function startNet(): Promise<void> {
  if (timer) return
  timer = setInterval(() => { if (state.enabled) void syncNet() }, SYNC_EVERY_MS)
  timer.unref?.()
  const { addOnDaemonHostConnected } = await import('../../providers/daemon-connection.js')
  offConnected = addOnDaemonHostConnected((host) => {
    if (!state.syncedAt) return
    void pushTargets().then((rows) => { const row = rows.find(([name]) => name === host); if (row) void pushToHost(host, row[1], state) }).catch(() => {})
  })
  void syncNet()
}

export function stopNet(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (retry) clearTimeout(retry)
  retry = null
  retries = 0
  offConnected?.()
  offConnected = null
}

/** Take a machine out: it stops its walnut-net, the companion forgets it, this Mac drops its host row. */
export async function removeMachine(host: string): Promise<{ removed: string }> {
  const { getConfig } = await import('../config-manager.js')
  const def = (await getConfig()).hosts?.[host] as { transport?: string; endpoint?: string } | undefined
  if (!def || def.transport !== 'net' || !def.endpoint) throw new NetError(404, 'not_net_host', `${host} is not a machine on the host network`)
  const endpoint = def.endpoint
  removing.add(endpoint)
  try {
    // Kept in config first, so a restart halfway finishes the removal, never undoes it.
    await markRemoving(endpoint, true)
    // The companion forgets it first: if that fails, nothing else has changed, and the
    // machine keeps running (a machine told first would be cut off with its row still here).
    if (await companionPaired()) {
      let res: Awaited<ReturnType<typeof companionCall>>
      try {
        res = await companionCall(`/net/members/${endpoint}`, { method: 'DELETE' })
      } catch (err) {
        // Not reached (or no answer): Remove failed, so nothing changes. Had the companion
        // dropped it after all, the next sync puts the machine back on its list.
        await markRemoving(endpoint, false)
        throw err
      }
      if (res.status !== 200 && res.status !== 404) {
        await markRemoving(endpoint, false)
        const e = errorOf(res.body)
        throw new NetError(res.status, e.code, e.message)
      }
    }
    // Then the machine, while this Mac still reaches it (its own walnut-net still lists it):
    // it stops its walnut-net, which ends the link this very command rides, so the reply
    // may never come. Away, it is not told; it reaches nobody anyway (the relay refuses it,
    // and this Mac stops dialling it below).
    try {
      const { peekDaemonConnection } = await import('../../providers/daemon-connection.js')
      const conn = peekDaemonConnection(host)
      if (conn?.connected && conn.hasCapability('net-v1')) {
        const told = await conn.send('net.configure', { enabled: false }, 10_000).catch((err: Error) => ({ ok: false, error: err.message }))
        log.session.info('net: told a machine it is out', { host, ok: (told as { ok?: boolean }).ok, error: (told as { error?: string }).error })
      } else {
        log.session.info('net: a machine is taken out while away; it is not told', { host })
      }
    } catch (err) {
      log.session.warn('net: could not tell a machine it is out', { host, error: (err as Error).message })
    }
    if (syncing) await syncing.catch(() => {})
    await reconcileHosts([], { drop: endpoint })
    // Its row is gone: so is its connection, or its reconnect loop dials a machine that is out.
    try {
      const { dropDaemonConnection } = await import('../../providers/daemon-connection.js')
      dropDaemonConnection(host)
    } catch (err) {
      log.session.warn('net: could not drop a removed machine\'s connection', { host, error: (err as Error).message })
    }
    await setJoined(endpoint, null)
    await markRemoving(endpoint, false)
  } finally {
    removing.delete(endpoint)
  }
  await syncNet()
  return { removed: host }
}

/** The user's relay pick: every machine, then this Mac, moves to it (one away moves when it is back). */
export async function setRelay(pick: unknown): Promise<NetState> {
  if (pick !== 'own' && pick !== 'public' && pick !== 'none') throw new NetError(400, 'bad_relay', 'The relay is own, public or none.')
  const companion = await companionPaired()
  if (pick === 'own' && !companion) throw new NetError(400, 'no_companion', 'Your relay runs on your cloud companion; pair one first (Settings > Phones & Cloud).')
  if (pick !== 'own' && companion) throw new NetError(400, 'companion_relay', "While a cloud companion is paired, your machines use its relay.")
  if (pick === 'none' && state.enabled) {
    const cut = cutOffByNoRelay(await machineLinks(await localDaemon()))
    if (cut.length) {
      const names = cut.length === 1 ? cut[0] : `${cut.slice(0, -1).join(', ')} and ${cut.at(-1)}`
      throw new NetError(409, 'needs_relay', `No relay would cut off ${names}: ${cut.length === 1 ? 'it reaches' : 'they reach'} this machine only through a relay or a router. Keep Public relays, or put ${cut.length === 1 ? 'it' : 'them'} on the same network as this machine first.`)
    }
  }
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : {}
    if (net.relay === pick) return { write: false, result: undefined }
    net.relay = pick
    doc.net = net
    return { write: true, result: undefined }
  })
  if (syncing) await syncing.catch(() => {})
  const s = await syncNet()
  if (s.error) throw new NetError(502, 'not_applied', `Saved; it applies once the host network answers: ${s.error}`)
  return s
}

export function netState(): NetState {
  return { ...state }
}

/** Tests. */
export function resetNetForTest(): void {
  stopNet()
  Object.assign(state, { enabled: false, macId: null, companion: false, relay: 'public', relays: [], relayRoots: [], members: [], syncedAt: null, error: null })
  appliedRelay = null
  syncing = null
  leftoversTaken = false
}
