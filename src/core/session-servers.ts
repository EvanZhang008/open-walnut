/**
 * The servers a session started, and Stop for one: a thin relay to the daemon of the
 * session's host (ports.list / ports.stop, capability 'ports-v1').
 *
 * The scan and the signal are host work (port-scan-core.ts): the daemon reads its own
 * listening sockets and process table and attributes each listener to a session. The
 * server only picks the daemon, names the session's ids, keeps its own pid out of reach
 * when it runs on that host, and turns each server into the address the Web view opens:
 * `localhost:<port>` resolves to the session's host there (session-service-preview.ts),
 * through an SSH forward when that host is remote.
 *
 * Never dials: a host that is not connected answers `offline`, so a panel's poll does not
 * wake a sleeping machine.
 */
import type { SessionRecord } from './types.js'
import { log } from '../logging/index.js'

const LIST_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 20_000
const LOCAL = '__local__'

/** One server, as the daemon reports it plus the URL the Web view opens. Mirrored in web/src/api/session-servers.ts. */
export interface SessionServer {
  port: number
  addresses: string[]
  loopbackOnly: boolean
  pid: number
  pgid: number
  name: string
  command: string
  ageSec: number | null
  via: 'env' | 'terminal' | 'tree'
  kind: 'http' | 'https' | 'other' | 'unknown'
  /** The page's `<title>`, when `/` is a web page that has one. */
  title?: string
  stopScope: 'group' | 'process' | 'none'
  url: string
}

export interface SessionServersResult {
  /** `unsupported`: the host's daemon predates ports-v1. `offline`: its daemon is not connected now. */
  state: 'ok' | 'unsupported' | 'offline' | 'error'
  host: string
  servers: SessionServer[]
  error?: string
}

export class SessionServerStopError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 502 | 503, readonly code: string) {
    super(message)
    this.name = 'SessionServerStopError'
  }
}

interface PortsConnection {
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string; [k: string]: unknown }>
}

export interface SessionServersDeps {
  connection?: (host: string) => Promise<PortsConnection | null>
  serverPid?: number
}

/** The daemon that runs the host's sessions, connected now (owner-stop.ts: the same one a stop goes to). */
async function connectedDaemon(host: string): Promise<PortsConnection | null> {
  const { ownerConnection } = await import('./sessions/owner-stop.js')
  const conn = await ownerConnection(host)
  return conn && conn.connected ? conn as unknown as PortsConnection : null
}

function hostOf(session: SessionRecord): string {
  return session.host && session.host !== 'local' ? session.host : LOCAL
}

/**
 * The ids a session's processes carry, the one its CLI or worker runs under first: an
 * ACP session's worker runs under its runtime id, its terminal under the thread id.
 */
export function sessionProcessIds(session: Pick<SessionRecord, 'claudeSessionId' | 'acpRuntimeId'>): string[] {
  const ids = [session.acpRuntimeId, session.claudeSessionId].filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [...new Set(ids)]
}

/** The address the Web view opens for a server: loopback for one listening there or on every interface. */
export function serverUrl(s: { port: number; addresses: string[]; kind: string }): string {
  const scheme = s.kind === 'https' ? 'https' : 'http'
  const reachableAtLoopback = s.addresses.some((a) => a === '*' || a === '0.0.0.0' || a === '::' || a === '::1' || a.startsWith('127.'))
  if (reachableAtLoopback || s.addresses.length === 0) return `${scheme}://localhost:${s.port}/`
  const a = s.addresses[0]!
  return `${scheme}://${a.includes(':') ? `[${a}]` : a}:${s.port}/`
}

function toServer(raw: Record<string, unknown>): SessionServer | null {
  const port = Number(raw.port)
  const pid = Number(raw.pid)
  if (!Number.isInteger(port) || !Number.isInteger(pid)) return null
  const addresses = Array.isArray(raw.addresses) ? raw.addresses.filter((a): a is string => typeof a === 'string') : []
  const kind = (['http', 'https', 'other', 'unknown'] as const).find((k) => k === raw.kind) ?? 'unknown'
  return {
    port,
    addresses,
    loopbackOnly: raw.loopbackOnly === true,
    pid,
    pgid: Number(raw.pgid) || 0,
    name: typeof raw.name === 'string' ? raw.name : '',
    command: typeof raw.command === 'string' ? raw.command.slice(0, 4001) : '',
    ageSec: typeof raw.ageSec === 'number' ? raw.ageSec : null,
    via: (['env', 'terminal', 'tree'] as const).find((v) => v === raw.via) ?? 'env',
    kind,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 80) } : {}),
    stopScope: (['group', 'process', 'none'] as const).find((v) => v === raw.stopScope) ?? 'none',
    url: serverUrl({ port, addresses, kind }),
  }
}

