/**
 * Default probes for the doctor's HOSTS half. The status comes from the same
 * pieces GET /api/hosts/status uses (buildHostStatus over the connect state, the
 * warmup queue and the stored host.preflight answer), so the doctor and the
 * Settings pane never disagree about a host, including the connect-side runtime,
 * daemon dir and warnings. The one extra fact, the daemon's version, is a
 * `hello` on the already-open connection: it never dials, and a host that is
 * not connected is simply reported as such.
 */

import path from 'node:path'
import { CLOUD_MODE } from '../../constants.js'
import { buildHostStatus, listStatusHosts } from '../hosts/host-status.js'
import { getHostReadiness } from '../hosts/host-readiness.js'
import { getHostWarmup } from '../hosts/host-warmup-registry.js'
import { parsePreflight } from '../hosts/host-readiness-problems.js'
import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import type { DaemonConnectState } from '../../providers/daemon-connection.js'
import type { HostDiagnostics } from './types.js'

export interface DaemonHello {
  version: string | null
  runtime: string | null
}

/**
 * Which runtime runs the daemon, from the executable a service-mode daemon
 * reports (`serviceExecutable` in its hello). An on-demand daemon does not say,
 * so the answer is null rather than a guess.
 */
export function runtimeFromExecutable(executable: unknown): string | null {
  if (typeof executable !== 'string' || !executable.trim()) return null
  const name = path.basename(executable.trim()).toLowerCase()
  if (name === 'bun' || name.startsWith('bun-')) return 'bun'
  if (name === 'node' || name === 'nodejs') return 'node'
  return 'binary'
}

async function connectState(key: string): Promise<DaemonConnectState> {
  if (CLOUD_MODE) {
    const { bridgeForHost } = await import('../../web/ws/bridge-registry.js')
    const connected = bridgeForHost(key).connected
    return { host: key, connected, phase: connected ? 'connected' : 'idle', phaseElapsedMs: 0, connectElapsedMs: 0 }
  }
  const { getDaemonConnectState } = await import('../../providers/daemon-connection.js')
  return getDaemonConnectState(key)
}

/**
 * The connect-side facts HostStatus carries (runtime, daemon dir, warnings),
 * read defensively: every one is optional there and older shapes lack them.
 */
function connectFacts(status: object, state: object): Pick<HostDiagnostics, 'runtime' | 'daemonDir' | 'warnings'> {
  const s = status as { runtime?: unknown; daemonDir?: unknown; warnings?: unknown }
  const home = (state as { daemonDir?: { home?: unknown } }).daemonDir?.home
  const runtime = typeof s.runtime === 'string' && s.runtime && s.runtime !== 'unknown' ? s.runtime : null
  let daemonDir: HostDiagnostics['daemonDir'] = null
  const d = s.daemonDir as { display?: unknown; path?: unknown; fallback?: unknown; freeMb?: unknown } | undefined
  const display = typeof d?.display === 'string' && d.display ? d.display : typeof d?.path === 'string' && d.path ? d.path : null
  if (display) {
    daemonDir = { display, fallback: d?.fallback === true }
    if (typeof d?.freeMb === 'number' && Number.isFinite(d.freeMb)) daemonDir.freeMb = d.freeMb
    // The host's home: redaction masks its last segment (the remote user name).
    if (typeof home === 'string' && home.startsWith('/')) daemonDir.home = home
  }
  const warnings = Array.isArray(s.warnings) ? s.warnings.filter((w): w is string => typeof w === 'string' && !!w.trim()) : []
  return { runtime, daemonDir, warnings }
}

/** Every host the folder picker offers, with where its connection stands. No I/O beyond config. */
export async function listHostDiagnostics(): Promise<HostDiagnostics[]> {
  const { getConfig } = await import('../config-manager.js')
  const entries = listStatusHosts(await getConfig())
  const warmup = CLOUD_MODE ? {} : getHostWarmup()?.snapshot() ?? {}
  const out: HostDiagnostics[] = []
  for (const { key, def } of entries) {
    const state = await connectState(key)
    const status = buildHostStatus(key, def, state, warmup[key]?.state, Date.now(), getHostReadiness(key))
    out.push({
      alias: key,
      label: status.label,
      hostname: status.hostname,
      ...(def.user ? { user: def.user } : {}),
      connected: status.connected,
      phase: status.phase,
      daemonVersion: null,
      ...connectFacts(status, state),
      readiness: status.readiness ?? null,
      lastError: status.error ?? null,
    })
  }
  return out
}

/** `hello` on the pooled, connected daemon for `host`; null when there is none. Never dials. */
export async function daemonHello(host: string, timeoutMs: number): Promise<DaemonHello | null> {
  if (CLOUD_MODE) return null
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection(host)
  if (!conn) return null
  const res = await conn.send('hello', {}, timeoutMs)
  if (!res.ok) throw new Error(typeof res.error === 'string' ? res.error : 'hello was refused')
  return {
    version: typeof res.version === 'string' && res.version ? res.version : null,
    runtime: runtimeFromExecutable(res.serviceExecutable),
  }
}

/**
 * The local daemon's own host.preflight, when it is connected and has
 * 'preflight-v1': host work belongs to the daemon, and its PATH is the one
 * sessions really get. null = no such daemon (the caller runs the probe itself).
 */
export async function localDaemonPreflight(minVersion: string | undefined, timeoutMs: number): Promise<HostPreflightResult | null> {
  if (CLOUD_MODE) return null
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection('__local__')
  if (!conn?.hasCapability('preflight-v1')) return null
  const reply = await conn.send('host.preflight', minVersion ? { minClaudeVersion: minVersion } : {}, timeoutMs)
  if (!reply.ok) throw new Error(typeof reply.error === 'string' ? reply.error : 'host.preflight was refused')
  const parsed = parsePreflight(reply)
  if (!parsed) throw new Error('host.preflight answered in an unknown shape')
  return parsed
}
