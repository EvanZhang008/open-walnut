/**
 * Host readiness: what a CONNECTED host can actually run, from the daemon's
 * `host.preflight` RPC (capability 'preflight-v1', computed host-side in
 * src/providers/host-runtime-core.ts). The connect chain (ssh → … → handshake)
 * proves the daemon runs; it says nothing about whether `claude` is installed,
 * or whether an npm-built claude has a node it can start with. This answers
 * that, once per successful handshake and on every deliberate human connect.
 *
 * Never blocks a connect: it runs after the host is connected and pushes the
 * result as a fresh `host:status` when it lands. An old daemon without the
 * capability gets no readiness field and no UI line, never an error.
 */

import { log } from '../../logging/index.js'
import { HOST_RUNTIME_MESSAGES, type HostPreflightResult } from '../../providers/host-runtime-core.js'

export type ReadinessProblemKind = 'claude_missing' | 'claude_needs_node' | 'claude_error' | 'compiler_missing'

export interface ReadinessProblem {
  kind: ReadinessProblemKind
  /** One sentence a user can act on. */
  message: string
  /** Commands to copy, in the order they are worth trying. */
  commands: string[]
}

export interface HostReadiness extends HostPreflightResult {
  /** When the host was last ASKED (success or failure): the UI's "is this answer new" key. */
  checkedAt: number
  /** Empty when nothing needs doing: the UI then shows nothing at all. */
  problems: ReadinessProblem[]
  /**
   * The last re-check failed (RPC error or timeout). The other fields are the
   * previous good answer, kept so the problem lines do not vanish on a blip.
   */
  checkError?: string
}

/** The subset of a daemon connection this module talks to. */
export interface PreflightConnection {
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>
}

/**
 * The daemon caps itself at 12s; 2s more covers the tunnel. Kept under the
 * UI's 15s "Check again" wait, so a hung probe still answers as checkError.
 */
const PREFLIGHT_TIMEOUT_MS = 14_000
/**
 * A reconnect re-probes a HEALTHY host at most this often (a flapping tunnel
 * reconnects dozens of times a day). A host with a problem re-probes on every
 * reconnect, and a human connect always does, so a fix shows up at once.
 */
const HEALTHY_RECHECK_MS = 10 * 60_000

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** The wire answer, defensively: a field an old or odd daemon omits stays absent. */
export function parsePreflight(raw: unknown): HostPreflightResult | null {
  const r = obj(raw)
  if (!r.claude || typeof r.claude !== 'object') return null
  const c = obj(r.claude)
  const kind = c.kind === 'native' || c.kind === 'npm' || c.kind === 'unknown' ? c.kind : undefined
  const claude: HostPreflightResult['claude'] = { found: c.found === true }
  if (str(c.path)) claude.path = str(c.path)
  if (str(c.version)) claude.version = str(c.version)
  if (kind) claude.kind = kind
  if (typeof c.needsNode === 'boolean') claude.needsNode = c.needsNode
  if (typeof c.nodeFound === 'boolean') claude.nodeFound = c.nodeFound
  if (str(c.nodeVersion)) claude.nodeVersion = str(c.nodeVersion)
  if (str(c.error)) claude.error = str(c.error)!.slice(0, 300)
  const cc = obj(r.compiler)
  const dt = obj(r.dtach)
  return {
    claude,
    compiler: cc.found === true ? { found: true, ...(str(cc.name) ? { name: str(cc.name) } : {}) } : { found: false },
    dtach: dt.found === true ? { found: true, ...(str(dt.path) ? { path: str(dt.path) } : {}) } : { found: false },
  }
}

/** One line per thing the user must fix. Nothing when the host is fine. */
export function readinessProblems(p: HostPreflightResult): ReadinessProblem[] {
  const install = HOST_RUNTIME_MESSAGES.install
  const out: ReadinessProblem[] = []
  if (!p.claude.found) {
    out.push({ kind: 'claude_missing', message: 'Claude Code is not installed on this host.', commands: [install] })
  } else if (p.claude.needsNode && p.claude.nodeFound === false) {
    out.push({
      kind: 'claude_needs_node',
      message: 'Claude Code here is the npm build and no working Node.js was found. Install the native build, which needs no Node.',
      commands: [install],
    })
  } else if (p.claude.error) {
    out.push({ kind: 'claude_error', message: `Claude Code did not start: ${p.claude.error}`, commands: [install] })
  }
  // A compiler only matters while dtach is missing: Walnut builds dtach from
  // source, and dtach is what keeps a terminal alive across disconnects.
  if (!p.compiler.found && !p.dtach.found) {
    out.push({
      kind: 'compiler_missing',
      message: 'No C compiler, so terminals on this host will not survive a disconnect.',
      commands: ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'],
    })
  }
  return out
}

