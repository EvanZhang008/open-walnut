/**
 * A TCP proxy in front of a companion (or any daemon socket) that can change how
 * the link behaves, on command, without closing it:
 *   pass       forward both ways
 *   blackhole  keep every socket open and forward nothing; new connections are
 *              held silent too (a companion, or a proxy before it, that stopped
 *              forwarding while the tunnel stays up)
 *   drop-hold  close every connection, then hold new ones silent (accepts TCP,
 *              never answers)
 *   slow       forward, but every chunk waits `delayMs` and the link carries at
 *              most `bytesPerSec` each way, delivered in 4KB slices (a slow
 *              link that is still alive).
 *              `shared`: ONE queue per direction for every connection, the way
 *              one physical link (or one ssh stream) carries both of a host's
 *              sockets: a pong then waits behind the bulk socket's bytes.
 *              `queueBytes`: the link pushes back, as TCP does: a sender with
 *              more than this waiting is paused, so its big write stays in
 *              flight for as long as the link needs to carry it.
 *   severed    blackhole, and the far side never hears the near side go away: a
 *              client that gives up and closes leaves its upstream socket open.
 *              That is an SSH port forward whose client vanished (a Mac asleep, or
 *              a network that changed under it): the remote sshd keeps the
 *              forwarded socket to the daemon for many minutes, so the daemon
 *              still counts a trusted client that will never answer.
 * Leaving blackhole or drop-hold for pass closes what was held, the way a
 * recovered network ends the connections that died meanwhile. Leaving severed
 * for pass closes the NEAR ends only and keeps every far end open as an orphan
 * (the daemon's stale client), until `closeOrphans()` or `close()`.
 */
import net from 'node:net'

export type LinkMode = 'pass' | 'blackhole' | 'drop-hold' | 'slow' | 'severed'

export interface SlowLink { delayMs: number; bytesPerSec: number; shared?: boolean; queueBytes?: number }

export interface SilentLinkProxy {
  port: number
  mode: () => LinkMode
  setMode: (mode: LinkMode, slow?: SlowLink) => void
  /** Connections accepted so far (a reconnect is a new one). */
  accepted: () => number
  /** Far-end sockets a severed link left open after their near end went away. */
  orphans: () => number
  /** End every orphaned far end (the remote sshd finally timing them out). */
  closeOrphans: () => void
  close: () => Promise<void>
}

interface Pair { client: net.Socket; upstream: net.Socket | null; severed: boolean }

const silent = (mode: LinkMode) => mode === 'blackhole' || mode === 'drop-hold' || mode === 'severed'

export async function startSilentLinkProxy(targetPort: number, targetHost = '127.0.0.1'): Promise<SilentLinkProxy> {
  let mode: LinkMode = 'pass'
  let slow: SlowLink = { delayMs: 300, bytesPerSec: 64 * 1024 }
  let accepted = 0
  const pairs = new Set<Pair>()
  const orphaned = new Set<net.Socket>()

  /** The shared slow link's queue per direction (`slow.shared`). */
  const SLOW_SLICE_BYTES = 4_096
  const sharedTail: Record<'up' | 'down', Promise<void>> = { up: Promise.resolve(), down: Promise.resolve() }

  /** One direction's writer: in order, with the slow link's delay and rate when it applies. */
  const writer = (to: net.Socket, dir: 'up' | 'down', from: net.Socket, pair: Pair) => {
    let tail = Promise.resolve()
    let waiting = 0
    return (chunk: Buffer) => {
      if (silent(mode) || pair.severed) return
      if (mode !== 'slow') { tail = tail.then(() => { if (!to.destroyed) to.write(chunk) }); return }
      const { delayMs, bytesPerSec, shared, queueBytes } = slow
      if (queueBytes !== undefined) {
        waiting += chunk.length
        if (waiting > queueBytes && !from.isPaused()) from.pause()
      }
      const done = () => {
        if (queueBytes === undefined) return
        waiting -= chunk.length
        if (waiting <= queueBytes && from.isPaused() && !from.destroyed) from.resume()
      }
      // The chunk's delay once, then its bytes at the link's rate in small
      // slices, as a real link delivers them: written whole after len/rate, a
      // 64KB read showed a 64KB/s link as one second of silence per chunk.
      // Each slice is due at a time on the clock (the chunk's start plus its
      // bytes so far at the rate), not one slice's time after the last fired:
      // on a loaded runner every timer fires late, and chained waits added
      // that lateness up, so a 64KB/s link carried a 5MB history at half that.
      const step = () => new Promise<void>((resolve) => {
        let off = 0
        const startAt = Date.now() + delayMs
        const dueAt = (bytes: number) => startAt + Math.ceil((bytes / bytesPerSec) * 1000)
        const next = () => setTimeout(() => {
          if (to.destroyed) { done(); resolve(); return }
          const piece = chunk.subarray(off, off + SLOW_SLICE_BYTES)
          off += piece.length
          to.write(piece)
          if (off >= chunk.length) { done(); resolve(); return }
          next()
        }, Math.max(0, dueAt(Math.min(off + SLOW_SLICE_BYTES, chunk.length)) - Date.now()))
        next()
      })
      // Shared: this connection's order AND the link's order (one queue for all).
      if (shared) { tail = sharedTail[dir] = Promise.all([tail, sharedTail[dir]]).then(step) }
      else tail = tail.then(step)
    }
  }

  /** The near end went away: a severed pair's far end stays open, every other one closes with it. */
  const orphan = (pair: Pair) => {
    const up = pair.upstream
    if (!up || up.destroyed) return
    if (!pair.severed) { up.destroy(); return }
    orphaned.add(up)
    up.once('close', () => orphaned.delete(up))
  }

  const server = net.createServer((client) => {
    accepted++
    client.on('error', () => {})
    const pair: Pair = { client, upstream: null, severed: false }
    pairs.add(pair)
    client.on('close', () => { pairs.delete(pair); orphan(pair) })
    if (silent(mode)) { client.on('data', () => {}); return }
    const up = net.connect(targetPort, targetHost)
    pair.upstream = up
    up.on('error', () => client.destroy())
    up.on('close', () => client.destroy())
    const toUp = writer(up, 'up', client, pair)
    const toClient = writer(client, 'down', up, pair)
    client.on('data', (b: Buffer) => toUp(b))
    up.on('data', (b: Buffer) => toClient(b))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const dropAll = () => { for (const p of pairs) { p.client.destroy(); p.upstream?.destroy() } }
  const closeOrphans = () => { for (const s of orphaned) s.destroy(); orphaned.clear() }
  return {
    port: (server.address() as net.AddressInfo).port,
    mode: () => mode,
    setMode: (next, nextSlow) => {
      if (nextSlow) slow = nextSlow
      if (next === 'severed') {
        // Nothing crosses any more, in either direction, on what is open now.
        for (const p of pairs) p.severed = true
      } else if (mode === 'severed' && next === 'pass') {
        // The network is back: the near ends of the dead connections close (the
        // client notices and dials again); their far ends stay as orphans.
        for (const p of [...pairs]) { p.severed = true; p.client.destroy() }
      } else if (next === 'drop-hold' || (next === 'pass' && (mode === 'blackhole' || mode === 'drop-hold'))) {
        dropAll()
      }
      mode = next
    },
    accepted: () => accepted,
    orphans: () => orphaned.size,
    closeOrphans,
    close: async () => {
      dropAll()
      closeOrphans()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
