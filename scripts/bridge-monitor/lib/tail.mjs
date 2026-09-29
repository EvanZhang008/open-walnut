/**
 * Incremental file tailer with a persistable cursor per file.
 *
 * A cursor is {ino, offset}: a new inode (log recreated) or a file shorter
 * than the offset (truncated) restarts from 0. Only complete lines are
 * returned, and the offset only advances past the last newline, so a line
 * being written right now is read whole on the next pass.
 */

import fsp from 'node:fs/promises'

const MAX_READ = 16 * 1024 * 1024

export class Tailer {
  /** @param {Record<string, {ino:number, offset:number}>} cursors  persisted state (mutated) */
  constructor(cursors = {}) {
    this.cursors = cursors
  }

  /**
   * New complete lines of `file` since the last call.
   * @param {object} opts
   * @param {'start'|'end'} opts.firstSeen  where to begin a file with no cursor
   * @param {(line:string) => boolean} [opts.filter]  cheap substring pre-filter
   */
  async read(file, { firstSeen = 'end', filter = null } = {}) {
    let st
    try { st = await fsp.stat(file) } catch { delete this.cursors[file]; return [] }
    let cur = this.cursors[file]
    if (!cur || cur.ino !== st.ino || st.size < cur.offset) {
      cur = { ino: st.ino, offset: firstSeen === 'start' ? 0 : st.size }
      this.cursors[file] = cur
    }
    if (st.size === cur.offset) return []
    const len = Math.min(st.size - cur.offset, MAX_READ)
    const fh = await fsp.open(file, 'r')
    let buf
    try {
      buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, cur.offset)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < 0) {
      // A single line bigger than MAX_READ: skip it rather than stall forever.
      if (len === MAX_READ) cur.offset += len
      return []
    }
    cur.offset += lastNl + 1
    const lines = buf.subarray(0, lastNl).toString('utf-8').split('\n')
    return filter ? lines.filter(filter) : lines
  }

  /** Drop cursors for files that no longer exist. */
  async prune() {
    for (const file of Object.keys(this.cursors)) {
      try { await fsp.stat(file) } catch { delete this.cursors[file] }
    }
  }
}
