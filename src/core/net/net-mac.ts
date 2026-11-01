/**
 * The host network from the Mac (docs/reference/host-network.md). The cloud companion
 * keeps the member list and checks every join (core/net/net-store.ts, routes/net-v1.ts);
 * this Mac:
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

const CALL_TIMEOUT_MS = 15_000
const SYNC_EVERY_MS = 10 * 60_000
const POLL_MS = 3_000

export class NetError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'NetError'
  }
}

export interface NetMember { id: string; name: string; role: 'mac' | 'host'; platform?: string; addedAt?: number }

export interface NetState {
  enabled: boolean
  macId: string | null
  relays: string[]
  relayRoots: string[]
  members: NetMember[]
  syncedAt: number | null
  error: string | null
}

const state: NetState = { enabled: false, macId: null, relays: [], relayRoots: [], members: [], syncedAt: null, error: null }
let syncing: Promise<NetState> | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function companionCall(p: string, init: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  // A test server holds a copy of the real pairing: one call from it would put its key in
  // the Mac's place on the user's companion.
  if (!await netActive()) throw new NetError(409, 'test_server', 'The host network runs only on your own Walnut, not on a test server.')
  const [{ getCloudPairingEndpointAsync }, { machineProofHeaders }] = await Promise.all([
    import('../pairing-targets.js'), import('../../integrations/cloud-bridge-config.js'),
  ])
  const cloud = await getCloudPairingEndpointAsync()
  if (!cloud) throw new NetError(400, 'no_companion', 'Adding machines goes through your cloud companion; pair one first (Settings > Cloud Companion).')
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

function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  const e = body.error as { code?: unknown; message?: unknown } | string | undefined
  if (typeof e === 'string') return { code: 'refused', message: e }
  return { code: typeof e?.code === 'string' ? e.code : 'refused', message: typeof e?.message === 'string' ? e.message : 'The cloud companion refused' }
}

async function localDaemon() {
  const { link } = await import('../hosts/link.js')
  const local = await link('__local__')
  if (!local.hasCapability('net-v1')) throw new NetError(409, 'daemon_too_old', "This Mac's Walnut daemon has no host network yet; restart Walnut to update it.")
  return local
}

/** What this Mac's own walnut-net is told: dial every host member, let none in. */
function macConfig(s: NetState): Record<string, unknown> {
  return {
    relays: s.relays, relayRoots: s.relayRoots,
    members: s.members.filter((m) => m.role === 'host' && m.id !== s.macId).map((m) => ({ id: m.id, name: m.name, accept: false })),
  }
}

/** What each joined machine is told: let in this Mac (every `mac` member). */
function hostConfig(s: NetState): Record<string, unknown> {
  return {
    relays: s.relays, relayRoots: s.relayRoots,
    members: s.members.filter((m) => m.role === 'mac').map((m) => ({ id: m.id, name: m.name, accept: true })),
  }
}

/**
 * The hostname of a host network row: a name that never resolves (`.invalid`), so an
 * older Walnut, which reads the row as an SSH host, fails at once instead of reaching
 * some other machine of that name. This Mac dials the endpoint, never the hostname.
 */
export function netHostname(alias: string): string {
  return `${alias}.walnut-net.invalid`
}

type HostRows = Record<string, Record<string, unknown>>

function netRows(hosts: HostRows): Array<[string, Record<string, unknown> & { endpoint: string }]> {
  return Object.entries(hosts).filter((e): e is [string, Record<string, unknown> & { endpoint: string }] =>
    !!e[1] && e[1].transport === 'net' && typeof e[1].endpoint === 'string')
}

/** `name`, else `name-net`, `name-net-2`, ...: never a row already there. */
function freeAlias(name: string, hosts: HostRows): string {
  if (!Object.hasOwn(hosts, name)) return name
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? `${name}-net` : `${name}-net-${i}`
    if (!Object.hasOwn(hosts, n)) return n
  }
  return `${name}-net-${Date.now().toString(36)}`
}

/**
 * Make config.hosts hold every host member: a row per machine, matched by its endpoint
 * (a row keeps its name). A row whose machine the list lacks stays (syncNet puts it back
 * on the list); only `drop`, the machine Remove takes out, loses its row.
 */
