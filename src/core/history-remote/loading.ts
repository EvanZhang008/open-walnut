/**
 * A session of this machine whose history is only in remote storage takes a download before it
 * reads (transcript-offload.ts). That read is shared: the first request waits a moment and then
 * answers "Still loading this conversation from remote storage" (HostStillLoadingError, which the
 * client shows and asks again at once), the read goes on, and the next request for the same
 * session joins it. Every other read runs as before, untouched.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { HostStillLoadingError } from '../hosts/remote-read-bound.js'
import { localProjectsDirs } from './service.js'

export const REMOTE_LOADING_FROM = 'remote storage'
/** The first request answers "still loading" after this; a request joining a running read waits longer. */
const FIRST_WAIT_MS = 1_500
const JOIN_WAIT_MS = 10_000
/** A finished read waits this long for the request it was cut from. */
const KEEP_RESULT_MS = 60_000

const running = new Map<string, { work: Promise<unknown>; settledAt?: number }>()

/**
 * Is session `sid` (started in `cwd`) kept only in remote storage on this machine? One stat of
 * its manifest in the project dir its cwd names: a session filed elsewhere reads as before.
 */
export async function remoteOnlyHere(sid: string, cwd: string | undefined, roots = localProjectsDirs()): Promise<boolean> {
  if (!cwd || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid)) return false
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  for (const root of roots) {
    const dir = path.join(root, enc)
    let m: { remote?: { offloadedAt?: number } }
    try { m = JSON.parse(await fsp.readFile(path.join(dir, `${sid}.walnut-archive.json`), 'utf8')) } catch { continue }
    if (m?.remote?.offloadedAt === undefined) return false
    const there = async (p: string) => fsp.access(p).then(() => true, () => false)
    return !(await there(path.join(dir, `${sid}.jsonl`))) && !(await there(path.join(dir, `${sid}.jsonl.gz`)))
  }
  return false
}

/** Run `read` for `key`; while it is a download from remote storage, answer "still loading" in time. */
export async function withRemoteLoading<T>(key: string, remote: boolean, read: () => Promise<T>): Promise<T> {
  let entry = running.get(key)
  if (entry?.settledAt !== undefined && Date.now() - entry.settledAt > KEEP_RESULT_MS) { running.delete(key); entry = undefined }
  if (!entry && !remote) return read()
  const joined = !!entry
  if (!entry) {
    const e: { work: Promise<unknown>; settledAt?: number } = { work: read() }
    e.work.then(() => { e.settledAt = Date.now() }, () => { running.delete(key) })
    running.set(key, e)
    entry = e
  }
  const work = entry.work as Promise<T>
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), joined ? JOIN_WAIT_MS : FIRST_WAIT_MS) })
  try {
    const got = await Promise.race([work.then((value) => ({ value })), late])
    if (got === 'late') throw new HostStillLoadingError('__local__', REMOTE_LOADING_FROM)
    if (running.get(key) === entry) running.delete(key)
    return got.value
  } finally { clearTimeout(timer) }
}
