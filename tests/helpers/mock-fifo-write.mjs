/**
 * The mock daemons' one FIFO writer (tests/helpers/mock-daemon.ts in process,
 * tests/helpers/mock-daemon-process.mjs standalone), with daemon-core's writeFifo outcomes:
 *
 * - 'ok': the whole line went in.
 * - 'ENXIO': the CLI is gone. Either the open found no reader (ENXIO), or the reader
 *   closed between the open and the write (EPIPE). daemon-core reads both as the same
 *   death: it drains the stream and reaps before it answers.
 * - 'EAGAIN': the pipe stayed full past `waitMs` (a live CLI that is not reading).
 *
 * 2026-11-26 (GitHub CI, slow tier, mock-daemon-death-order.test.ts): the standalone mock
 * took the EPIPE of a CLI that exited right after its answer as a protocol error, so it
 * answered before draining the answer and never reported the death. Plain JS so the
 * standalone process can import it under node or bun.
 */
import fs from 'node:fs'

/**
 * @param {string} pipePath
 * @param {Buffer} buf
 * @param {{ waitMs?: number, afterOpen?: () => void }} [opts]
 *   waitMs: how long a full pipe is waited out (synchronously) before 'EAGAIN'.
 *   afterOpen: runs between the open and the first write (tests close the reader there).
 * @returns {'ok' | 'ENXIO' | 'EAGAIN'}
 */
export function writeFifoLine(pipePath, buf, opts = {}) {
  let fd
  try {
    fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  } catch (err) {
    if (err?.code === 'ENXIO') return 'ENXIO'
    throw err
  }
  try {
    opts.afterOpen?.()
    const deadline = Date.now() + (opts.waitMs ?? 0)
    let off = 0
    while (off < buf.length) {
      try {
        off += fs.writeSync(fd, buf, off)
      } catch (err) {
        if (err?.code === 'EPIPE') return 'ENXIO'
        if (err?.code !== 'EAGAIN') throw err
        if (Date.now() >= deadline) return 'EAGAIN'
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    return 'ok'
  } finally {
    try { fs.closeSync(fd) } catch { /* closed */ }
  }
}
