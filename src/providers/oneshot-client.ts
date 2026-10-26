/**
 * The server side of one-shot Claude Code runs (oneshot-core.ts says what they
 * are): every `claude -p` Walnut starts outside a session goes through here.
 *
 * The caller builds the spawn exactly as before (command, argv, env, cwd, the
 * stdin text) and gets the child's stdout lines, stderr and exit back. Where it
 * runs: the local daemon when it advertises 'oneshot-v1' (the process is the
 * daemon's child, the warm pool lives there); otherwise the same core in this
 * process, so an older daemon, a CLI process with no daemon link, or a test
 * behaves exactly the same.
 *
 * The daemon streams `oneshot.out` / `oneshot.err` / `oneshot.exit` to the
 * socket that started the run (routed here by DaemonConnection, see
 * setOneShotEventSink). A link that drops or reconnects mid-run ends the run
 * here with an error: the daemon kills a run whose socket closed, so nothing
 * would ever answer it.
 */
import { spawn } from 'node:child_process'
import { createOneShotCore, type OneShotChild } from './oneshot-core.js'
import { isVitestWorker } from '../core/test-claude-guard.js'
import { linkFailureKind } from './link-failure.js'
import { log } from '../logging/index.js'

export interface OneShotSpec {
  command: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  /** Written to stdin once the child runs. */
  input?: string
  /** Close stdin after the input (text-mode `claude -p`). */
  endInput?: boolean
  /** Close stdin when the CLI prints its result line (stream-json, single-use child). */
  endOnResult?: boolean
  /** Take a pre-booted child with this key, and boot its replacement. */
  warmKey?: string
  /** The pool gives this key's child way last (AI search). */
  warmKeep?: boolean
  /** The daemon SIGKILLs the child past this, whatever the caller does. */
  maxMs?: number
}

export interface OneShotExit {
  code: number | null
  signal: string | null
  /** The spawn itself failed, or the daemon link went away. */
  error?: string
}

export interface OneShotListeners {
  onLine?: (line: string) => void
  onStderr?: (text: string) => void
  onExit: (exit: OneShotExit) => void
}

export type OneShotSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'end'

export interface OneShotHandle {
  via: 'daemon' | 'local'
  /** The child came from the warm pool. */
  warm: boolean
  pid?: number
  /** Signal the child; 'end' closes its stdin instead. */
  kill(signal?: OneShotSignal): void
}

/** The part of a DaemonConnection this module uses. */
export interface OneShotConn {
  connected: boolean
  connectionEpoch: number
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }>
}

export const ONESHOT_CAPABILITY = 'oneshot-v1'
const RUN_RPC_MS = 15_000
const LINK_CHECK_MS = 1_000
/** A run frame past this goes in-process: the bun daemon closes a socket on a frame over 16 MB. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

// ── In-process core (fallback) ──

type LocalSink = (ev: string, data: Record<string, unknown>) => void
let localCore: ReturnType<typeof createOneShotCore<LocalSink>> | null = null
function local(): ReturnType<typeof createOneShotCore<LocalSink>> {
  localCore ??= createOneShotCore<LocalSink>({
    spawn: spawn as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => OneShotChild,
    send: (sink, ev, data) => sink(ev, data),
    env: process.env,
    log: (level, msg, data) => log.agent[level](msg, data),
  })
  return localCore
}
process.once('exit', () => { localCore?.disposeAll() })

// ── Daemon routing ──

interface Route { listeners: OneShotListeners; conn: OneShotConn; epoch: number }
const routes = new Map<string, Route>()
let linkTimer: ReturnType<typeof setInterval> | null = null

function deliver(listeners: OneShotListeners, ev: string, data: Record<string, unknown>): boolean {
  try {
    if (ev === 'oneshot.out' && Array.isArray(data.lines)) {
      for (const line of data.lines) if (typeof line === 'string') listeners.onLine?.(line)
    } else if (ev === 'oneshot.err' && typeof data.text === 'string') {
      listeners.onStderr?.(data.text)
    } else if (ev === 'oneshot.exit') {
      listeners.onExit({
        code: typeof data.code === 'number' ? data.code : null,
        signal: typeof data.signal === 'string' ? data.signal : null,
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
      })
      return true
    }
  } catch (err) {
    log.agent.warn('one-shot listener threw', { ev, error: err instanceof Error ? err.message : String(err) })
    if (ev === 'oneshot.exit') return true
  }
  return false
}

/** DaemonConnection hands every `oneshot.*` event here (daemon-connection.ts). */
export function dispatchOneShotEvent(event: Record<string, unknown>): void {
  const runId = typeof event.runId === 'string' ? event.runId : ''
  const route = routes.get(runId)
  if (!route) return
  if (deliver(route.listeners, String(event.ev), event)) endRoute(runId)
}

