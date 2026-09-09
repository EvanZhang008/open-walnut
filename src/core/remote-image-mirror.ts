/**
 * Remote-image mirror bookkeeping: sidecar files + freshness revalidation.
 *
 * Images referenced by remote sessions are mirrored under REMOTE_IMAGES_DIR so
 * the web UI can serve them without an SSH round-trip per render. The mirror
 * was historically download-once (`fs.existsSync` → skip), so a chart the
 * session regenerated on the remote host kept serving its FIRST bytes forever.
 *
 * Fix: every download records a `<file>.src.json` sidecar ({host, remotePath,
 * remote mtime/size}). When /api/local-image serves a mirror file it calls
 * `revalidateMirror()` — a throttled daemon `fs.stat`; if the remote changed,
 * the mirror is re-downloaded before serving. Best-effort by design: any
 * failure (host down, old daemon without fs.stat) serves the cached bytes.
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { REMOTE_IMAGES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

export interface MirrorSidecar {
  host: string
  remotePath: string
  /** Remote file's mtime at download time (0 = unknown → compare sizes only). */
  remoteMtimeMs: number
  /** Remote file's size at download time. */
  remoteSize: number
}

const SIDECAR_SUFFIX = '.src.json'

/** Min interval between remote stats for one mirror file (per process). */
const REVALIDATE_INTERVAL_MS = 5_000
/** Hard cap on one revalidation attempt (stat + optional re-download). */
const REVALIDATE_TIMEOUT_MS = 4_000
/** Hard cap on a first-time mirror download. <img> renders aren't bound by the
 *  API client's 15s timeout (browser image loads wait minutes), so without
 *  this an unreachable host's cold daemon connect (~40s worst case) held one
 *  of the browser's 6 connections per image. Warm-path downloads finish in
 *  <2s; a timeout just fails this render and the next one retries. */
const DOWNLOAD_TIMEOUT_MS = 10_000

const lastRevalidatedAt = new Map<string, number>()

export function sidecarPathFor(mirrorPath: string): string {
  return mirrorPath + SIDECAR_SUFFIX
}

/**
 * Mirror slot for a session-referenced remote image — hash-keyed by the FULL
 * source path (same scheme as media-v1's cachePathFor), NOT the bare basename.
 * A session can reference /tmp/a/chart.png and /workspace/b/chart.png in one
 * transcript; a basename key makes the second silently serve the first's bytes
 * (and its sidecar then revalidates against the WRONG remote source forever).
 *
 * Bare-basename legacy slots (pre-hash mirrors + the EKS-MCP "identical path on
 * both hosts" convention in local-image.ts) still resolve — this is only for
 * NEW slots minted by the rewrite paths.
 */
export function sessionMirrorPath(sessionId: string, remotePath: string): string {
  const hash = crypto.createHash('sha256').update(remotePath).digest('hex').slice(0, 16)
  return path.join(REMOTE_IMAGES_DIR, sessionId, `${hash}-${path.basename(remotePath)}`)
}

/**
 * Resolve the mirror slot for a session image. Prefers the hash-keyed slot; a
 * legacy bare-basename mirror is reused only when it's compatible:
 *
 * - sidecar names an accepted origin → same source, reuse;
 * - no sidecar (pre-sidecar mirror) → reuse; the caller backfills one with
 *   size -1, which makes the next revalidation re-download from the claimed
 *   origin — so even a mis-attributed legacy file converges to correct bytes;
 * - sidecar names a DIFFERENT origin → proven basename collision (the exact
 *   bug this scheme replaces) → mint the hash slot instead.
 *
 * `acceptOrigins` covers the relative-name rewrite, where the download races
 * several candidate paths and the sidecar records whichever candidate won.
 */
