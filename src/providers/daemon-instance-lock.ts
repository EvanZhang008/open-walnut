import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import nodeNet from 'node:net'
import path from 'node:path'

export const DAEMON_LOCK_MAGIC = 'walnut-daemon-lock/1'
export const DAEMON_LOCK_HOST = '127.0.0.1'
export const DAEMON_LOCK_PORT_BASE = 17000
export const DAEMON_LOCK_PORT_SPAN = 12000
export const DAEMON_LOCK_DEADLINE_MS = 2000
export const DAEMON_LOCK_MAX_BANNER_BYTES = 4096
export const DAEMON_LOCK_MAX_PORT = 65535

export interface DaemonLockBanner {
  magic: string
  uid: number
  dir: string
  pid: number
  instanceId: string
  wsPort: number | null
}

export interface DaemonLockOwnerInfo {
  uid: number
  dir: string
  pid: number
  instanceId: string
  wsPort: number | null
}

export type DaemonLockConflictReason = 'foreign' | 'timeout' | 'malformed' | 'oversize' | 'unreachable' | 'listen'

export class DaemonLockOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonLockOptionsError'
  }
}

export class DaemonLockConflictError extends Error {
  readonly reason: DaemonLockConflictReason
  readonly port: number
  readonly detail: string | undefined

  constructor(reason: DaemonLockConflictReason, port: number, detail?: string) {
    super(
      `daemon instance lock ${DAEMON_LOCK_HOST}:${port} is unavailable (${reason})`
      + (detail ? `: ${detail}` : '')
      + '. Refusing to start a second daemon for this runtime dir.',
    )
    this.name = 'DaemonLockConflictError'
    this.reason = reason
    this.port = port
    this.detail = detail
  }
}

type LockListener = (...args: unknown[]) => void

export interface LockSocketLike {
  on(event: string, listener: LockListener): unknown
  end(data?: string): unknown
  destroy(): unknown
}

export interface LockServerLike {
  on(event: string, listener: LockListener): unknown
  listen(options: { port: number; host: string; exclusive: boolean }): unknown
  close(callback?: (err?: Error | null) => void): unknown
  address(): { port: number } | string | null
}

export interface LockNetLike {
  createServer(handler: (socket: LockSocketLike) => void): LockServerLike
  createConnection(options: { host: string; port: number }): LockSocketLike
}

export interface LockFsLike {
  realpathSync(target: string): string
}

export interface AcquireDaemonInstanceLockOptions {
  runtimeDir: string
  uid: number
  pid: number
  instanceId: string
  port?: number
  deadlineMs?: number
  net?: LockNetLike
  fs?: LockFsLike
}

export interface DaemonInstanceLockOwner {
  kind: 'owner'
  port: number
  publish(wsPort: number | null): void
  release(): Promise<void>
}

export interface DaemonInstanceLockExisting {
  kind: 'existing'
  owner: DaemonLockOwnerInfo
}

export type DaemonInstanceLockResult = DaemonInstanceLockOwner | DaemonInstanceLockExisting

function isUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1
}

function isInstanceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function normalizeWsPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= DAEMON_LOCK_MAX_PORT
    ? value
    : null
}

export function lockDirFor(runtimeDir: string, fsApi: LockFsLike = nodeFs): string {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) {
    throw new DaemonLockOptionsError(`runtimeDir must be an absolute path, got ${JSON.stringify(runtimeDir)}`)
  }
  return fsApi.realpathSync(runtimeDir)
}

export function daemonLockPort(uid: number, dir: string): number {
  const digest = crypto.createHash('sha256').update(`${uid}\0${dir}`).digest()
  return DAEMON_LOCK_PORT_BASE + (digest.readUInt32BE(0) % DAEMON_LOCK_PORT_SPAN)
}

export function buildDaemonLockBanner(info: DaemonLockOwnerInfo): DaemonLockBanner {
  return {
    magic: DAEMON_LOCK_MAGIC,
    uid: info.uid,
    dir: info.dir,
    pid: info.pid,
    instanceId: info.instanceId,
    wsPort: normalizeWsPort(info.wsPort),
  }
}

export function parseDaemonLockBanner(line: string): DaemonLockBanner | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  if (candidate.magic !== DAEMON_LOCK_MAGIC) return null
  if (!isUid(candidate.uid) || !isPid(candidate.pid) || !isInstanceId(candidate.instanceId)) return null
  if (typeof candidate.dir !== 'string' || candidate.dir.length === 0) return null
  return {
    magic: DAEMON_LOCK_MAGIC,
    uid: candidate.uid,
    dir: candidate.dir,
    pid: candidate.pid,
    instanceId: candidate.instanceId,
    wsPort: normalizeWsPort(candidate.wsPort),
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  return Buffer.from(typeof chunk === 'string' ? chunk : String(chunk), 'utf8')
}