async function reconcileHosts(members: NetMember[], opts: { drop?: string } = {}): Promise<{ added: string[]; removed: string[] }> {
  const { modifyConfigDoc } = await import('../config-store.js')
  return modifyConfigDoc((doc) => {
    const hosts: HostRows = doc.hosts && typeof doc.hosts === 'object' && !Array.isArray(doc.hosts) ? { ...(doc.hosts as HostRows) } : {}
    const added: string[] = []
    const removed: string[] = []
    let changed = false
    const byEndpoint = new Map<string, string>()
    for (const [alias, h] of netRows(hosts)) {
      if (opts.drop && h.endpoint === opts.drop) { delete hosts[alias]; removed.push(alias); continue }
      byEndpoint.set(h.endpoint, alias)
      // A row an earlier version wrote with a plain hostname gets the one that never resolves.
      if (h.hostname !== netHostname(alias)) { hosts[alias] = { ...h, hostname: netHostname(alias) }; changed = true }
    }
    // A row an older Remote Hosts editor saved without its transport and endpoint: its
    // never-resolving hostname still marks it, and the member of its name (the row's
    // label, else its alias: the user may have renamed the label) takes it back.
    const lost: Array<{ alias: string; label: string | null }> = []
    for (const [alias, h] of Object.entries(hosts)) {
      if (h && h.transport === undefined && h.hostname === netHostname(alias)) lost.push({ alias, label: typeof h.label === 'string' && h.label ? h.label : null })
    }
    for (const m of members) {
      if (m.role !== 'host' || m.id === opts.drop || byEndpoint.has(m.id)) continue
      let at = lost.findIndex((l) => l.label === m.name)
      if (at < 0) at = lost.findIndex((l) => l.alias === m.name)
      if (at >= 0) {
        const back = lost[at].alias
        hosts[back] = { ...hosts[back], transport: 'net', endpoint: m.id }
        byEndpoint.set(m.id, back)
        lost.splice(at, 1)
        changed = true
        continue
      }
      const alias = freeAlias(m.name, hosts)
      hosts[alias] = { hostname: netHostname(alias), label: m.name, transport: 'net', endpoint: m.id, enabled: true }
      byEndpoint.set(m.id, alias)
      added.push(alias)
    }
    if (!changed && added.length === 0 && removed.length === 0) return { write: false, result: { added, removed } }
    doc.hosts = hosts
    return { write: true, result: { added, removed } }
  })
}

/** Endpoints Remove is taking out right now (this process): never put back on the list. */
const removing = new Set<string>()

/**
 * `net.removing` in config: machines Remove has started to take out. Kept across a
 * restart, so a removal cut short is finished by the next sync instead of the machine
 * being put back on the list.
 */
async function removalsPending(): Promise<string[]> {
  const { getConfig } = await import('../config-manager.js')
  const r = ((await getConfig()) as { net?: { removing?: unknown } }).net?.removing
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

async function markRemoving(endpoint: string, on: boolean): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : {}
    const was = Array.isArray(net.removing) ? (net.removing as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const next = on ? [...new Set([...was, endpoint])] : was.filter((x) => x !== endpoint)
    if (next.length === was.length && next.every((x, i) => x === was[i])) return { write: false, result: undefined }
    if (next.length) net.removing = next
    else delete net.removing
    doc.net = net
    return { write: true, result: undefined }
  })
}