export function resolveSessionMirrorPath(
  sessionId: string,
  remotePath: string,
  acceptOrigins?: string[],
): string {
  const hashed = sessionMirrorPath(sessionId, remotePath)
  if (fs.existsSync(hashed)) return hashed
  const legacy = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(remotePath))
  if (fs.existsSync(legacy)) {
    try {
      const sc = JSON.parse(fs.readFileSync(sidecarPathFor(legacy), 'utf-8')) as Partial<MirrorSidecar>
      const origins = acceptOrigins ?? [remotePath]
      if (typeof sc.remotePath === 'string' && origins.includes(sc.remotePath)) return legacy
      // different origin recorded — collision; fall through to the hash slot
    } catch {
      return legacy // pre-sidecar mirror — reuse; caller's backfill self-heals it
    }
  }
  return hashed
}

/** True when a path lives inside the remote-images mirror tree. */
export function isMirrorPath(p: string): boolean {
  const resolved = path.resolve(p)
  return resolved.startsWith(REMOTE_IMAGES_DIR + path.sep)
}

/**
 * The shape of a mirror slot as it appears ANYWHERE inside a longer string:
 * `…/images/remote/<session uuid>/<one file>`. Deliberately matched on the TAIL
 * rather than against REMOTE_IMAGES_DIR, because that root is not a constant of
 * the data: it follows WALNUT_DAEMON_DIR, so a path written under one daemon dir
 * (a sandbox, a test, an older install) is still a mirror slot and still must not
 * be mirrored a second time.
 */
const MIRROR_SLOT_TAIL_RE = new RegExp(
  '(?:^|/)images/remote/(?:' +
    // …/<session uuid>/<anything> — covers legacy bare-basename slots too.
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+' +
    // …/<any bucket>/<16-hex>-<name> — the hash-keyed slot naming, which is also
    // used under a HOST alias (/api/local-image's host cache) and under the
    // literal `unknown` when a session has no claude id yet.
    '|[^/]+/[0-9a-f]{16}-[^/]+' +
  ')$',
  'i',
)

/**
 * True when a path is a mirror slot, OR merely CONTAINS one — which means it is
 * already-rewritten text that something glued a prefix onto.
 *
 * Why `isMirrorPath` alone is not enough (proven from a real transcript,
 * 2026-09-03): a streaming delta boundary fell immediately before an absolute
 * image path, so the fragment `/architecture.png` looked like a complete path of
 * its own and was rewritten to a mirror slot. Re-joining the deltas produced
 * `<session cwd>/images` + `/tmp/open-walnut/images/remote/<sid>/<hash>-architecture.png`,
 * i.e. one string that starts in the source tree and ends in the mirror. The
 * chunk-edge half is fixed (`excludeEdges`), but every LATER rewrite still sees
 * that stored string as a brand-new remote path: it does not start with the
 * mirror dir, so it gets its own slot, whose basename then carries TWO hash
 * prefixes (`<hash2>-<hash1>-architecture.png` — verified by recomputing both
 * hashes from the stored text). That second slot can never be downloaded, so the
 * reference stays broken AND every replay re-attempts the download.
 *
 * Refusing to mirror such a path leaves the (already broken) reference alone
 * instead of minting a second doomed slot per replay.
 *
 * The trade this makes: a path written under a DIFFERENT WALNUT_DAEMON_DIR is also
 * skipped, even though local-image.ts documents a convention where such a path can
 * genuinely exist on the remote host. That needs a daemon-dir mismatch to happen at
 * all, and the cost is one image not mirrored rather than a transcript rewritten
 * wrong on every replay.
 */
export function looksAlreadyMirrored(p: string): boolean {
  // isMirrorPath resolves against the server's cwd, which is meaningless for a
  // relative reference out of a transcript — the tail match is the whole answer there.
  if (path.isAbsolute(p) && isMirrorPath(p)) return true
  return MIRROR_SLOT_TAIL_RE.test(p)
}