function readBannerLine(netApi: LockNetLike, port: number, deadlineMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = netApi.createConnection({ host: DAEMON_LOCK_HOST, port })
    let accumulated = Buffer.alloc(0)
    let settled = false
    const settle = (err: Error | null, line?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch {}
      if (err) reject(err)
      else resolve(line as string)
    }
    const timer = setTimeout(
      () => settle(new DaemonLockConflictError('timeout', port, `no banner within ${deadlineMs}ms`)),
      deadlineMs,
    )
    timer.unref?.()
    const closedEarly = () => settle(
      new DaemonLockConflictError('malformed', port, 'holder closed without a complete banner line'),
    )
    socket.on('data', (chunk: unknown) => {
      accumulated = Buffer.concat([accumulated, toBuffer(chunk)])
      const newline = accumulated.indexOf(0x0a)
      if (newline >= 0 && newline <= DAEMON_LOCK_MAX_BANNER_BYTES) {
        settle(null, accumulated.subarray(0, newline).toString('utf8'))
        return
      }
      if (accumulated.length > DAEMON_LOCK_MAX_BANNER_BYTES) {
        settle(new DaemonLockConflictError('oversize', port, `banner exceeded ${DAEMON_LOCK_MAX_BANNER_BYTES} bytes`))
      }
    })
    socket.on('end', closedEarly)
    socket.on('close', closedEarly)
    socket.on('error', (err: unknown) => {
      settle(new DaemonLockConflictError('unreachable', port, (err as Error)?.message ?? 'connect failed'))
    })
  })
}

async function probeExistingOwner(
  netApi: LockNetLike,
  port: number,
  uid: number,
  dir: string,
  deadlineMs: number,
): Promise<DaemonLockOwnerInfo> {
  const banner = parseDaemonLockBanner(await readBannerLine(netApi, port, deadlineMs))
  if (!banner) throw new DaemonLockConflictError('malformed', port, 'holder is not a walnut daemon lock')
  if (banner.uid !== uid || banner.dir !== dir) {
    throw new DaemonLockConflictError('foreign', port, `holder uid=${banner.uid} dir=${banner.dir}`)
  }
  return { uid: banner.uid, dir: banner.dir, pid: banner.pid, instanceId: banner.instanceId, wsPort: banner.wsPort }
}

/** Probe only this one deterministic port: any fallback candidate would let a third party take the port a dead owner freed, causing two instances. */
export async function acquireDaemonInstanceLock(
  options: AcquireDaemonInstanceLockOptions,
): Promise<DaemonInstanceLockResult> {
  if (!isUid(options.uid)) throw new DaemonLockOptionsError(`uid must be a non-negative safe integer, got ${options.uid}`)
  if (!isPid(options.pid)) throw new DaemonLockOptionsError(`pid must be a safe integer greater than 1, got ${options.pid}`)
  if (!isInstanceId(options.instanceId)) throw new DaemonLockOptionsError('instanceId must be a non-empty string')
  if (options.port !== undefined && !(Number.isSafeInteger(options.port) && options.port >= 0 && options.port <= DAEMON_LOCK_MAX_PORT)) {
    throw new DaemonLockOptionsError(`port must be an integer in 0..${DAEMON_LOCK_MAX_PORT}, got ${options.port}`)
  }

  const netApi = options.net ?? (nodeNet as unknown as LockNetLike)
  const dir = lockDirFor(options.runtimeDir, options.fs ?? nodeFs)
  const requestedPort = options.port ?? daemonLockPort(options.uid, dir)
  const deadlineMs = options.deadlineMs ?? DAEMON_LOCK_DEADLINE_MS

  let wsPort: number | null = null
  const server = netApi.createServer((socket) => {
    const timer = setTimeout(() => { try { socket.destroy() } catch {} }, deadlineMs)
    timer.unref?.()
    const clear = () => clearTimeout(timer)
    socket.on('error', clear)
    socket.on('close', clear)
    const banner = buildDaemonLockBanner({ uid: options.uid, dir, pid: options.pid, instanceId: options.instanceId, wsPort })
    try { socket.end(JSON.stringify(banner) + '\n') } catch { clear() }
  })

  const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    let settled = false
    const settle = (err: NodeJS.ErrnoException | null) => {
      if (settled) return
      settled = true
      resolve(err)
    }
    server.on('error', (err: unknown) => settle(err as NodeJS.ErrnoException))
    server.on('listening', () => settle(null))
    server.listen({ port: requestedPort, host: DAEMON_LOCK_HOST, exclusive: true })
  })

  if (listenError) {
    if (listenError.code === 'EADDRINUSE') {
      return { kind: 'existing', owner: await probeExistingOwner(netApi, requestedPort, options.uid, dir, deadlineMs) }
    }
    throw new DaemonLockConflictError('listen', requestedPort, listenError.message)
  }

  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : requestedPort
  let releasing: Promise<void> | null = null

  return {
    kind: 'owner',
    port,
    publish(next: number | null) {
      wsPort = normalizeWsPort(next)
    },
    release() {
      if (!releasing) {
        releasing = new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
      }
      return releasing
    },
  }
}
