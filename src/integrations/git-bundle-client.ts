/**
 * Client half of the chunked bundle push channel (see
 * src/web/routes/git-bundle-push.ts for the server and the full why).
 *
 * One-line why: endpoint-security TLS filters on some client machines corrupt
 * long sustained HTTPS uploads, so any `git push` whose pack exceeds a few
 * dozen MB dies mid-stream ("SSL bad record mac") — reproducibly, forever.
 * Short requests survive. So: pack the outgoing commits into a git bundle,
 * split it into small chunks, and send each chunk as its OWN HTTP request on
 * its OWN connection. This is the same trick the daemon deployer has used
 * successfully against the same filters since day one.
 *
 * Used as the automatic fallback wherever git-sync/compaction push to the
 * hub: try `git push` first (cheap, normal case), and when it fails on a
 * large pack, deliver via bundle instead of retrying into the same wall.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

/** Chunk size — small enough that filters ignore it, big enough to be quick.
 *  The daemon deployer's proven value is 1MB; 8MB keeps request count sane
 *  for multi-hundred-MB bundles (465MB → 59 requests). */
export const BUNDLE_CHUNK_BYTES = 8 * 1024 * 1024

/** Per-chunk send budget. A chunk is small; anything slow is a dead wire. */
const CHUNK_TIMEOUT_MS = 60_000
/** Retries per chunk (fresh connection each attempt). */
const CHUNK_RETRIES = 3

export interface BundlePushResult {
  ok: boolean
  /** Total bundle bytes shipped (0 when we never got to sending). */
  bytes: number
  chunks: number
  error?: string
}

/**
 * Derive the bundle API base + auth from the repo's origin URL
 * (`https://walnut:<token>@host/git/data`). Returns null when origin is not
 * an http(s) walnut hub — the fallback simply doesn't apply then (ssh, local
 * path, no remote).
 */
export function bundleEndpointFromRemote(remoteUrl: string): { base: string; auth: string } | null {
  let url: URL
  try {
    url = new URL(remoteUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const token = decodeURIComponent(url.password || '')
  if (!token) return null
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
  return { base, auth: `Bearer ${token}` }
}

/** Run git (list-args, no shell) in repoDir; resolve stdout or reject. */
function runGit(repoDir: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { if (child.pid && child.pid > 1) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      reject(new Error(`git ${args[0]} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf-8')).slice(-2000) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`))
    })
  })
}

interface PostResult {
  status: number
  body: string
}

/**
 * POST with a hard deadline and TRUE connection-per-request semantics.
 * Deliberately node:http(s) + `agent: false`, NOT fetch: undici pools and
 * reuses connections (and rejects a `Connection: close` header outright),
 * but a fresh TLS session per chunk is the entire defense — a filter that
 * strangles long-lived streams never sees one.
 */