/** Record where a mirror file came from (fire-and-forget safe; sync + tiny). */
export function writeMirrorSidecar(
  mirrorPath: string,
  sidecar: MirrorSidecar,
): void {
  try {
    fs.writeFileSync(sidecarPathFor(mirrorPath), JSON.stringify(sidecar))
  } catch {
    /* best-effort */
  }
}

export async function readMirrorSidecar(mirrorPath: string): Promise<MirrorSidecar | null> {
  try {
    const raw = await fsp.readFile(sidecarPathFor(mirrorPath), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MirrorSidecar>
    if (typeof parsed.host !== 'string' || typeof parsed.remotePath !== 'string') return null
    return {
      host: parsed.host,
      remotePath: parsed.remotePath,
      remoteMtimeMs: typeof parsed.remoteMtimeMs === 'number' ? parsed.remoteMtimeMs : 0,
      remoteSize: typeof parsed.remoteSize === 'number' ? parsed.remoteSize : -1,
    }
  } catch {
    return null
  }
}

/**
 * Backfill a sidecar for a mirror file downloaded before sidecars existed, so
 * it becomes revalidatable. Size is recorded as -1 ("unknown") — NOT the local
 * file's size — so the first revalidation always treats the mirror as suspect
 * and re-downloads once, establishing the true remote mtime/size baseline.
 */
export function backfillMirrorSidecar(mirrorPath: string, host: string, remotePath: string): void {
  if (fs.existsSync(sidecarPathFor(mirrorPath))) return
  writeMirrorSidecar(mirrorPath, { host, remotePath, remoteMtimeMs: 0, remoteSize: -1 })
}

async function statRemote(host: string, remotePath: string): Promise<{ mtimeMs: number; size: number } | null> {
  const { getDaemonConnection } = await import('../providers/daemon-connection.js')
  const { getConfig } = await import('./config-manager.js')
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) return null
  const conn = await getDaemonConnection(host, {
    hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port,
  })
  const result = await conn.send('fs.stat', { path: remotePath })
  if (!result.ok) return null // old daemon / transient — caller serves cached
  if (!result.exists) return null // remote deleted — keep serving the mirror
  return { mtimeMs: result.mtimeMs as number, size: result.size as number }
}

async function fetchRemoteBytes(host: string, remotePath: string): Promise<Buffer | null> {
  const { getDaemonConnection } = await import('../providers/daemon-connection.js')
  const { getConfig } = await import('./config-manager.js')
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) return null
  const conn = await getDaemonConnection(host, {
    hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port,
  })
  const result = await conn.send('fs.read', { path: remotePath, encoding: 'base64' })
  if (!result.ok || typeof result.data !== 'string') return null
  return Buffer.from(result.data, 'base64')
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ])
}

/**
 * Ensure a mirror file is fresh before serving. Returns the fresh bytes when
 * the remote changed and the re-download succeeded, null when the cached file
 * is already fresh / can't be checked (caller serves the disk copy). Throttled
 * per path so image-heavy renders don't storm the daemon with stats.
 */
export async function revalidateMirror(mirrorPath: string): Promise<Buffer | null> {
  const now = Date.now()
  const last = lastRevalidatedAt.get(mirrorPath)
  if (last !== undefined && now - last < REVALIDATE_INTERVAL_MS) return null
  lastRevalidatedAt.set(mirrorPath, now)
  if (lastRevalidatedAt.size > 1000) lastRevalidatedAt.clear() // bounded

  const sidecar = await readMirrorSidecar(mirrorPath)
  if (!sidecar) return null

  return withTimeout(
    (async (): Promise<Buffer | null> => {
      const remote = await statRemote(sidecar.host, sidecar.remotePath)
      if (!remote) return null
      const unchanged =
        remote.size === sidecar.remoteSize &&
        (sidecar.remoteMtimeMs === 0 || remote.mtimeMs === sidecar.remoteMtimeMs)
      if (unchanged) return null

      const buf = await fetchRemoteBytes(sidecar.host, sidecar.remotePath)
      if (!buf) return null
      try {
        fs.writeFileSync(mirrorPath, buf)
      } catch {
        return null
      }
      writeMirrorSidecar(mirrorPath, {
        ...sidecar,
        remoteMtimeMs: remote.mtimeMs,
        remoteSize: remote.size,
      })
      log.web.info('remote-image mirror refreshed', {
        mirrorPath, host: sidecar.host, remotePath: sidecar.remotePath, size: buf.length,
      })
      return buf
    })().catch(() => null),
    REVALIDATE_TIMEOUT_MS,
    null,
  )
}

