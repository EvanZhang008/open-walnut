/**
 * A copy of a leader's data dir as the leader switch's standby holds one, for the tests that boot a
 * second leader of the same Walnut over it (tests/helpers/standby-leader.ts, tests/helpers/live-twin-mac.ts).
 * No imports beyond node and the home manifest, so a live harness can use it without the replica cluster.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { homePathClass } from '../../src/core/home-manifest/index.js'

/**
 * Copy the Mac's data dir to `to` as a standby holds it: the files the home manifest classes as
 * leader data (src/core/home-manifest), a store's -wal with its store (sqlite applies it on open),
 * never a machine's own file (the server's instance lock, a socket) or a rebuildable one.
 */
export function copyLeaderData(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      let st: fs.Stats
      try { st = fs.lstatSync(src) } catch { return false }
      if (st.isDirectory()) return true
      if (!st.isFile()) return false
      // A store's wal-index is its writer's shared memory: a copy of it can name fewer frames than
      // the -wal holds, and a reader trusts it. Left out, the next open rebuilds it from the -wal.
      if (src.endsWith('-shm')) return false
      return homePathClass(path.relative(from, src).split(path.sep).join('/')) === 'leader-data'
    },
  })
}

/** A free loopback port now (for a door URL or a config entry named before its server runs). */
export async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