// ── Per-host store ──

const store = new Map<string, HostReadiness>()
const inFlight = new Map<string, Promise<HostReadiness | null>>()
const listeners = new Set<(host: string) => void>()

export function getHostReadiness(host: string): HostReadiness | undefined {
  return store.get(host)
}

/** Fires when a host's readiness changed (set or cleared). Returns an unsubscribe. */
export function onHostReadinessChange(cb: (host: string) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function notify(host: string): void {
  for (const cb of listeners) {
    try { cb(host) } catch { /* an observer must never break the probe */ }
  }
}

/** Test seam + disconnect-free reset. */
export function clearHostReadiness(host?: string): void {
  if (host === undefined) { store.clear(); inFlight.clear(); return }
  store.delete(host)
  inFlight.delete(host)
}

/**
 * A re-check that failed still answers the human who asked: keep the previous
 * good answer, stamp the attempt and its error, and push. With no previous
 * answer there is nothing on screen to update, so nothing is stored.
 */
function markCheckFailed(host: string, message: string, at: number): void {
  const prev = store.get(host)
  if (!prev) return
  store.set(host, { ...prev, checkedAt: at, checkError: message.slice(0, 300) })
  notify(host)
}

async function defaultConnection(host: string): Promise<PreflightConnection | null> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  return getConnectedDaemonConnection(host)
}

/**
 * Ask a connected host what it can run, store the answer, notify. One probe per
 * host at a time (a second caller shares the first). Resolves null, and leaves
 * the previous answer alone, when the host is not connected or the RPC fails;
 * an old daemon without 'preflight-v1' clears any answer instead.
 */
export function refreshHostReadiness(
  host: string,
  opts: {
    getConnection?: (host: string) => Promise<PreflightConnection | null> | PreflightConnection | null
    now?: () => number
    /** Skip the healthy-host throttle (a human asked). */
    force?: boolean
  } = {},
): Promise<HostReadiness | null> {
  if (!host || host === '__local__') return Promise.resolve(null)
  const now = opts.now ?? Date.now
  const known = store.get(host)
  if (!opts.force && known && known.problems.length === 0 && now() - known.checkedAt < HEALTHY_RECHECK_MS) {
    return Promise.resolve(known)
  }
  const running = inFlight.get(host)
  if (running) return running
  const job = (async (): Promise<HostReadiness | null> => {
    try {
      const conn = await (opts.getConnection ?? defaultConnection)(host)
      if (!conn) return null
      if (!conn.hasCapability('preflight-v1')) {
        if (store.delete(host)) notify(host)
        return null
      }
      const reply = await conn.send('host.preflight', {}, PREFLIGHT_TIMEOUT_MS)
      const parsed = reply.ok ? parsePreflight(reply) : null
      if (!parsed) {
        log.session.warn('host preflight returned no usable answer', { host, error: reply.error })
        markCheckFailed(host, reply.error || 'the host gave no usable answer', now())
        return null
      }
      const readiness: HostReadiness = { ...parsed, checkedAt: now(), problems: readinessProblems(parsed) }
      store.set(host, readiness)
      log.session.info('host preflight', {
        host, problems: readiness.problems.map((p) => p.kind),
        claude: readiness.claude.found ? readiness.claude.kind : 'missing', compiler: readiness.compiler.found,
      })
      notify(host)
      return readiness
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('host preflight failed', { host, error: message })
      markCheckFailed(host, message, now())
      return null
    }
  })().finally(() => { if (inFlight.get(host) === job) inFlight.delete(host) })
  inFlight.set(host, job)
  return job
}

/**
 * Server wiring: probe every configured host right after its handshake, and
 * re-push its status when the answer lands. Returns one unsubscribe for both.
 */
export function wireHostReadiness(opts: {
  onConnected: (cb: (host: string) => void) => () => void
  isKnownHost: (host: string) => boolean
  emit: (host: string) => void
  /** Test seam; defaults to refreshHostReadiness against the live pool. */
  refresh?: (host: string) => Promise<unknown>
}): () => void {
  const refresh = opts.refresh ?? ((host: string) => refreshHostReadiness(host))
  const offConnected = opts.onConnected((host) => {
    if (host === '__local__' || !opts.isKnownHost(host)) return
    void refresh(host)
  })
  const offChange = onHostReadinessChange((host) => opts.emit(host))
  return () => { offConnected(); offChange() }
}
