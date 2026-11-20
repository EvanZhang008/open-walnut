/**
 * `walnut.hosts` for plugins: the hosts Walnut knows (Settings, Hosts), one way to run a short
 * script on one of them, one way to put a file there (`push`, plugin-host-push.ts), the hub ports
 * a plugin lets a host reach (`allowHubPort`, core/hosts/hub-port-grants.ts), and a word when a
 * host's link comes up, so a plugin never reads Walnut's host list through the config API or
 * builds an ssh command line of its own.
 *
 * A run is a POSIX sh script on stdin (`sh -s`) with literal positional arguments. On this
 * machine it runs directly; on any other host it goes through the link to that host's daemon,
 * the same way host_exec does (src/core/hosts/host-script.ts), whichever way the link goes (SSH,
 * the host network). Output and time are bounded; a run past either cap ends and says so
 * instead of filling memory or hanging.
 */

import { spawn } from 'node:child_process'
import { getConfig } from '../config-manager.js'
import { allHubPortRules, hubForwardsFileOf, hubPortStatus, ownWalnutPorts, type HubPortRule, type HubPortStatus } from '../hosts/hub-ports.js'
import { checkScriptInput, runBoundedScript, SCRIPT_STDERR_TAIL, type ScriptInput, type ScriptResult } from '../../providers/host-script-core.js'

export const LOCAL_HOST_ALIAS = '__local__'

/** What a host runs, in the names release builds use (Go's): pick the binary by these. */
export interface PluginHostPlatform {
  /** `darwin`, `linux`, `windows`, or the host's own word for another. */
  os: string
  /** `arm64`, `amd64`, `386`, `arm`, or the host's own word for another. */
  arch: string
}

export interface PluginHostInfo {
  alias: string
  label?: string
  local: boolean
  enabled: boolean
  hostname?: string
  user?: string
  port?: number
  /** What the host runs, from what Walnut already knows of it; null before Walnut heard. */
  platform: PluginHostPlatform | null
  /**
   * The ports of this Walnut's own loopback `net.hub_ports` or a plugin's grant opens to this
   * host, and whether the host's hub forward to each is up, when it last connected and who allowed
   * it (core/hosts/hub-ports.ts). Absent when none is open to it.
   */
  hub?: HubPortStatus[]
  /** The host's own hub forwards file, as its daemon named it; with `hub`, once known. */
  hubForwardsFile?: string
}

/** A run's input and answer: the shared runner's (host-script-core.ts), on this machine and on a host's daemon alike. */
export type PluginHostRunInput = ScriptInput
export type PluginHostRunResult = ScriptResult

type HostDef = { hostname?: unknown; user?: unknown; port?: unknown; label?: unknown; enabled?: unknown }
type Row = Omit<PluginHostInfo, 'platform'>

function hostInfo(alias: string, def: HostDef): Row {
  const port = typeof def.port === 'number' && Number.isInteger(def.port) && def.port > 0 && def.port < 65536 ? def.port : undefined
  return {
    alias,
    ...(typeof def.label === 'string' && def.label.trim() ? { label: def.label.trim() } : {}),
    local: false,
    enabled: def.enabled !== false,
    ...(typeof def.hostname === 'string' && def.hostname.trim() ? { hostname: def.hostname.trim() } : {}),
    ...(typeof def.user === 'string' && def.user.trim() ? { user: def.user.trim() } : {}),
    ...(port ? { port } : {}),
  }
}

/** Node's platform and arch words (or uname's) as release builds name them. */
export function platformOf(platform: unknown, arch: unknown): PluginHostPlatform | null {
  if (typeof platform !== 'string' || !platform.trim() || typeof arch !== 'string' || !arch.trim()) return null
  const p = platform.trim().toLowerCase()
  const a = arch.trim().toLowerCase()
  const os = p === 'win32' ? 'windows' : p
  const ARCH: Record<string, string> = { x64: 'amd64', x86_64: 'amd64', amd64: 'amd64', arm64: 'arm64', aarch64: 'arm64', ia32: '386', x86: '386', i386: '386', i686: '386', arm: 'arm', armv7l: 'arm' }
  return { os, arch: ARCH[a] ?? a }
}