function post(urlStr: string, auth: string, body: Buffer | null, contentType: string, timeoutMs: number): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method: 'POST',
      agent: false, // new socket per request, closed after — never pooled
      headers: {
        Authorization: auth,
        'Content-Type': contentType,
        'Content-Length': body ? body.length : 0,
        Connection: 'close',
      },
      timeout: timeoutMs,
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => { if (parts.reduce((n, p) => n + p.length, 0) < 64 * 1024) parts.push(c) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf-8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * Push `branch` to the hub via the chunked bundle channel.
 *
 * @param opts.oldValue  the remote tip we believe (CAS/lease); '' or undefined
 *                       means "create — fail if the ref already exists".
 *                       Pass the value you fetched before deciding to push.
 * @param opts.basis     commits already on the remote (bundle prerequisite),
 *                       normally the same as oldValue. When omitted the bundle
 *                       carries FULL history (works, just bigger).
 */
export async function pushViaBundle(opts: {
  repoDir?: string
  branch: string
  remoteUrl: string
  oldValue?: string
  basis?: string
}): Promise<BundlePushResult> {
  const repoDir = opts.repoDir ?? WALNUT_HOME
  const endpoint = bundleEndpointFromRemote(opts.remoteUrl)
  if (!endpoint) {
    return { ok: false, bytes: 0, chunks: 0, error: 'origin is not an http(s) walnut hub' }
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-bundle-'))
  const bundlePath = path.join(tmpDir, 'out.bundle')
  try {
    // 1. Build the bundle. `^<basis>` makes it incremental: only commits the
    //    hub doesn't have, so routine pushes stay small even on a big repo.
    const newValue = await runGit(repoDir, ['rev-parse', opts.branch], 30_000)
    const range = opts.basis ? [`^${opts.basis}`, opts.branch] : [opts.branch]
    await runGit(repoDir, ['bundle', 'create', bundlePath, ...range], 600_000)
    const { size } = await fsp.stat(bundlePath)

    // 2. Whole-file hash for end-to-end integrity (the transport we're
    //    defending against corrupts bytes; TLS catches it per-connection but
    //    the reassembled file must ALSO prove itself).
    const hash = crypto.createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(bundlePath)
      s.on('data', (c) => hash.update(c))
      s.on('end', resolve)
      s.on('error', reject)
    })
    const sha256 = hash.digest('hex')

    // 3. start
    const startRes = await post(`${endpoint.base}/bundle/start`, endpoint.auth, null, 'application/json', 30_000)
    if (startRes.status !== 200) {
      return { ok: false, bytes: 0, chunks: 0, error: `start: HTTP ${startRes.status} ${startRes.body.slice(0, 200)}` }
    }
    const { uploadId } = JSON.parse(startRes.body) as { uploadId: string }

    // 4. chunks — sequential, one connection each, per-chunk retry.
    const totalChunks = Math.max(1, Math.ceil(size / BUNDLE_CHUNK_BYTES))
    const fd = await fsp.open(bundlePath, 'r')
    try {
      const buf = Buffer.alloc(BUNDLE_CHUNK_BYTES)
      for (let seq = 0; seq < totalChunks; seq++) {
        const { bytesRead } = await fd.read(buf, 0, BUNDLE_CHUNK_BYTES, seq * BUNDLE_CHUNK_BYTES)
        const piece = Buffer.from(buf.subarray(0, bytesRead)) // copy — buf is reused next iteration
        let sent = false
        let lastErr = ''
        for (let attempt = 0; attempt < CHUNK_RETRIES && !sent; attempt++) {
          try {
            const res = await post(
              `${endpoint.base}/bundle/chunk?upload=${uploadId}&seq=${seq}`,
              endpoint.auth, piece, 'application/octet-stream', CHUNK_TIMEOUT_MS,
            )
            if (res.status === 200) { sent = true; break }
            lastErr = `HTTP ${res.status}`
            // 404 = session expired server-side; retrying this upload is dead.
            if (res.status === 404) break
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err)
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
        if (!sent) {
          return { ok: false, bytes: size, chunks: totalChunks, error: `chunk ${seq}/${totalChunks} failed: ${lastErr}` }
        }
      }
    } finally {
      await fd.close()
    }

    // 5. finish — server verifies hash + bundle, fetches, CAS-updates the ref.
    const finishRes = await post(
      `${endpoint.base}/bundle/finish`, endpoint.auth,
      Buffer.from(JSON.stringify({
        uploadId, sha256,
        ref: `refs/heads/${opts.branch}`,
        oldValue: opts.oldValue ?? '',
        newValue,
      })),
      'application/json', 600_000,
    )
    if (finishRes.status !== 200) {
      return { ok: false, bytes: size, chunks: totalChunks, error: `finish: HTTP ${finishRes.status} ${finishRes.body.slice(0, 300)}` }
    }
    log.git.info('bundle push delivered', { branch: opts.branch, bytes: size, chunks: totalChunks })
    return { ok: true, bytes: size, chunks: totalChunks }
  } catch (err) {
    return { ok: false, bytes: 0, chunks: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