/**
 * Pids the daemon must never list or signal: this server, when it runs on that host.
 * (Its launch environment can still name the session that started it, whatever it
 * deleted from process.env since. A Walnut an agent started on a REMOTE host is that
 * session's server like any other, and listed as one.)
 */
function guardPids(host: string, deps: SessionServersDeps): number[] {
  return host === LOCAL ? [deps.serverPid ?? process.pid] : []
}

export async function listSessionServers(session: SessionRecord, deps: SessionServersDeps = {}): Promise<SessionServersResult> {
  const host = hostOf(session)
  const ids = sessionProcessIds(session)
  const conn = await (deps.connection ?? connectedDaemon)(host).catch(() => null)
  if (!conn) return { state: 'offline', host, servers: [] }
  if (!conn.hasCapability('ports-v1')) return { state: 'unsupported', host, servers: [] }
  try {
    const res = await conn.send('ports.list', { sids: ids, guardPids: guardPids(host, deps) }, LIST_TIMEOUT_MS)
    if (!res.ok) return { state: 'error', host, servers: [], error: res.error ?? 'the host did not answer' }
    // No way to read the host's sockets (no ss, lsof or /proc): not "nothing listens".
    if (res.source === 'none') return { state: 'error', host, servers: [], error: 'this host cannot list its listening ports (no ss, lsof or /proc)' }
    const all = Array.isArray(res.servers) ? res.servers as Array<Record<string, unknown>> : []
    const servers = all
      .filter((s) => typeof s.sid === 'string' && ids.includes(s.sid))
      .map(toServer)
      .filter((s): s is SessionServer => s !== null)
    return { state: 'ok', host, servers }
  } catch (err) {
    return { state: 'error', host, servers: [], error: (err as Error).message }
  }
}

export async function stopSessionServer(
  session: SessionRecord,
  req: { pid: unknown; port: unknown },
  deps: SessionServersDeps = {},
): Promise<{ stopped: true; scope: 'group' | 'process'; signal: string; confirmed: boolean }> {
  const pid = Number(req.pid)
  const port = Number(req.port)
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SessionServerStopError('pid and port are required', 400, 'bad_request')
  }
  const host = hostOf(session)
  const conn = await (deps.connection ?? connectedDaemon)(host).catch(() => null)
  if (!conn) throw new SessionServerStopError('the session\'s host is not connected', 503, 'offline')
  if (!conn.hasCapability('ports-v1')) throw new SessionServerStopError('the session\'s host runs an older daemon', 503, 'unsupported')
  let res
  try {
    res = await conn.send('ports.stop', {
      sids: sessionProcessIds(session), pid, port, guardPids: guardPids(host, deps),
    }, STOP_TIMEOUT_MS)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'inherited_session') throw new SessionServerStopError((err as Error).message, 403, 'inherited_session')
    throw new SessionServerStopError((err as Error).message, 502, 'unreachable')
  }
  if (!res.ok) throw new SessionServerStopError(res.error ?? 'the host did not answer', 502, 'failed')
  log.session.info('session server stop', {
    sessionId: session.claudeSessionId, host, pid, port, stopped: res.stopped, scope: res.scope, signal: res.signal, code: res.code,
  })
  if (res.stopped === true) {
    return { stopped: true, scope: res.scope === 'group' ? 'group' : 'process', signal: String(res.signal ?? 'SIGTERM'), confirmed: res.confirmed !== false }
  }
  const reason = typeof res.reason === 'string' ? res.reason : 'it could not be stopped'
  if (res.code === 'not_found') throw new SessionServerStopError(reason, 404, 'not_found')
  if (res.code === 'not_stoppable') throw new SessionServerStopError(reason, 409, 'not_stoppable')
  throw new SessionServerStopError(reason, 502, 'signal_failed')
}