/** What Walnut already knows a host runs: this machine's own, else its last probe, else its last preflight. */
async function knownPlatform(row: Row): Promise<PluginHostPlatform | null> {
  if (row.local) return platformOf(process.platform, process.arch)
  try {
    const { readHostProfile } = await import('../hosts/host-profile.js')
    const probed = (await readHostProfile(row.alias)).probed
    const fromProbe = platformOf(probed?.os?.platform, probed?.arch)
    if (fromProbe) return fromProbe
  } catch { /* no profile: the preflight below */ }
  try {
    const { store } = await import('../hosts/host-readiness-store.js')
    const r = store.get(row.alias)
    return platformOf(r?.platform, r?.arch)
  } catch {
    return null
  }
}

/** How long `get` waits for a connected host's daemon to say what it runs, when Walnut does not know yet. */
const PLATFORM_ASK_MS = 5_000

/** A connected host whose platform Walnut has not heard yet is asked once (host.facts, no network probes), at most PLATFORM_ASK_MS. */
async function askPlatform(alias: string): Promise<PluginHostPlatform | null> {
  try {
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
    const conn = getConnectedDaemonConnection(alias)
    if (!conn?.connected || !conn.hasCapability('host-facts-v1')) return null
    const { probeHostFacts } = await import('../transfer/daemon-transfer-client.js')
    let timer: ReturnType<typeof setTimeout> | undefined
    const facts = await Promise.race([
      probeHostFacts(alias, { network: false }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PLATFORM_ASK_MS); timer.unref?.() }),
    ]).finally(() => clearTimeout(timer))
    if (!facts?.os) return null
    const { recordProbedFacts } = await import('../hosts/host-profile.js')
    void recordProbedFacts(alias, facts).catch(() => {})
    return platformOf(facts.os.platform, facts.arch)
  } catch {
    return null
  }
}

export async function listPluginHosts(): Promise<PluginHostInfo[]> {
  const config = await getConfig()
  const rows = configuredHosts(config)
  const rules = await allHubPortRules(config)
  return Promise.all(rows.map(async (row) => ({ ...await withHub(row, rules), platform: await knownPlatform(row) })))
}

export async function getPluginHost(alias: string): Promise<PluginHostInfo | null> {
  const config = await getConfig()
  const row = configuredHosts(config).find((host) => host.alias === alias)
  if (!row) return null
  const [withPorts, known] = await Promise.all([withHub(row, await allHubPortRules(config)), knownPlatform(row)])
  return { ...withPorts, platform: known ?? (row.local ? null : await askPlatform(alias)) }
}

/** This machine first, then every host in Settings, Hosts: what the config says, nothing asked of a host. */
function configuredHosts(config: Awaited<ReturnType<typeof getConfig>>): Row[] {
  const hosts = (config.hosts ?? {}) as Record<string, HostDef>
  return [
    { alias: LOCAL_HOST_ALIAS, local: true, enabled: true },
    ...Object.entries(hosts).filter(([alias]) => alias !== LOCAL_HOST_ALIAS).map(([alias, def]) => hostInfo(alias, def ?? {})),
  ]
}

/** A host a hub rule names, with its hub status (at most a short wait for its daemon's word). */
async function withHub(row: Row, rules: HubPortRule[]): Promise<Row> {
  if (row.local || !rules.some((r) => r.hosts.includes(row.alias))) return row
  // A status that cannot be read never fails the list.
  const hub = await hubPortStatus(row.alias, { rules }).catch(() => null)
  if (!hub || hub.length === 0) return row
  const file = hubForwardsFileOf(row.alias)
  return { ...row, hub, ...(file ? { hubForwardsFile: file } : {}) }
}

/** The host as configured, or a throw naming it: never waits on anyone's hub status. */
export async function configuredPluginHost(alias: string): Promise<Row> {
  const host = configuredHosts(await getConfig()).find((h) => h.alias === alias)
  if (!host) throw Object.assign(new Error(`Walnut has no host named "${alias}" (Settings, Hosts).`), { code: 'unknown_host' })
  return host
}

export type SpawnLike = typeof spawn

