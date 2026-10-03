/**
 * The server's line to a host's workspace commands ('workspace-v1').
 *
 * Every call has a deadline. A host Walnut is not connected to answers 503, a
 * daemon without the capability 409, so a route degrades instead of hanging.
 * The plugin allowlist is pushed lazily, right before the first command that
 * needs it on each connection, and only when its hash changed (the daemon skips
 * an equal hash too). A daemon that restarted answers `providers_stale`; the
 * client then pushes again and retries once.
 */

import { workspaceProviderCatalog, GIT_WORKTREE_ID } from './registry.js'
import { log } from '../../logging/index.js'

export const WORKSPACE_CAPABILITY = 'workspace-v1'
const DIAL_MS = 20_000
const CONFIGURE_MS = 30_000

export class WorkspaceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly data?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export interface WorkspaceConn {
  hasCapability(cap: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export function hostLabel(host: string | undefined): string {
  return host && host !== '__local__' ? host : 'this Mac'
}

async function realConnection(host: string): Promise<WorkspaceConn> {
  const dc = await import('../../providers/daemon-connection.js')
  let conn: WorkspaceConn | null = dc.getConnectedDaemonConnection(host)
  if (!conn) {
    let target: { hostname: string; user?: string; port?: number } = { hostname: '__local__' }
    if (host !== '__local__') {
      const { getConfig } = await import('../config-manager.js')
      const def = (await getConfig()).hosts?.[host]
      const hostname = def?.hostname ?? ((def as Record<string, unknown> | undefined)?.ssh as string | undefined)
      if (!def || def.enabled === false || !hostname) throw new WorkspaceError(`Unknown host: ${host}`, 400, 'unknown-host')
      target = { hostname, user: def.user, port: def.port }
    }
    let timer: NodeJS.Timeout | undefined
    try {
      conn = await Promise.race([
        dc.getDaemonConnection(host, target),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), DIAL_MS) }),
      ])
    } catch (err) {
      throw new WorkspaceError(`Walnut is not connected to ${hostLabel(host)} right now (${err instanceof Error ? err.message : String(err)}).`, 503, 'host-offline')
    } finally {
      clearTimeout(timer)
    }
  }
  return conn
}

let connectionFor: (host: string) => Promise<WorkspaceConn> = realConnection

/** Test-only: swap the daemon pool lookup (null restores it). The capability check still applies. */
export function __setWorkspaceConnectionForTesting(fn: ((host: string) => Promise<WorkspaceConn>) | null): void {
  connectionFor = fn ?? realConnection
}

async function connect(host: string): Promise<WorkspaceConn> {
  const conn = await connectionFor(host)
  if (!conn.hasCapability(WORKSPACE_CAPABILITY)) {
    throw new WorkspaceError(`The Walnut daemon on ${hostLabel(host)} needs an update before it can make workspaces.`, 409, 'daemon-upgrade')
  }
  return conn
}

/** The allowlist hash each live connection last accepted. */
const pushed = new WeakMap<object, string>()

async function push(conn: WorkspaceConn, host: string): Promise<string> {
  const { config } = await workspaceProviderCatalog()
  if (pushed.get(conn) === config.hash) return config.hash
  const res = await conn.send('workspace.configure', { config }, CONFIGURE_MS)
  if (!res.ok) {
    throw new WorkspaceError(`${hostLabel(host)} refused the workspace providers: ${String(res.error ?? 'unknown error')}`, 502, 'configure-failed')
  }
  pushed.set(conn, config.hash)
  log.web.info('workspace providers pushed', { host, hash: config.hash, providers: config.providers.map((p) => p.id) })
  return config.hash
}

/**
 * One workspace command on a host. Resolves with the daemon's reply (ok or not);
 * throws WorkspaceError when the host cannot be reached or the call times out.
 */
export async function workspaceRpc(host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const conn = await connect(host)
  const provider = typeof params.provider === 'string' ? params.provider : undefined
  // detect needs the allowlist whenever plugins exist; other commands only for a plugin provider.
  const needsPlugins = cmd === 'workspace.detect'
    ? (await workspaceProviderCatalog()).config.providers.length > 0
    : cmd !== 'workspace.job' && provider !== undefined && provider !== GIT_WORKTREE_ID
  const call = async (): Promise<Record<string, unknown>> => {
    const hash = needsPlugins ? await push(conn, host) : undefined
    try {
      return await conn.send(cmd, { ...params, ...(hash ? { providersHash: hash } : {}) }, timeoutMs)
    } catch (err) {
      throw new WorkspaceError(`${hostLabel(host)} did not answer ${cmd} (${err instanceof Error ? err.message : String(err)}).`, 504, 'host-timeout')
    }
  }
  let res = await call()
  if (!res.ok && res.code === 'providers_stale' && needsPlugins) {
    pushed.delete(conn)
    res = await call()
  }
  return res
}

/** The daemon prefixes nothing on these, but a thrown core error starts with the command name. */
export function replyError(res: Record<string, unknown>, fallback: string): string {
  const raw = typeof res.error === 'string' && res.error ? res.error : fallback
  return raw.replace(/^workspace\.[a-z]+ (failed|refused): /, '')
}
