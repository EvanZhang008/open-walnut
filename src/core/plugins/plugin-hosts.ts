/**
 * `walnut.hosts` for plugins: the hosts Walnut knows (Settings, Hosts) and one way to run a
 * short script on one of them, so a plugin never reads Walnut's host list through the config
 * API or builds an ssh command line of its own.
 *
 * A run is a POSIX sh script on stdin (`sh -s`) with literal positional arguments. On this
 * machine it runs directly; on any other host it goes through the link to that host's daemon,
 * the same way host_exec does (src/core/hosts/host-script.ts), whichever way the link goes (SSH,
 * the host network). Output and time are bounded; a run past either cap ends and says so
 * instead of filling memory or hanging.
 */

import { spawn } from 'node:child_process'
import { getConfig } from '../config-manager.js'
import { hubPortRules, hubPortStatus, type HubPortStatus } from '../hosts/hub-ports.js'
import { checkScriptInput, runBoundedScript, SCRIPT_STDERR_TAIL, type ScriptInput, type ScriptResult } from '../../providers/host-script-core.js'

export const LOCAL_HOST_ALIAS = '__local__'

export interface PluginHostInfo {
  alias: string
  label?: string
  local: boolean
  enabled: boolean
  hostname?: string
  user?: string
  port?: number
  /**
   * The ports of this Walnut's own loopback `net.hub_ports` opens to this host, and whether the
   * host's hub forward to each is up and when it last connected (core/hosts/hub-ports.ts).
   * Absent when none is listed for it.
   */
  hub?: HubPortStatus[]
}

/** A run's input and answer: the shared runner's (host-script-core.ts), on this machine and on a host's daemon alike. */
export type PluginHostRunInput = ScriptInput
export type PluginHostRunResult = ScriptResult

type HostDef = { hostname?: unknown; user?: unknown; port?: unknown; label?: unknown; enabled?: unknown }

function hostInfo(alias: string, def: HostDef): PluginHostInfo {
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

export async function listPluginHosts(): Promise<PluginHostInfo[]> {
  const config = await getConfig()
  const rows = configuredHosts(config)
  return Promise.all(rows.map((row) => withHub(row, config)))
}

export async function getPluginHost(alias: string): Promise<PluginHostInfo | null> {
  const config = await getConfig()
  const row = configuredHosts(config).find((host) => host.alias === alias)
  return row ? withHub(row, config) : null
}

/** This machine first, then every host in Settings, Hosts: what the config says, nothing asked of a host. */
function configuredHosts(config: Awaited<ReturnType<typeof getConfig>>): PluginHostInfo[] {
  const hosts = (config.hosts ?? {}) as Record<string, HostDef>
  return [
    { alias: LOCAL_HOST_ALIAS, local: true, enabled: true },
    ...Object.entries(hosts).filter(([alias]) => alias !== LOCAL_HOST_ALIAS).map(([alias, def]) => hostInfo(alias, def ?? {})),
  ]
}

/** A host `net.hub_ports` names, with its hub status (at most a short wait for its daemon's word). */
async function withHub(row: PluginHostInfo, config: Awaited<ReturnType<typeof getConfig>>): Promise<PluginHostInfo> {
  if (row.local || !hubPortRules(config).rules.some((r) => r.hosts.includes(row.alias))) return row
  // A status that cannot be read never fails the list.
  const hub = await hubPortStatus(row.alias, { config }).catch(() => null)
  return hub && hub.length ? { ...row, hub } : row
}

export type SpawnLike = typeof spawn

export async function runOnPluginHost(
  alias: string,
  input: PluginHostRunInput,
  spawnImpl: SpawnLike = spawn,
): Promise<PluginHostRunResult> {
  const checked = checkScriptInput(input)
  if ('error' in checked) throw new Error(checked.error)
  // The hosts as configured: a run never waits on anyone's hub status.
  const host = configuredHosts(await getConfig()).find((h) => h.alias === alias)
  if (!host) throw new Error(`Walnut has no host named "${alias}" (Settings, Hosts).`)
  if (host.local) {
    return runBoundedScript({
      spawn: spawnImpl, command: 'sh', argv: ['-s', '--', ...checked.args],
      killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    }, checked)
  }
  // Every other host through its link (a test server's isolation is the link's: daemon-connection.ts).
  const { runScriptOnHost } = await import('../hosts/host-script.js')
  try {
    return await runScriptOnHost(alias, checked)
  } catch (err) {
    // Not reached, or the host could not run it: a failed run with the reason, as ssh's 255 was.
    return { code: 255, stdout: '', stderr: `walnut: ${err instanceof Error ? err.message : String(err)}`.slice(-SCRIPT_STDERR_TAIL), timedOut: false, truncated: false }
  }
}