/** One checked script on a host; a host Walnut cannot reach, or that refused it, throws with why. */
export async function runCheckedScript(host: Row, checked: Exclude<ReturnType<typeof checkScriptInput>, { error: string }>, spawnImpl: SpawnLike = spawn): Promise<PluginHostRunResult> {
  if (host.local) {
    return runBoundedScript({
      spawn: spawnImpl, command: 'sh', argv: ['-s', '--', ...checked.args],
      killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    }, checked)
  }
  // Every other host through its link (a test server's isolation is the link's: daemon-connection.ts).
  const { runScriptOnHost } = await import('../hosts/host-script.js')
  return runScriptOnHost(host.alias, checked)
}

export async function runOnPluginHost(
  alias: string,
  input: PluginHostRunInput,
  spawnImpl: SpawnLike = spawn,
): Promise<PluginHostRunResult> {
  const checked = checkScriptInput(input)
  if ('error' in checked) throw new Error(checked.error)
  const host = await configuredPluginHost(alias)
  try {
    return await runCheckedScript(host, checked, spawnImpl)
  } catch (err) {
    // Not reached, or the host could not run it: a failed run with the reason, as ssh's 255 was.
    return { code: 255, stdout: '', stderr: `walnut: ${err instanceof Error ? err.message : String(err)}`.slice(-SCRIPT_STDERR_TAIL), timedOut: false, truncated: false }
  }
}

function refusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The checks every grant call makes: a port this running plugin declared, and a host in Settings that is not this machine. */
async function grantTarget(pluginId: string, alias: string, port: unknown, call: string): Promise<number> {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw refusal(`${call}: port must be a TCP port (1 to 65535).`, 'bad_request')
  if (typeof alias !== 'string' || !alias) throw refusal(`${call}: name a host (an alias from walnut.hosts.list()).`, 'bad_request')
  if (alias === LOCAL_HOST_ALIAS) throw refusal(`${call}: this machine reaches its own loopback directly; a hub port is for another host.`, 'bad_request')
  await configuredPluginHost(alias)
  const { declaredHubPorts } = await import('../hosts/hub-port-grants.js')
  if (!declaredHubPorts(pluginId).has(port)) {
    throw refusal(`${call}: port ${port} is not in this plugin's manifest "hubPorts"; a plugin opens only a port it declares there.`, 'undeclared_port')
  }
  return port
}

/** `walnut.hosts.allowHubPort`: let `alias`'s hub forward reach `port` on this Walnut, as the plugin's own grant. */
export async function allowPluginHubPort(pluginId: string, alias: string, port: unknown, walnutPorts: () => Promise<number[]> = ownWalnutPorts): Promise<{ added: boolean }> {
  const p = await grantTarget(pluginId, alias, port, 'hosts.allowHubPort')
  if ((await walnutPorts().catch(() => [] as number[])).includes(p)) {
    throw refusal(`hosts.allowHubPort: port ${p} is Walnut's own on this machine (its server or session daemon), which a hub stream never reaches.`, 'walnut_port')
  }
  const { addHubPortGrant } = await import('../hosts/hub-port-grants.js')
  return addHubPortGrant(pluginId, alias, p)
}

/** `walnut.hosts.revokeHubPort`: the plugin's grant goes; a stream after this is refused (one open now runs to its end). */
export async function revokePluginHubPort(pluginId: string, alias: string, port: unknown): Promise<{ removed: boolean }> {
  if (typeof port !== 'number' || !Number.isInteger(port)) throw refusal('hosts.revokeHubPort: port must be a TCP port (1 to 65535).', 'bad_request')
  const { removeHubPortGrant } = await import('../hosts/hub-port-grants.js')
  return removeHubPortGrant(pluginId, alias, port)
}

/**
 * `walnut.hosts.onConnect`: `handler` hears each time Walnut's link to a host in Settings comes up
 * (its first connect after it was added, and every reconnect: after a restart of either side, a
 * sleep, a network change). Never for this machine. Returns the unsubscribe.
 */
export async function onPluginHostConnect(handler: (alias: string) => void): Promise<() => void> {
  const { addOnDaemonHostConnected } = await import('../../providers/daemon-connection.js')
  return addOnDaemonHostConnected((hostKey) => {
    if (!hostKey || hostKey === LOCAL_HOST_ALIAS || hostKey.startsWith('direct:')) return
    void getConfig().then((config) => {
      if (Object.hasOwn(config.hosts ?? {}, hostKey)) handler(hostKey)
    }).catch(() => {})
  })
}
