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

/**
 * Download a remote file into the mirror and record its sidecar. Returns the
 * bytes, or null on failure. The post-download stat pins the true remote
 * mtime/size so later revalidations compare against reality, not wall-clock.
 */
export async function downloadToMirror(
  host: string,
  remotePath: string,
  mirrorPath: string,
): Promise<Buffer | null> {
  const buf = await withTimeout(
    fetchRemoteBytes(host, remotePath).catch(() => null),
    DOWNLOAD_TIMEOUT_MS,
    null,
  )
  if (!buf) return null
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
