/**
 * A host replica's leader relay (src/core/leader/switch/leader-relay.ts): a unix socket of this host's
 * Walnut service, `<daemon dir>/leader-relay/<16 hex>.sock` (0600 in a 0700 dir: only this account
 * connects, as with the host call entry), each connection spliced into ONE stream to the leader over
 * this server's follower link, opened with the relay purpose (`link.openStream('primary', 'leader-relay')`,
 * LEADER_RELAY_PURPOSE in src/lib/leader-relay-names.ts).
 * The leader takes streams of that purpose only into its relay door (the forwarded begin, its source
 * job's lines, the witness door of its machine), never into its tunnel port; this server's public
 * listener never opens one, so a request from a host's tunnel never reaches that door.
 *
 * Served only while the experiment `switchable_leader` is on in this server's copy of the settings
 * (read again with every report, as the host call entry's experiment is); off, the socket is closed
 * and removed. A connection while the link does not follow its daemon, or whose stream the daemon
 * refuses (no leader linked), is closed at once: the caller reads that as no link.
 */
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { spliceStream } from '../lib/link-stream.js'
import { RELAY_SOCKET_MAX_BYTES as SOCKET_MAX_BYTES, leaderRelayWhyPath } from '../lib/leader-relay-names.js'

export interface LeaderRelayDeps {
  /** One stream to the leader over the follower link, with the relay purpose (front.ts link.openStream). */
  openToLeader(): Promise<Duplex>
  /** The follower link follows its daemon. */
  linked(): boolean
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export interface LeaderRelayListener { socketPath: string; close(): Promise<void> }

export async function listenLeaderRelay(deps: LeaderRelayDeps, opts: { socketPath: string; uid: number | null }): Promise<LeaderRelayListener | null> {
  const { socketPath } = opts
  const dir = path.dirname(socketPath)
  // Said once per reason (the caller asks again with every report), and written beside the socket, where a process
  // of this machine that finds no socket reads why (leader-relay.ts relayAbsent).
  const refuse = async (why: string): Promise<null> => {
    const whyFile = leaderRelayWhyPath(socketPath)
    const before = await fs.readFile(whyFile, 'utf8').catch(() => null)
    if (before !== why) {
      deps.log('warn', 'leader relay: not served', { socket: socketPath, why })
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => fs.writeFile(whyFile, why, { mode: 0o600 })).catch(() => { /* nowhere to say it */ })
    }
    return null
  }
  if (!path.isAbsolute(socketPath)) return refuse('the socket path is not absolute')
  if (Buffer.byteLength(socketPath) > SOCKET_MAX_BYTES) return refuse(`the socket path is ${Buffer.byteLength(socketPath)} bytes, more than a unix socket takes (${SOCKET_MAX_BYTES}): the daemon dir is too deep`)
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const st = await fs.lstat(dir)
    if (!st.isDirectory() || (opts.uid !== null && st.uid !== opts.uid)) return refuse('its dir is not this user\'s own dir')
    if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700)
    const old = await fs.lstat(socketPath).catch(() => null)
    if (old && !old.isSocket()) return refuse('something that is not a socket is at its path')
    if (old) await fs.unlink(socketPath)
  } catch (err) {
    return refuse((err as Error).message)
  }
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* the caller went */ })
    if (!deps.linked()) { socket.destroy(); return }
    // Nothing is read from the socket until the stream is there: its bytes wait in the socket's buffer.
    socket.pause()
    deps.openToLeader().then((stream) => {
      if (socket.destroyed) { stream.destroy(); return }
      spliceStream(stream, socket)
      socket.resume()
    }, (err: unknown) => {
      deps.log('info', 'leader relay: no stream to the leader', { error: err instanceof Error ? err.message : String(err) })
      socket.destroy()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    // Owner-only IS the credential, as on the host call entry: never left to the umask.
    await fs.chmod(socketPath, 0o600)
  } catch (err) {
    server.close()
    return refuse((err as Error).message)
  }
  server.on('error', (err) => deps.log('warn', 'leader relay: socket error', { socket: socketPath, error: err.message }))
  await fs.unlink(leaderRelayWhyPath(socketPath)).catch(() => { /* none */ })
  deps.log('info', 'leader relay: listening', { socket: socketPath })
  return {
    socketPath,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      void fs.unlink(socketPath).catch(() => { /* gone */ })
    }),
  }
}