function endRoute(runId: string): void {
  routes.delete(runId)
  if (routes.size === 0 && linkTimer) { clearInterval(linkTimer); linkTimer = null }
}

function watchLinks(): void {
  if (linkTimer) return
  linkTimer = setInterval(() => {
    for (const [runId, route] of routes) {
      if (route.conn.connected && route.conn.connectionEpoch === route.epoch) continue
      endRoute(runId)
      try { route.listeners.onExit({ code: null, signal: null, error: 'the link to the local daemon dropped during the run' }) } catch { /* listener */ }
    }
  }, LINK_CHECK_MS)
  linkTimer.unref?.()
}

let resolverOverride: (() => OneShotConn | null | Promise<OneShotConn | null>) | null = null

/** Tests: pick the daemon connection (null = in-process). */
export function _setOneShotDaemonForTest(fn: (() => OneShotConn | null | Promise<OneShotConn | null>) | null): void {
  resolverOverride = fn
}

/** Tests: kill the in-process pool and forget it. */
export function _resetLocalOneShotForTest(): void {
  localCore?.disposeAll()
  localCore = null
}

type DaemonModule = typeof import('./daemon-connection.js')
type LocalDaemonModule = typeof import('./local-daemon.js')
let daemonModule: DaemonModule | null = null
let localDaemonModule: LocalDaemonModule | null = null
const DIAL_WAIT_MS = 5_000
const BOOT_WAIT_MS = 15_000

function usable(conn: OneShotConn | null): OneShotConn | null {
  return conn && conn.connected && conn.hasCapability(ONESHOT_CAPABILITY) ? conn : null
}

function pick(mod: DaemonModule): OneShotConn | null {
  return usable(mod.getConnectedDaemonConnection('__local__') as unknown as OneShotConn | null)
}

/**
 * No link yet, but this process runs the local daemon (the server, once it
 * started or adopted it): dial it, bounded. Sessions open the link lazily, so
 * an idle server may have none. A process that never started the daemon (a
 * CLI command) has no wsUrl and runs in-process instead of starting one.
 */
async function dial(mod: DaemonModule): Promise<OneShotConn | null> {
  localDaemonModule ??= await import('./local-daemon.js').catch(() => null)
  const daemon = localDaemonModule?.localDaemon
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The server is still starting it (boot): wait for that, bounded.
    if (daemon && !daemon.wsUrl && daemon.starting) {
      await Promise.race([
        daemon.starting.catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BOOT_WAIT_MS) }),
      ])
      clearTimeout(timer)
    }
    const wsUrl = daemon?.wsUrl
    if (!wsUrl) return null
    const conn = await Promise.race([
      (mod.getDirectDaemonConnection('__local__', wsUrl) as unknown as Promise<OneShotConn>).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DIAL_WAIT_MS) }),
    ])
    return usable(conn)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The local daemon link that can run one-shots, or null for in-process. Sync once the link is up. */
function daemonConn(): OneShotConn | null | Promise<OneShotConn | null> {
  if (resolverOverride) return resolverOverride()
  if (process.env.WALNUT_ONESHOT_IN_PROCESS === '1') return null
  // A unit test never reaches the developer's own daemon.
  if (isVitestWorker()) return null
  if (daemonModule) return pick(daemonModule) ?? dial(daemonModule)
  return import('./daemon-connection.js').then((mod) => { daemonModule = mod; return pick(mod) ?? dial(mod) }, () => null)
}

let lastVia: 'daemon' | 'local' | null = null
function noteVia(via: 'daemon' | 'local', why?: string): void {
  if (via === lastVia) return
  lastVia = via
  log.agent.info('one-shot claude runs ' + (via === 'daemon' ? 'in the local daemon' : 'in the server process'), why ? { why } : {})
}

function payload(spec: OneShotSpec): Record<string, unknown> {
  return {
    command: spec.command,
    args: spec.args,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env: spec.env,
    ...(spec.input ? { input: spec.input } : {}),
    ...(spec.endInput ? { endInput: true } : {}),
    ...(spec.endOnResult ? { endOnResult: true } : {}),
    ...(spec.warmKey ? { warmKey: spec.warmKey } : {}),
    ...(spec.warmKeep ? { warmKeep: true } : {}),
    ...(spec.maxMs ? { maxMs: spec.maxMs } : {}),
  }
}

