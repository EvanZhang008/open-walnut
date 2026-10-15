/**
 * WebSocket frames as a host replica sees them on a spliced socket
 * (src/replica/dispatch.ts). The replica never reads what the Mac sends; it
 * only counts frame headers and payload lengths on the way to the browser, so
 * that a close frame of its own (4001 leader_away, 4002 leader_back) goes out
 * BETWEEN two frames. Written into the middle of a frame, the close frame would
 * be read as that frame's payload and the browser would see a broken stream
 * (1002 or 1006) instead of the code.
 */

import type { Duplex } from 'node:stream'

/** A WebSocket close frame from a server (unmasked): code and a short reason. */
export function closeFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason.slice(0, 120))
  const out = Buffer.alloc(4 + text.length)
  out[0] = 0x88
  out[1] = 2 + text.length
  out.writeUInt16BE(code, 2)
  text.copy(out, 4)
  return out
}

/** The length of a frame header whose first bytes are `head`, or null while it is not known yet. */
function headerLength(head: number[]): number | null {
  if (head.length < 2) return null
  const len7 = head[1]! & 0x7f
  return 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (head[1]! & 0x80 ? 4 : 0)
}

function payloadLength(head: number[]): number {
  const len7 = head[1]! & 0x7f
  if (len7 < 126) return len7
  const b = Buffer.from(head)
  return len7 === 126 ? b.readUInt16BE(2) : Number(b.readBigUInt64BE(2))
}

/** Where a byte stream of frames stands: between two frames, or inside one. */
export class FrameCursor {
  private head: number[] = []
  private payloadLeft = 0

  /** Between two frames (nothing of a frame passed on but not all of it). */
  atBoundary(): boolean {
    return this.head.length === 0 && this.payloadLeft === 0
  }

  /**
   * Count `chunk` as passed on. With `stopAtBoundary`, stop at the end of the
   * current frame (at once when already between frames) and return how many
   * bytes of `chunk` that is; else count all of it.
   */
  take(chunk: Buffer, stopAtBoundary = false): number {
    let i = 0
    while (i < chunk.length) {
      if (this.payloadLeft > 0) {
        const n = Math.min(this.payloadLeft, chunk.length - i)
        this.payloadLeft -= n
        i += n
        if (stopAtBoundary && this.atBoundary()) return i
        continue
      }
      if (stopAtBoundary && this.head.length === 0) return i
      this.head.push(chunk[i++]!)
      const need = headerLength(this.head)
      if (need !== null && this.head.length === need) {
        this.payloadLeft = payloadLength(this.head)
        this.head = []
        if (stopAtBoundary && this.atBoundary()) return i
      }
    }
    return i
  }
}

function ignoreError(): void { /* the peer went away; its close ends the work */ }

/**
 * End a spliced socket with `frame` (a close frame) written between two frames.
 * Called with `upstream` still piped into `client`: both pipes stop here. In
 * the middle of a frame (a flip on a suspect mark, the Mac still sending), the
 * rest of that frame is passed on first; a target that never sends it (frozen
 * mid-frame) has the browser's socket dropped after `waitMs`, which the browser
 * reads as a lost socket (1006), never as a broken frame. The target's side is
 * destroyed once the browser has what it needs.
 */
export function closeAtFrame(client: Duplex, upstream: Duplex, cursor: FrameCursor, frame: Buffer, waitMs: number): void {
  upstream.unpipe(client)
  upstream.removeAllListeners('close')
  upstream.removeAllListeners('error')
  upstream.on('error', ignoreError)
  // Nothing more of the browser's reaches the target (it is told to go); its
  // bytes are read and dropped, so its own close ends the socket.
  client.unpipe(upstream)
  client.resume()
  const close = () => {
    upstream.destroy()
    try { client.write(frame) } catch { /* gone */ }
    client.end()
  }
  if (cursor.atBoundary()) return close()
  const drop = () => {
    clearTimeout(timer)
    upstream.off('data', rest)
    upstream.destroy()
    client.destroy()
  }
  const timer = setTimeout(drop, waitMs)
  timer.unref?.()
  const rest = (c: Buffer) => {
    const n = cursor.take(c, true)
    if (n) client.write(c.subarray(0, n))
    if (!cursor.atBoundary()) return
    clearTimeout(timer)
    upstream.off('data', rest)
    close()
  }
  upstream.once('end', () => { if (!cursor.atBoundary()) drop() })
  upstream.on('data', rest)
  upstream.resume()
}
