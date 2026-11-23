/**
 * The data dirs this Walnut's own servers run in on its hosts, as this Walnut's host server
 * manager keeps them in its state file (manager.ts: each host's `working`, the program it
 * last configured there, whose spec names `OPEN_WALNUT_HOME: install.dataDir`).
 *
 * The shared-daemon rule asks it (daemon-shared.ts thisWalnutSharedVerdict). A daemon before
 * 2026-11-23 filed a host replica's own data dir as a second Walnut (served-walnuts-core.ts),
 * and the replica refreshes that key on every push, so it stays in the record for as long as
 * the old daemon runs. A leader that reads such a record must still see only itself there, or
 * the fixed daemon waits one more overdue round (about four hours) before it reaches the host.
 *
 * Read with fs.promises, never on the event loop, and kept while the file's mtime and size stay.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'

/** The manager's state file in a Walnut's data dir (index.ts). */
export const HOST_SERVERS_FILE = 'host-servers.json'

/** A data dir named by its Walnut's id (install.ts walnutDirs): only that Walnut uses it, on any host. */
const OWN_LAYOUT = /\/walnuts\/[^/]+\/data\/*$/

function dirsOfRecord(rec: unknown): string[] {
  const working = (rec as { working?: { cwd?: unknown; env?: Record<string, unknown>; fallback?: { env?: Record<string, unknown> } } } | null)?.working
  if (!working || typeof working !== 'object') return []
  const out: string[] = []
  for (const dir of [working.env?.OPEN_WALNUT_HOME, working.fallback?.env?.OPEN_WALNUT_HOME, working.cwd]) {
    if (typeof dir === 'string' && dir.startsWith('/') && !out.includes(dir)) out.push(dir)
  }
  return out
}

/**
 * The data dirs of this Walnut's servers in a parsed state file. `hostKey` names the host the
 * daemon runs on; null when that is not known (this computer's own daemon, which a host row
 * may reach too): then only the dirs named by this Walnut's id count, since the shared dir from
 * before the split (`<root>/data`) is this Walnut's only on the host whose record names it.
 */
export function ownFollowerDirsIn(state: unknown, hostKey: string | null): string[] {
  if (!state || typeof state !== 'object') return []
  const all = state as Record<string, unknown>
  if (hostKey !== null) return Object.prototype.hasOwnProperty.call(all, hostKey) ? dirsOfRecord(all[hostKey]) : []
  const out: string[] = []
  for (const rec of Object.values(all)) {
    for (const dir of dirsOfRecord(rec)) if (OWN_LAYOUT.test(dir) && !out.includes(dir)) out.push(dir)
  }
  return out
}

let cache: { file: string; mtimeMs: number; size: number; state: unknown } | null = null

/** The data dirs of this Walnut's servers on `hostKey` (ownFollowerDirsIn); none when the file is missing or unreadable. */
export async function ownFollowerDirs(hostKey: string | null, file: string = path.join(WALNUT_HOME, HOST_SERVERS_FILE)): Promise<string[]> {
  let st: { mtimeMs: number; size: number }
  try { st = await fs.stat(file) } catch { return [] }
  if (!cache || cache.file !== file || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
    let state: unknown = null
    try { state = JSON.parse(await fs.readFile(file, 'utf8')) } catch { state = null }
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, state }
  }
  return ownFollowerDirsIn(cache.state, hostKey)
}
