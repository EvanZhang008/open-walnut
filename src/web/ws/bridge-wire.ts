/**
 * The replica's side of the daemon bridge wire: chunk reassembly and the
 * per-socket counters behind the `bridge host closed` log line.
 *
 * Chunks: a daemon with the paced uplink (src/providers/bridge-uplink-core.ts)
 * splits a frame larger than the size this side asked for (`bridge.peer`) into
 * `{ev:'chunk', cid, i, n, part}` envelopes, in order, on one socket. The
 * joined parts are the original frame, byte for byte. Bounded: an assembly
 * that grows past MAX_ASSEMBLY_BYTES, or the oldest of too many open ones, is
 * dropped (the frame is lost; its RPC times out and is retried, a projection
 * push is repeated by the next sweep). All open assemblies on one socket
 * together stay under MAX_SOCKET_ASSEMBLY_BYTES, oldest dropped first: the two
 * per-assembly caps alone still let one socket hold 16 x 64 MB.
 *
 * Counters: sizes and counts only, never content.
 */

import { log } from '../../logging/index.js'

/**
 * What this replica asks the daemon to cut frames to (bridge.peer): the
 * daemon's marker spacing, so a slow busy link hears an answer every 64 KB
 * (bridge-uplink-core.ts). A current daemon caps any larger ask at that size;
 * an older one cuts to what is asked, so asking for less helps it too.
 */
export const REPLICA_CHUNK_BYTES = 64 * 1024
const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024
const MAX_OPEN_ASSEMBLIES = 16
/** One frame at the per-assembly cap plus room for the small ones around it. */
const MAX_SOCKET_ASSEMBLY_BYTES = 96 * 1024 * 1024

interface Assembly { n: number; parts: string[]; have: number; bytes: number }

export interface ChunkAssembler {
  /** Feed one chunk envelope; returns the whole frame once its last part lands. */
  accept(msg: Record<string, unknown>): string | null
  clear(): void
}

export function createChunkAssembler(): ChunkAssembler {
  const open = new Map<string, Assembly>()
  /** Bytes held by every open assembly on this socket. */
  let total = 0
  const drop = (cid: string): Assembly | undefined => {
    const a = open.get(cid)
    if (a) { total -= a.bytes; open.delete(cid) }
    return a
  }
  return {
    accept(msg) {
      const { cid, i, n, part } = msg as { cid?: unknown; i?: unknown; n?: unknown; part?: unknown }
      if (typeof cid !== 'string' || typeof i !== 'number' || typeof n !== 'number' || typeof part !== 'string') return null
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 100_000 || i < 0 || i >= n) return null
      let a = open.get(cid)
      if (!a) {
        if (open.size >= MAX_OPEN_ASSEMBLIES) {
          const oldest = open.keys().next().value as string
          drop(oldest)
          log.ws.warn('bridge: dropped an unfinished chunked frame (too many open)', { cid: oldest })
        }
        a = { n, parts: new Array<string>(n), have: 0, bytes: 0 }
        open.set(cid, a)
      }
      if (a.n !== n || a.parts[i] !== undefined) return null
      a.parts[i] = part
      a.have++
      a.bytes += part.length
      total += part.length
      if (a.bytes > MAX_ASSEMBLY_BYTES) {
        drop(cid)
        log.ws.warn('bridge: dropped a chunked frame over the size cap', { cid, bytes: a.bytes })
        return null
      }
      // Over the socket's cap: drop the oldest OTHER assemblies. This one is
      // bounded by its own cap above, and it is the one still making progress.
      while (total > MAX_SOCKET_ASSEMBLY_BYTES) {
        let victim: string | undefined
        for (const k of open.keys()) if (k !== cid) { victim = k; break }
        if (victim === undefined) break
        const gone = drop(victim)
        log.ws.warn('bridge: dropped an unfinished chunked frame (socket over its byte cap)', {
          cid: victim, bytes: gone?.bytes ?? 0, socketBytes: total,
        })
      }
      if (a.have < a.n) return null
      drop(cid)
      return a.parts.join('')
    },
    clear() { open.clear(); total = 0 },
  }
}

export type BridgeCloseInitiator = 'silence' | 'replaced' | 'hello-timeout' | 'remote' | 'none'

export interface BridgeWireStats {
  clientIp: string | null
  openedAt: number
  bytesRead: number
  bytesWritten: number
  framesIn: number
  framesOut: number
  maxInFrameBytes: number
  wsError: string | null
  /** Set by whichever code on THIS side closes the socket; unset = the peer did. */
  initiator: BridgeCloseInitiator | null
  /** The daemon's id for this connection (from its hello), for cross-side joins. */
  connId: string | null
  /** The alias its hello claimed; kept here so a replaced socket's close still names it. */
  hostAlias: string | null
}

export function newBridgeWireStats(clientIp: string | null): BridgeWireStats {
  return {
    clientIp, openedAt: Date.now(), bytesRead: 0, bytesWritten: 0, framesIn: 0, framesOut: 0,
    maxInFrameBytes: 0, wsError: null, initiator: null, connId: null, hostAlias: null,
  }
}

export function noteFrameIn(stats: BridgeWireStats, bytes: number): void {
  stats.framesIn++
  stats.bytesRead += bytes
  if (bytes > stats.maxInFrameBytes) stats.maxInFrameBytes = bytes
}

export function noteFrameOut(stats: BridgeWireStats, bytes: number): void {
  stats.framesOut++
  stats.bytesWritten += bytes
}

/** The first hop of X-Forwarded-For (the reverse proxy's view of the dialer), else the socket peer. */
export function bridgeClientIp(forwardedFor: string | string[] | undefined, remoteAddress: string | undefined): string | null {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  const first = raw?.split(',')[0]?.trim()
  return first || remoteAddress || null
}

/** One line per host socket close, whichever side closed it. */
export function logBridgeHostClosed(stats: BridgeWireStats, info: {
  hostAlias: string | null
  code: number
  reason: string
  pendingRpcs: number
  loopP99Ms: number | null
}): void {
  log.ws.info('bridge host closed', {
    hostAlias: info.hostAlias ?? stats.hostAlias,
    connId: stats.connId,
    code: info.code,
    reason: info.reason.slice(0, 120),
    wsError: stats.wsError,
    initiator: stats.initiator ?? 'remote',
    uptimeMs: Date.now() - stats.openedAt,
    bytesRead: stats.bytesRead,
    bytesWritten: stats.bytesWritten,
    framesIn: stats.framesIn,
    framesOut: stats.framesOut,
    maxInFrameBytes: stats.maxInFrameBytes,
    pendingRpcs: info.pendingRpcs,
    clientIp: stats.clientIp,
    loopP99Ms: info.loopP99Ms,
  })
}