// ── Fetches that came back "not there" ───────────────────────────────
// A remote path that is not there is not there, and asking again on every render
// costs a daemon round trip each time. That is not hypothetical: a transcript can
// contain an image reference that can NEVER resolve (a path corrupted by an old
// rewrite, or a file the agent deleted), and history replay re-derives its
// candidate list from scratch on every open, refocus and reconnect. Measured on a
// real session: three unresolvable images x three candidates = nine failing
// fs.read calls, repeating every few minutes for days.
//
// Two rules keep this from turning a storm into a broken image:
//
//  * Only a definitive NOT-FOUND is remembered. A transport failure, a cold daemon
//    connect (the DOWNLOAD_TIMEOUT_MS note above measures that at ~40s against a
//    10s cap) or a tunnel flap says nothing about whether the file exists, and
//    muting on those would make the FIRST load after a restart the likeliest one
//    to go dark. The daemon tags its ENOENT so this distinction is available.
//  * Backoff, not a flat window. A model routinely NAMES an image in prose a moment
//    before the tool writes it, so a first miss has to be cheap to retry (30s); a
//    path that keeps missing doubles its way up to 10 minutes, which is what
//    actually ends the storm.
const FETCH_MISS_BASE_MS = 30 * 1000
const FETCH_MISS_MAX_MS = 10 * 60 * 1000
const FETCH_MISS_MAX_KEYS = 500
const missedFetches = new Map<string, { at: number; misses: number }>()

const missKey = (host: string, remotePath: string) => `${host} ${remotePath}`

/** Cap the exponent, not just its result: `2 ** 4000` is Infinity. */
const muteWindowMs = (misses: number) =>
  Math.min(FETCH_MISS_BASE_MS * 2 ** Math.min(Math.max(0, misses - 1), 20), FETCH_MISS_MAX_MS)

/**
 * Is this exact fetch still muted?
 *
 * An expired record is deliberately KEPT, not pruned: the miss count is the whole
 * backoff, and dropping it here resets every path to its 30s window forever (my
 * first version did exactly that, and the escalation test caught it). Records leave
 * only on a success (`noteFetchFound`) or via the size cap.
 */
export function fetchRecentlyMissing(host: string, remotePath: string): boolean {
  const rec = missedFetches.get(missKey(host, remotePath))
  if (!rec) return false
  return Date.now() - rec.at < muteWindowMs(rec.misses)
}

/**
 * Remember that the host definitively does NOT have this path. Callers must pass
 * only that — never a timeout, a transport error, or a local write failure, each of
 * which says nothing about whether the file exists.
 *
 * Exported because RemoteSessionManager reads remote bytes through its own live
 * connection rather than through `downloadToMirror`, and the storm this cache
 * exists to stop is the same one.
 */
export function noteFetchMissing(host: string, remotePath: string): void {
  const key = missKey(host, remotePath)
  const prev = missedFetches.get(key)
  // Map iteration is insertion-ordered, and `set` on an existing key does NOT move
  // it — delete first, so "the first key is the oldest" stays true.
  if (prev) missedFetches.delete(key)
  else if (missedFetches.size >= FETCH_MISS_MAX_KEYS) {
    const oldest = missedFetches.keys().next().value
    if (oldest !== undefined) missedFetches.delete(oldest)
  }
  const misses = (prev?.misses ?? 0) + 1
  missedFetches.set(key, { at: Date.now(), misses })
  // Log the first miss only. The storm this cache stops was invisible in the walnut
  // log — it could only be seen in the exec host's own daemon log, on another machine.
  if (!prev) {
    log.web.info('remote-image not found on host', { host, remotePath, mutedForMs: muteWindowMs(misses) })
  }
}

