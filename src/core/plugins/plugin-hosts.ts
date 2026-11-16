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
  const hosts = ((await getConfig()).hosts ?? {}) as Record<string, HostDef>
  return [
    { alias: LOCAL_HOST_ALIAS, local: true, enabled: true },
    ...Object.entries(hosts).filter(([alias]) => alias !== LOCAL_HOST_ALIAS).map(([alias, def]) => hostInfo(alias, def ?? {})),
  ]
}

export async function getPluginHost(alias: string): Promise<PluginHostInfo | null> {
  return (await listPluginHosts()).find((host) => host.alias === alias) ?? null
}

export type SpawnLike = typeof spawn

export async function runOnPluginHost(
  alias: string,
  input: PluginHostRunInput,
  spawnImpl: SpawnLike = spawn,
): Promise<PluginHostRunResult> {
  const checked = checkScriptInput(input)
  if ('error' in checked) throw new Error(checked.error)
  const host = await getPluginHost(alias)
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
