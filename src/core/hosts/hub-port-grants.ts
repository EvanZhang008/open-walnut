/**
 * Hub port grants a plugin made (`walnut.hosts.allowHubPort`, core/plugins/plugin-hosts.ts): the
 * second way a host is let onto one port of this Walnut's loopback through its hub forward,
 * beside `net.hub_ports` in config.yaml (core/hosts/hub-ports.ts merges both when it checks a
 * stream). A plugin that sets up its own program on a new machine (a model proxy whose spokes
 * reach the hub's copy on the Mac) allows that machine on ONE port it owns, without anyone
 * editing config.yaml.
 *
 *   - a plugin grants only a port its manifest declares (`hubPorts`, hub-port-manifest.ts);
 *   - a grant is in force only while its plugin runs and its manifest still declares the port:
 *     the running plugin's declaration is registered here when it starts and released when it
 *     stops (disabled, reloaded, removed), so a stream of a stopped plugin's grant is refused at
 *     once, whatever removed it;
 *   - the grants themselves are kept in Walnut's own state (`WALNUT_HOME/local/hub-port-grants.json`,
 *     never in git, never config.yaml), so they hold across restarts; a removed plugin's grants
 *     are dropped (dropHubGrantsNotDeclared, run by the primary after a complete plugin walk and
 *     when a plugin is removed while the server runs);
 *   - every refusal `net.hub_ports` has still applies to a granted port (127.0.0.1 only, Walnut's
 *     own ports never, at most 32 streams per host): hub-ports.ts checks those for both.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import type { HubPortDeclaration } from './hub-port-manifest.js'

export interface HubPortGrant {
  pluginId: string
  /** A host alias (config.yaml `hosts`). */
  host: string
  port: number
  /** When it was granted, in ms since the epoch. */
  at: number
}

/** A plugin's grants in force: one per port, the hosts allowed on it. */
export interface PluginHubPortRule {
  port: number
  hosts: string[]
  pluginId: string
}

export const MAX_HUB_GRANTS_PER_PLUGIN = 256

let fileOverride: string | null = null
function file(): string {
  return fileOverride ?? path.join(WALNUT_HOME, 'local', 'hub-port-grants.json')
}

let kept: HubPortGrant[] | null = null
let loading: Promise<HubPortGrant[]> | null = null
/** One writer at a time; the file is this server's alone. */
let chain: Promise<unknown> = Promise.resolve()

function validGrant(g: unknown): g is HubPortGrant {
  const x = (g ?? {}) as Partial<HubPortGrant>
  return typeof x.pluginId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(x.pluginId)
    && typeof x.host === 'string' && x.host.length > 0 && x.host.length <= 128
    && typeof x.port === 'number' && Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535
    && typeof x.at === 'number' && Number.isFinite(x.at)
}