/** Finish removals a restart cut short: the companion forgets the machine, its row goes. */
async function finishRemovals(): Promise<void> {
  for (const endpoint of await removalsPending()) {
    if (removing.has(endpoint)) continue
    const r = await companionCall(`/net/members/${endpoint}`, { method: 'DELETE' })
    if (r.status !== 200 && r.status !== 404) continue
    await reconcileHosts([], { drop: endpoint })
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
  try { await conn.send('net.configure', hostConfig(s), 20_000) } catch (err) { log.session.warn('net: could not hand a machine its member list', { host: name, error: (err as Error).message }) }
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
 * Read the companion's list and apply it here (single flight). `enable` turns the
 * network on first; a sync already running without it is waited for, then one runs.
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
      const cfg = await getConfig() as { net?: { enabled?: boolean } }
      state.enabled = cfg.net?.enabled === true
      if (!state.enabled) return { ...state }
      const local = await localDaemon()
      const ident = await local.send('net.identity', {}, 20_000) as { ok?: boolean; endpointId?: string; error?: string }
      if (!ident.ok || !ident.endpointId) throw new NetError(500, 'no_identity', `This Mac's network key: ${ident.error ?? 'none'}`)
      state.macId = ident.endpointId
      await finishRemovals()
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
      const conf = await local.send('net.configure', macConfig(state), 30_000) as { ok?: boolean; error?: string }
      if (!conf.ok) throw new NetError(500, 'net_start_failed', `This Mac's walnut-net: ${conf.error ?? 'did not start'}`)
      const changed = await reconcileHosts(state.members)
      if (changed.added.length || changed.removed.length) log.session.info('net: hosts updated from the member list', changed)
      void pushToHosts({ ...state })
      state.syncedAt = Date.now()
      state.error = null
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      log.session.warn('net: sync failed', { error: state.error })
      if (err instanceof NetError && opts.enable) throw err
    } finally {
      syncing = null
    }
    return { ...state }
  })()
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
  offConnected?.()
  offConnected = null
}

// ── Invites ──

export interface InviteState {
  id: string
  link: string
  command: string
  expiresAt: number
  state: 'waiting' | 'joined' | 'expired' | 'failed'
  member?: { id: string; name: string; platform?: string }
  error?: string
}

const invites = new Map<string, InviteState & { timer?: ReturnType<typeof setInterval> }>()

function view(i: InviteState): InviteState {
  const { timer: _t, ...rest } = i as InviteState & { timer?: unknown }
  return rest
}

async function pollInvite(id: string): Promise<void> {
  const inv = invites.get(id)
  if (!inv || inv.state !== 'waiting') return
  if (Date.now() > inv.expiresAt + POLL_MS) { settle(inv, { state: 'expired' }); return }
  try {
    const { status, body } = await companionCall(`/net/invites/${encodeURIComponent(id)}`, { method: 'GET' })
    if (status === 404) { settle(inv, { state: 'expired' }); return }
    if (status !== 200) return
    if (body.state === 'joined') {
      settle(inv, { state: 'joined', ...(body.member ? { member: body.member as InviteState['member'] } : {}) })
      log.session.info('net: a machine joined', { invite: id, name: inv.member?.name })
      await syncNet()
    } else if (body.state === 'expired') settle(inv, { state: 'expired' })
  } catch (err) {
    log.session.debug('net: invite check failed', { id, error: (err as Error).message })
  }
}

function settle(inv: InviteState & { timer?: ReturnType<typeof setInterval> }, next: Partial<InviteState>): void {
  Object.assign(inv, next)
  if (inv.timer) clearInterval(inv.timer)
  inv.timer = undefined
}

/** A new invite (turns the network on first). */
export async function makeInvite(input: { name?: unknown }): Promise<InviteState> {
  for (const [id, i] of invites) if (i.state !== 'waiting' && Date.now() - i.expiresAt > 60 * 60_000) invites.delete(id)
  const s = await syncNet({ enable: true })
  if (s.error) throw new NetError(502, 'net_unavailable', s.error)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined
  const { status, body } = await companionCall('/net/invites', { method: 'POST', body: name ? { name } : {} })
  if (status !== 201) { const e = errorOf(body); throw new NetError(status, e.code, e.message) }
  const inv: InviteState & { timer?: ReturnType<typeof setInterval> } = {
    id: String(body.id), link: String(body.link), command: String(body.command), expiresAt: Number(body.expiresAt), state: 'waiting',
  }
  inv.timer = setInterval(() => { void pollInvite(inv.id) }, POLL_MS)
  inv.timer.unref?.()
  invites.set(inv.id, inv)
  return view(inv)
}

export function inviteStatus(id: string): InviteState | null {
  const i = invites.get(id)
  return i ? view(i) : null
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
    await markRemoving(endpoint, false)
  } finally {
    removing.delete(endpoint)
  }
  await syncNet()
  return { removed: host }
}

export function netState(): NetState {
  return { ...state }
}

/** Tests. */
export function resetNetForTest(): void {
  stopNet()
  for (const i of invites.values()) if (i.timer) clearInterval(i.timer)
  invites.clear()
  Object.assign(state, { enabled: false, macId: null, relays: [], relayRoots: [], members: [], syncedAt: null, error: null })
  syncing = null
}
