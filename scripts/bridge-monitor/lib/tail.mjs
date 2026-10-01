/**
 * Incremental file tailer with a persistable cursor per file.
 *
 * A cursor is {ino, offset, head}: a new inode (log recreated), a file shorter
 * than the offset (truncated) or different first bytes (`head`, the file's first
 * HEAD_BYTES as base64) restarts from 0. The inode alone is not enough: Linux
 * hands a removed file's inode number to the next file created, so a log removed
 * and recreated at once looks like the same file grown. Only complete lines are
 * returned, and the offset only advances past the last newline, so a line being
 * written right now is read whole on the next pass.
 */

import fsp from 'node:fs/promises'

const MAX_READ = 16 * 1024 * 1024
const HEAD_BYTES = 64

/** The file's first `n` bytes as base64. */
async function headOf(fh, n) {
  const buf = Buffer.alloc(n)
  const { bytesRead } = await fh.read(buf, 0, n, 0)
  return buf.subarray(0, bytesRead).toString('base64')
}

export class Tailer {
  /** @param {Record<string, {ino:number, offset:number, head?:string}>} cursors  persisted state (mutated) */
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
    let st, fh
    try {
      st = await fsp.stat(file)
      fh = await fsp.open(file, 'r')
    } catch { delete this.cursors[file]; return [] }
    let buf, cur
    try {
      cur = this.cursors[file]
      const replaced = cur?.head !== undefined && cur.ino === st.ino && st.size >= cur.offset
        && await headOf(fh, Buffer.from(cur.head, 'base64').length) !== cur.head
      if (!cur || replaced || cur.ino !== st.ino || st.size < cur.offset) {
        cur = { ino: st.ino, offset: firstSeen === 'start' ? 0 : st.size }
        this.cursors[file] = cur
      }
      if (cur.head === undefined || Buffer.from(cur.head, 'base64').length < Math.min(st.size, HEAD_BYTES)) {
        cur.head = await headOf(fh, Math.min(st.size, HEAD_BYTES))
      }
      if (st.size === cur.offset) return []
      const len = Math.min(st.size - cur.offset, MAX_READ)
      buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, cur.offset)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
    const len = buf.length
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