async function load(): Promise<HubPortGrant[]> {
  if (kept) return kept
  loading ??= (async () => {
    const f = file()
    let text: string
    try {
      text = await fsp.readFile(f, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      // Unreadable now (permissions, a disk error): no grant, and nothing written over it.
      throw Object.assign(new Error(`The hub port grants file cannot be read (${(err as Error).message}); no plugin grant is in force.`), { code: 'grants_unreadable' })
    }
    try {
      const raw = JSON.parse(text) as { grants?: unknown }
      return Array.isArray(raw.grants) ? raw.grants.filter(validGrant) : []
    } catch {
      // Not JSON: kept aside for a look, never let a stream in by it, and the next grant starts a new file.
      const aside = `${f}.broken-${Date.now()}`
      await fsp.rename(f, aside).catch(() => {})
      const { log } = await import('../../logging/index.js')
      log.session.warn('hub port grants: the file was not JSON; it was set aside and no grant is in force', { file: aside })
      return []
    }
  })()
  try {
    const list = await loading
    kept ??= list
    return kept
  } finally {
    loading = null
  }
}

async function save(list: HubPortGrant[]): Promise<void> {
  const f = file()
  await fsp.mkdir(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`
  const fh = await fsp.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(`${JSON.stringify({ grants: list }, null, 2)}\n`, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, f)
  kept = list
}

/** Read-modify-write under the one writer; `change` returns the new list, or null for no write. */
function mutate<T>(change: (list: readonly HubPortGrant[]) => { next: HubPortGrant[] | null; result: T }): Promise<T> {
  const run = chain.then(async () => {
    const { next, result } = change(await load())
    if (next) await save(next)
    return result
  })
  chain = run.catch(() => undefined)
  return run
}

/** The running plugins' declared ports: pluginId to port to why. */
const live = new Map<string, Map<number, string>>()

/**
 * A running plugin's `hubPorts`: its grants of these ports are in force until the returned
 * release (its stop). A later declaration of the same plugin (a reload) replaces this one; the
 * earlier release then leaves the newer one alone.
 */
export function declareHubPorts(pluginId: string, ports: readonly HubPortDeclaration[]): () => void {
  const mine = new Map(ports.map((p) => [p.port, p.why]))
  live.set(pluginId, mine)
  return () => { if (live.get(pluginId) === mine) live.delete(pluginId) }
}

/** The ports the running plugin declared (empty when it is not running or declared none). */
export function declaredHubPorts(pluginId: string): ReadonlyMap<number, string> {
  return live.get(pluginId) ?? new Map()
}

/** Every grant as stored, in force or not. */
export async function listHubPortGrants(): Promise<HubPortGrant[]> {
  return [...await load()]
}

/** Add a grant (the caller checked the port, the host and the plugin). Resolves whether it is new. */
export function addHubPortGrant(pluginId: string, host: string, port: number, now: number = Date.now()): Promise<{ added: boolean }> {
  return mutate<{ added: boolean }>((list) => {
    if (list.some((g) => g.pluginId === pluginId && g.host === host && g.port === port)) return { next: null, result: { added: false } }
    if (list.filter((g) => g.pluginId === pluginId).length >= MAX_HUB_GRANTS_PER_PLUGIN) {
      throw Object.assign(new Error(`A plugin holds at most ${MAX_HUB_GRANTS_PER_PLUGIN} hub port grants; revoke one first.`), { code: 'too_many_grants' })
    }
    return { next: [...list, { pluginId, host, port, at: now }], result: { added: true } }
  })
}

export function removeHubPortGrant(pluginId: string, host: string, port: number): Promise<{ removed: boolean }> {
  return mutate<{ removed: boolean }>((list) => {
    const next = list.filter((g) => !(g.pluginId === pluginId && g.host === host && g.port === port))
    return next.length === list.length ? { next: null, result: { removed: false } } : { next, result: { removed: true } }
  })
}

/** The grants in force now: their plugin runs and still declares the port. */
export async function hubPortGrantRules(): Promise<PluginHubPortRule[]> {
  const list = await load()
  const byKey = new Map<string, PluginHubPortRule>()
  for (const g of list) {
    if (!live.get(g.pluginId)?.has(g.port)) continue
    const key = `${g.pluginId}\u0000${g.port}`
    const rule = byKey.get(key)
    if (rule) { if (!rule.hosts.includes(g.host)) rule.hosts.push(g.host) } else byKey.set(key, { port: g.port, hosts: [g.host], pluginId: g.pluginId })
  }
  return [...byKey.values()]
}

/**
 * Drop every grant whose plugin is not installed any more, or whose manifest no longer declares
 * its port, or (with `hosts`) whose host left Settings. `declared` is every discovered plugin
 * (enabled or not) with the ports its manifest declares, so a plugin switched off keeps its grants
 * for when it is on again (they are not in force meanwhile). Run by the primary after a complete
 * plugin walk only; a plugin whose manifest could not be read that boot loses its grants and makes
 * them again when it next allows its hosts. Resolves how many went.
 */
export function dropHubGrantsNotDeclared(declared: ReadonlyMap<string, ReadonlySet<number>>, hosts?: ReadonlySet<string>): Promise<number> {
  return mutate((list) => {
    const next = list.filter((g) => declared.get(g.pluginId)?.has(g.port) === true && (!hosts || hosts.has(g.host)))
    return next.length === list.length ? { next: null, result: 0 } : { next, result: list.length - next.length }
  })
}

/** Tests: point the store at a temp file (null = back to WALNUT_HOME); forgets what was read. */
export function setHubPortGrantsFileForTest(f: string | null): void {
  fileOverride = f
  kept = null
  loading = null
}

/** Tests: forget the running plugins' declarations and what was read. */
export function resetHubPortGrantsForTest(): void {
  live.clear()
  kept = null
  loading = null
}