/** A path that resolved is no longer suspect — drop any backoff it accumulated. */
export function noteFetchFound(host: string, remotePath: string): void {
  missedFetches.delete(missKey(host, remotePath))
}

/** Test seam — module state has to be resettable between cases. */
export function clearFailedFetches(): void {
  missedFetches.clear()
}

/**
 * Does this daemon reply mean "the host does not have that file", as opposed to
 * "we could not ask"? The daemon appends the errno to its fs.read error text for
 * exactly this purpose.
 *
 * A daemon too old to tag the code simply never looks missing, so those hosts fall
 * back to the previous behaviour (retry every replay) instead of muting an image
 * that might be fine. Degrading toward the noisy answer is the right direction: a
 * broken picture is worse than a repeated read.
 */
export function isNotFoundReply(reply: { ok?: boolean; error?: unknown; exists?: unknown }): boolean {
  if (reply.exists === false) return true
  if (reply.ok !== false) return false
  return typeof reply.error === 'string' && /\bENOENT\b/.test(reply.error)
}

/**
 * Read remote bytes, distinguishing "the host says it has no such file" from
 * "we could not ask". Only the former may be cached: see the note above.
 */
async function readRemoteBytes(
  host: string,
  remotePath: string,
): Promise<{ bytes: Buffer } | { missing: true } | { unreachable: true }> {
  const { getDaemonConnection } = await import('../providers/daemon-connection.js')
  const { getConfig } = await import('./config-manager.js')
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) return { unreachable: true }
  const conn = await getDaemonConnection(host, {
    hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port,
  })
  const result = await conn.send('fs.read', { path: remotePath, encoding: 'base64' })
  if (result.ok && typeof result.data === 'string') return { bytes: Buffer.from(result.data, 'base64') }
  return isNotFoundReply(result) ? { missing: true } : { unreachable: true }
}

/**
 * Download a remote file into the mirror and record its sidecar. Returns the
 * bytes, or null on failure. The post-download stat pins the true remote
 * mtime/size so later revalidations compare against reality, not wall-clock.
 *
 * A path the host recently said it does not have returns null WITHOUT touching the
 * daemon — see the note above the cache. A path we merely failed to REACH is
 * retried, every time.
 */
export async function downloadToMirror(
  host: string,
  remotePath: string,
  mirrorPath: string,
): Promise<Buffer | null> {
  if (fetchRecentlyMissing(host, remotePath)) return null
  const read = await withTimeout(
    readRemoteBytes(host, remotePath).catch(() => ({ unreachable: true }) as const),
    DOWNLOAD_TIMEOUT_MS,
    { unreachable: true } as const,
  )
  if ('missing' in read) {
    noteFetchMissing(host, remotePath)
    return null
  }
  if (!('bytes' in read)) return null // could not ask — say nothing about the file
  const buf = read.bytes
  noteFetchFound(host, remotePath)
  try {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })
    fs.writeFileSync(mirrorPath, buf)
  } catch {
    return null
  }
  // Connection is warm here (bytes just arrived on it), but this still sits on
  // the request path — bound it so a daemon that wedged mid-request can't hold
  // the response. mtime 0 = "unknown" → first revalidation re-establishes it.
  const remote = await withTimeout(statRemote(host, remotePath).catch(() => null), REVALIDATE_TIMEOUT_MS, null)
  writeMirrorSidecar(mirrorPath, {
    host,
    remotePath,
    remoteMtimeMs: remote?.mtimeMs ?? 0,
    remoteSize: remote?.size ?? buf.length,
  })
  return buf
}
