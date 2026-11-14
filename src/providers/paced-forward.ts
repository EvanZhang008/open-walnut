/**
 * A forward whose upload leaves at a steady pace (2026-11-12): the bulk channel's own SSH
 * connection to a host behind a relay on the SSH path was ended by the relay within 1 to 4
 * seconds of every redial, because whatever waited for it (a task move's file parts, the host's
 * read copy) went out at full speed at once, and it kept failing that way for hours. Measured on
 * that relay, one connection uploading smoothly at 20 KB/s lived 10 minutes (12 MB), while bursts
 * of 100 KB/s or more were ended within seconds. The pace is the host's learned one (`learn`,
 * upload-pace.ts): unpaced until a cut teaches it, which this forward reports when the
 * connection under it ends by itself; a fixed one is for tests.
 *
 * pacedForward puts a local listener in front of a forward's port: every connection to it is
 * piped to the forward, the bytes going up in pieces of at most `pieceBytes`, each one only when
 * the pacer lets it go, and only while the far side keeps up (backpressure); the bytes coming
 * down pass untouched. Whatever rides the connection is paced, whatever its frame sizes.
 */

import net from 'node:net'
import { forwardEndIsCut, type LaneForward } from './stream-lane.js'
import { fixedPace, type PaceSource } from './upload-pace.js'

export type PacedForwardOptions = {
  /** The largest piece written at once (default 8 KB). */
  pieceBytes?: number
} & ({ learn: PaceSource } | { bytesPerSec: number; burstBytes: number })

/** A paced forward also says how many bytes it let go up so far (its owner's upload progress). */
export interface PacedLaneForward extends LaneForward {
  sentBytes(): number
}

export async function pacedForward(inner: LaneForward, opts: PacedForwardOptions): Promise<PacedLaneForward> {
  const source = 'learn' in opts ? opts.learn : fixedPace({ bytesPerSec: opts.bytesPerSec, burstBytes: opts.burstBytes })
  try { await source.ready?.() } catch (err) { inner.stop(); throw err }
  const pacer = source.pacer()
  const pieceBytes = Math.max(1024, opts.pieceBytes ?? 8 * 1024)
  const sockets = new Set<net.Socket>()
  let stopped = false

  const server = net.createServer((client) => {
    const remote = net.connect(inner.port, '127.0.0.1')
    sockets.add(client)
    sockets.add(remote)
    const end = () => {
      client.destroy()
      remote.destroy()
      sockets.delete(client)
      sockets.delete(remote)
    }
    client.on('error', end).on('close', end)
    remote.on('error', end).on('close', end)
    remote.pipe(client)

    // Up: one piece at a time, each after the pacer allows it and the far side drained.
    const queue: Buffer[] = []
    let pumping = false
    let ended = false
    const pump = async (): Promise<void> => {
      if (pumping) return
      pumping = true
      try {
        while (queue.length > 0 && !remote.destroyed) {
          let buf = queue.shift()!
          if (buf.length > pieceBytes) { queue.unshift(buf.subarray(pieceBytes)); buf = buf.subarray(0, pieceBytes) }
          await pacer.take(buf.length)
          if (remote.destroyed) return
          if (!remote.write(buf)) {
            await new Promise<void>((r) => {
              const done = () => { remote.off('drain', done); remote.off('close', done); r() }
              remote.on('drain', done).on('close', done)
            })
          }
          if (queue.length === 0) client.resume()
        }
        if (ended && queue.length === 0 && !remote.destroyed) remote.end()
      } catch { end() } finally { pumping = false }
    }
    client.on('data', (chunk: Buffer) => {
      queue.push(chunk)
      // Hold the reader while bytes wait, so the client feels the pace as backpressure.
      client.pause()
      void pump()
    })
    client.on('end', () => { ended = true; void pump() })
  })

  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })
  } catch (err) {
    // No listener: the forward under it would be left running with nobody to stop it.
    source.ended(pacer, { byWalnut: true })
    inner.stop()
    throw err
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    source.ended(pacer, { byWalnut: true })
    pacer.drop('the forward stopped')
    for (const s of sockets) s.destroy()
    sockets.clear()
    server.close()
    inner.stop()
  }
  inner.onExit((why) => {
    // The connection under it ended: close the listener too (the owner hears it from inner).
    if (stopped) return
    stopped = true
    // Ended by itself while it carried an upload: the host's pace learns (upload-pace.ts).
    source.ended(pacer, { byWalnut: !forwardEndIsCut(why) })
    pacer.drop('the forward ended')
    for (const s of sockets) s.destroy()
    server.close()
  })
  return { port, onExit: (cb) => inner.onExit(cb), stop, sentBytes: () => pacer.sentBytes }
}
