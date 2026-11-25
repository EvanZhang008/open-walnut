/**
 * A replica manifest's lists gzipped ('replica-sync-gz-v1'). The whole notes manifest (one row per
 * note with its title and time: about 1.7 MB for 6,700 notes) went up one frame, and at a paced
 * 13.7 KB/s that frame took longer than the host waits for a whole frame: the bulk channel was cut
 * every two minutes, all day, with every answer behind it (2026-11-25). Gzipped it is a few hundred
 * KB. Both sides: the leader packs (DaemonConnection, for a daemon that has the capability) and the
 * daemon unpacks before it reads the manifest; a daemon without it gets the lists as before.
 */
import { promisify } from 'node:util'
import { gunzipSync, gzip } from 'node:zlib'

export const REPLICA_SYNC_GZ_CAPABILITY = 'replica-sync-gz-v1'
/** The list fields a replica.sync carries. */
export const REPLICA_SYNC_LISTS = ['entries', 'changed', 'removed', 'renamed'] as const
/** Lists this big or bigger (their JSON) go gzipped. */
export const REPLICA_SYNC_GZ_BYTES = 16 * 1024
/** The most a gzipped manifest may unpack to. */
export const REPLICA_SYNC_GZ_MAX_BYTES = 64 * 1024 * 1024

const gzipAsync = promisify(gzip)

/** `params` with its lists in `listsGz` when they are big; as it is otherwise. Off the event loop. */
export async function packReplicaSyncLists(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof params.listsGz === 'string') return params
  const lists: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if ((REPLICA_SYNC_LISTS as readonly string[]).includes(k) && v !== undefined) lists[k] = v
    else rest[k] = v
  }
  if (Object.keys(lists).length === 0) return params
  const json = JSON.stringify(lists)
  if (json.length < REPLICA_SYNC_GZ_BYTES) return params
  return { ...rest, listsGz: (await gzipAsync(Buffer.from(json))).toString('base64') }
}

/** The daemon's side: the command with its lists back in place. Throws on a `listsGz` that is not gzipped JSON lists. */
export function unpackReplicaSyncLists(cmd: Record<string, unknown>): Record<string, unknown> {
  if (typeof cmd.listsGz !== 'string') return cmd
  const lists = JSON.parse(gunzipSync(Buffer.from(cmd.listsGz, 'base64'), { maxOutputLength: REPLICA_SYNC_GZ_MAX_BYTES }).toString('utf8')) as unknown
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)) throw new Error('replica.sync: listsGz is not an object of lists')
  const { listsGz: _packed, ...rest } = cmd
  const out: Record<string, unknown> = { ...rest }
  for (const k of REPLICA_SYNC_LISTS) {
    const v = (lists as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}