let runSeq = 0
function newRunId(): string {
  return `os-${process.pid}-${Date.now().toString(36)}-${(++runSeq).toString(36)}`
}

/**
 * Start one `claude -p` child. Listeners get every stdout line in order (a
 * pooled child's boot lines first) and exactly one exit. Rejects only when the
 * daemon refused the run; a spawn that fails later arrives as an exit with
 * `error`.
 */
export async function startOneShot(spec: OneShotSpec, listeners: OneShotListeners): Promise<OneShotHandle> {
  const runId = newRunId()
  const conn = await daemonConn()
  const body = conn ? payload(spec) : null
  const tooBig = !!body && Buffer.byteLength(JSON.stringify(body)) > MAX_FRAME_BYTES
  if (conn && body && !tooBig) {
    routes.set(runId, { listeners, conn, epoch: conn.connectionEpoch })
    watchLinks()
    let reply: Awaited<ReturnType<OneShotConn['send']>> | null = null
    try {
      reply = await conn.send('oneshot.run', { runId, ...body }, RUN_RPC_MS)
    } catch (err) {
      endRoute(runId)
      // The command never left: the link was down. Nothing started, so it runs here.
      if (!neverSent(err)) {
        // The daemon may have started it before the reply was lost.
        void conn.send('oneshot.cancel', { runId, signal: 'SIGKILL' }, 5_000).catch(() => {})
        throw err
      }
      noteVia('local', `the local daemon link is down: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (reply && reply.ok === false) {
      endRoute(runId)
      // Refused before anything started (a daemon handing over, a spawn that threw): run it here.
      noteVia('local', `the local daemon refused the run: ${reply.error ?? 'unknown error'}`)
      reply = null
    }
    if (reply) return daemonHandle(conn, runId, reply)
  } else if (tooBig) {
    log.agent.warn('one-shot run too large for the daemon socket, running it in the server', { bytes: Buffer.byteLength(JSON.stringify(body)) })
  }
  return localRun(runId, spec, listeners)
}

/** True when send() failed before the command reached the socket (link-failure.ts: `no-link`). */
function neverSent(err: unknown): boolean {
  return linkFailureKind(err) === 'no-link'
}

function daemonHandle(conn: OneShotConn, runId: string, reply: Record<string, unknown>): OneShotHandle {
  noteVia('daemon')
  return {
      via: 'daemon',
      warm: reply.warm === true,
      ...(typeof reply.pid === 'number' ? { pid: reply.pid } : {}),
      kill: (signal = 'SIGTERM') => {
        if (!routes.has(runId)) return
        void conn.send('oneshot.cancel', { runId, signal }, 5_000).catch(() => {})
      },
    }
}

function localRun(runId: string, spec: OneShotSpec, listeners: OneShotListeners): OneShotHandle {
  noteVia('local')
  const core = local()
  let done = false
  const sink: LocalSink = (ev, data) => {
    if (done) return
    if (deliver(listeners, ev, data)) done = true
  }
  const started = core.run(sink, { runId, ...payload(spec) })
  return {
    via: 'local',
    warm: started.warm,
    ...(started.pid !== undefined ? { pid: started.pid } : {}),
    kill: (signal = 'SIGTERM') => { if (!done) core.cancel({ runId, signal }) },
  }
}

/** Boot a child for a later run with the same warm key. Fire-and-forget; never throws. */
export function prewarmOneShot(spec: OneShotSpec & { warmKey: string }): void {
  const onError = (err: unknown) => {
    log.agent.warn('one-shot prewarm failed', { error: err instanceof Error ? err.message : String(err) })
  }
  const go = (conn: OneShotConn | null): void => {
    if (!conn) {
      try { local().prewarm(payload(spec)) } catch (err) { onError(err) }
      return
    }
    conn.send('oneshot.prewarm', payload(spec), RUN_RPC_MS)
      .then((reply) => { if (reply.ok === false) throw new Error(reply.error ?? 'refused') })
      .catch(onError)
  }
  try {
    const conn = daemonConn()
    // In-process the child boots now, so a run right after finds it.
    if (conn instanceof Promise) conn.then(go, onError)
    else go(conn)
  } catch (err) { onError(err) }
}
