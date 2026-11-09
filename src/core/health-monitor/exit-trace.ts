/**
 * Cut-off shutdowns from the server's exit trace. The file names each with its
 * pid; only pids this monitor saw boot are this server's (the file also holds
 * test servers'), and a line already recorded is not counted twice.
 */

import fsp from 'node:fs/promises'
import type { ServerEvent } from './store.js'

const TAIL_BYTES = 256 * 1024

export async function shutdownBailsSince(file: string, events: readonly ServerEvent[]): Promise<ServerEvent[]> {
  let text: string
  try {
    const h = await fsp.open(file, 'r')
    try {
      const { size } = await h.stat()
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      await h.read(buf, 0, len, size - len)
      text = buf.toString('utf-8')
    } finally { await h.close() }
  } catch { return [] }
  const pids = new Set(events.filter((e) => e.kind === 'boot').map((e) => e.pid))
  const seen = new Set(events.filter((e) => e.kind === 'shutdown-bail').map((e) => `${e.pid}:${e.at}`))
  const out: ServerEvent[] = []
  for (const m of text.matchAll(/^\[([^\]]+)\] SERVER EXIT: shutdown bail after \d+ms pid=(\d+)/gm)) {
    const at = Date.parse(m[1])
    const pid = Number(m[2])
    if (!Number.isFinite(at) || !pids.has(pid) || seen.has(`${pid}:${at}`)) continue
    out.push({ kind: 'shutdown-bail', at, pid })
  }
  return out
}
