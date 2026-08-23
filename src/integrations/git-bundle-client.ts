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
 *
 * CONVERGENCE (2026-08-22, round 2). Splitting the payload is not enough once
 * the payload is big enough: at 2.5GB of pack the bundle is ~210 chunks, the
 * filter kills a few of them at random, and the FIRST chunk to burn its retries
 * used to abort the whole run (observed: chunk 104 of 210). The next attempt
 * started again at chunk 1, so nothing ever landed. Three mechanisms fix that,
 * in order of how much of the problem they own:
 *
 *   1. Within-run sweeps. After the sequential pass stalls, wait (seconds to a
 *      minute) and walk again from the chunk that failed — the chunks before it
 *      are already stored on the hub, so a sweep only re-sends what's missing.
 *      A chunk that fails six times in a row almost always succeeds minutes
 *      later, and this is what makes a 210-chunk run converge in ONE run.
 *   2. Deeper per-chunk retries: 6 attempts with exponential backoff + jitter
 *      (was 3 at a fixed 500ms ramp), so a brief filter tantrum is absorbed
 *      without escalating to a sweep at all.
 *   3. Cross-run resume. The lease id + bundle identity are persisted in the
 *      repo's git dir, so a later run that produces the SAME bundle asks the
 *      hub how far it got and skips those chunks. This engages when nothing
 *      new was committed between attempts; when the bundle differs, the hub
 *      says "mismatch" and we start a clean lease.
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
export const CHUNK_RETRIES = 6
/** Backoff between chunk attempts: 500ms doubling, jittered, capped. */
export const CHUNK_BACKOFF_BASE_MS = 500
export const CHUNK_BACKOFF_CAP_MS = 30_000
/**
 * Passes over the chunk list. Pass 1 is the ordinary sequential upload; each
 * later pass re-sends only what the previous pass could not (the hub keeps
 * everything up to the stall), after a longer wait.
 */
export const MAX_SWEEPS = 3
/** Wait before sweep N+1: 5s, then 10s, doubling to the cap. */
export const SWEEP_BACKOFF_BASE_MS = 5_000
export const SWEEP_BACKOFF_CAP_MS = 60_000
/**
 * Whole-delivery budget. Compaction pauses the 30s auto-commit tick for its
 * worker's lifetime, so retrying forever silently stops data backups; when the
 * budget runs out we stop and KEEP the lease, which is exactly the state the
 * next run resumes from.
 */
const DELIVERY_BUDGET_MS = (() => {
  const raw = Number(process.env.WALNUT_BUNDLE_DELIVERY_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000
})()

/** The retry/sweep clocks, as one object so tests can shrink them. */
const DEFAULT_TUNING = {
  chunkRetries: CHUNK_RETRIES,
  chunkBackoffBaseMs: CHUNK_BACKOFF_BASE_MS,
  chunkBackoffCapMs: CHUNK_BACKOFF_CAP_MS,
  sweeps: MAX_SWEEPS,
  sweepBackoffBaseMs: SWEEP_BACKOFF_BASE_MS,
  sweepBackoffCapMs: SWEEP_BACKOFF_CAP_MS,
  budgetMs: DELIVERY_BUDGET_MS,
}
let tuning = { ...DEFAULT_TUNING }

/**
 * Test hook: shrink the retry/sweep clocks. Exercising the sweep path at
 * production timings would mean a 70-second unit test, and a test that slow
 * gets deleted instead of maintained. Pass null to restore the real values.
 */
export function _setBundleRetryTuningForTesting(next: Partial<typeof DEFAULT_TUNING> | null): void {
  tuning = next ? { ...DEFAULT_TUNING, ...next } : { ...DEFAULT_TUNING }
}

/**
 * Delay before chunk retry `attempt` (0-based). Exponential with ±25% jitter so
 * a hundred sequential chunks hitting the same filter don't retry in lockstep.
 * `rand` is injectable to keep this a pure, testable function.
 */
export function chunkRetryDelayMs(attempt: number, rand = Math.random()): number {
  const raw = tuning.chunkBackoffBaseMs * 2 ** Math.max(0, attempt)
  // Cap AFTER jitter: the cap is a promise about the longest we ever sleep, and
  // capping first lets the +25% jitter push the delay past it.
  return Math.min(tuning.chunkBackoffCapMs, Math.round(raw * (0.75 + rand * 0.5)))
}

/** Delay before sweep `sweep` (0-based: the wait before the 2nd pass). */
export function sweepBackoffMs(sweep: number, rand = Math.random()): number {
  const raw = tuning.sweepBackoffBaseMs * 2 ** Math.max(0, sweep)
  return Math.min(tuning.sweepBackoffCapMs, Math.round(raw * (0.75 + rand * 0.5)))
}

export interface BundlePushResult {
  ok: boolean
  /** Total bundle bytes shipped (0 when we never got to sending). */
  bytes: number
  chunks: number
  error?: string
  /** First chunk this run had to send (>0 means a resume skipped work). */
  resumedFromSeq?: number
  /** Passes over the chunk list that were needed (1 = clean run). */
  sweeps?: number
  /** Chunk requests this run actually sent (excludes resumed-past chunks). */
  chunksSent?: number
  /** True when the lease was left on the hub for a later run to resume. */
  leaseKept?: boolean
}

/** Lease bookkeeping persisted in the repo's git dir between runs. */
interface BundleLeaseState {
  uploadId: string
  /** Bundle identity — a lease may only be resumed for the SAME bytes. */
  sha256: string
  bytes: number
  chunkBytes: number
  /** Hub the lease lives on (base URL without credentials). */
  base: string
  ref: string
  nextSeq: number
  updatedAt: string
}

const LEASE_STATE_FILE = 'bundle-upload-state.json'

async function readLeaseState(gitDir: string): Promise<BundleLeaseState | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(gitDir, LEASE_STATE_FILE), 'utf-8')) as Partial<BundleLeaseState>
    if (!parsed.uploadId || !parsed.sha256 || !parsed.base) return null
    return {
      uploadId: parsed.uploadId,
      sha256: parsed.sha256,
      bytes: Number(parsed.bytes) || 0,
      chunkBytes: Number(parsed.chunkBytes) || 0,
      base: parsed.base,
      ref: parsed.ref ?? '',
      nextSeq: Number(parsed.nextSeq) || 0,
      updatedAt: parsed.updatedAt ?? '',
    }
  } catch {
    return null
  }
}

async function writeLeaseState(gitDir: string, state: BundleLeaseState): Promise<void> {
  await fsp.writeFile(path.join(gitDir, LEASE_STATE_FILE), JSON.stringify(state), 'utf-8').catch(() => {})
}

async function clearLeaseState(gitDir: string): Promise<void> {
  await fsp.rm(path.join(gitDir, LEASE_STATE_FILE), { force: true }).catch(() => {})
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
  return request('POST', urlStr, auth, body, contentType, timeoutMs)
}

function request(method: 'POST' | 'GET', urlStr: string, auth: string, body: Buffer | null, contentType: string, timeoutMs: number): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method,
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

/** What the hub says about a lease we hoped to resume. */
type LeaseStatus =
  | { kind: 'ok'; nextSeq: number; bytes: number; complete: boolean }
  /** The lease holds a DIFFERENT bundle — start clean, don't append to it. */
  | { kind: 'mismatch'; reason: string }
  /** Lease gone (expired/swept). Start clean. */
  | { kind: 'gone' }
  /** Hub predates the status route (or is unreachable) — no resume, full upload. */
  | { kind: 'unsupported'; detail: string }

/**
 * Ask the hub how far a lease got.
 *
 * Capability gate: an older hub has no /bundle/status route, so express answers
 * its own 404 with an HTML body and no `code` field. The route's own "expired"
 * 404 always carries `code:'expired'`, so the two 404s are distinguishable —
 * and either way the caller falls back to a full upload, exactly as today.
 */
async function queryLeaseStatus(
  base: string, auth: string, uploadId: string,
  declared: { sha256: string; bytes: number; chunkBytes: number },
): Promise<LeaseStatus> {
  const url = `${base}/bundle/status?upload=${uploadId}&sha256=${declared.sha256}`
    + `&bytes=${declared.bytes}&chunk=${declared.chunkBytes}`
  let res: PostResult
  try {
    res = await request('GET', url, auth, null, 'application/json', 30_000)
  } catch (err) {
    return { kind: 'unsupported', detail: err instanceof Error ? err.message : String(err) }
  }
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(res.body) as Record<string, unknown> } catch { /* HTML 404 etc. */ }
  if (res.status === 200 && parsed.ok === true) {
    return {
      kind: 'ok',
      nextSeq: Number(parsed.nextSeq) || 0,
      bytes: Number(parsed.bytes) || 0,
      complete: parsed.complete === true,
    }
  }
  if (res.status === 409 && parsed.code === 'mismatch') {
    return { kind: 'mismatch', reason: String(parsed.mismatch ?? 'mismatch') }
  }
  if (res.status === 404 && parsed.code === 'expired') return { kind: 'gone' }
  return { kind: 'unsupported', detail: `HTTP ${res.status}` }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Push `branch` to the hub via the chunked bundle channel.
 *
 * @param opts.oldValue  the remote tip we believe (CAS/lease); '' or undefined
 *                       means "create — fail if the ref already exists".
 *                       Pass the value you fetched before deciding to push.
 * @param opts.basis     commits already on the remote (bundle prerequisite),
 *                       normally the same as oldValue. When omitted the bundle
 *                       carries FULL history (works, just bigger).
 * @param opts.chunkBytes override the chunk size (tests / tuning only). The
 *                       value is declared to the hub, so resume math agrees.
 */
export async function pushViaBundle(opts: {
  repoDir?: string
  branch: string
  remoteUrl: string
  oldValue?: string
  basis?: string
  chunkBytes?: number
}): Promise<BundlePushResult> {
  const repoDir = opts.repoDir ?? WALNUT_HOME
  const chunkBytes = opts.chunkBytes && opts.chunkBytes > 0 ? opts.chunkBytes : BUNDLE_CHUNK_BYTES
  const endpoint = bundleEndpointFromRemote(opts.remoteUrl)
  if (!endpoint) {
    return { ok: false, bytes: 0, chunks: 0, error: 'origin is not an http(s) walnut hub' }
  }
  // Lease state lives in the repo's own git dir, beside compaction-state.json:
  // it belongs to THIS repo's push, survives restarts, and is never committed.
  // `--absolute-git-dir` (not `<repo>/.git`) so a worktree or a bare repo works.
  const gitDir = await runGit(repoDir, ['rev-parse', '--absolute-git-dir'], 15_000)
    .catch(() => path.join(repoDir, '.git'))

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
    const declared = { sha256, bytes: size, chunkBytes }
    const totalChunks = Math.max(1, Math.ceil(size / chunkBytes))
    const ref = `refs/heads/${opts.branch}`

    // 3. Lease: resume the one we left behind if it holds THIS bundle, else
    //    open a fresh one. `resumable` is the hub's capability signal — an
    //    older hub omits it and we behave exactly as before (no status calls,
    //    no persisted state, full upload).
    let uploadId = ''
    let startSeq = 0
    let resumable = false
    const prior = await readLeaseState(gitDir)
    if (prior && prior.sha256 === sha256 && prior.chunkBytes === chunkBytes
        && prior.bytes === size && prior.base === endpoint.base) {
      const status = await queryLeaseStatus(endpoint.base, endpoint.auth, prior.uploadId, declared)
      if (status.kind === 'ok') {
        uploadId = prior.uploadId
        startSeq = Math.min(status.nextSeq, totalChunks)
        resumable = true
        log.git.info('bundle push resuming previous lease', {
          branch: opts.branch, uploadId, fromChunk: startSeq, totalChunks, bytes: size,
        })
      } else {
        log.git.info('bundle push cannot resume prior lease — starting fresh', {
          branch: opts.branch, reason: status.kind, detail: 'detail' in status ? status.detail : ('reason' in status ? status.reason : ''),
        })
        await clearLeaseState(gitDir)
      }
    } else if (prior) {
      // Different bundle (the usual case when new commits landed meanwhile).
      await clearLeaseState(gitDir)
    }

    if (!uploadId) {
      // Identity rides the QUERY STRING, not a JSON body: an older hub ignores
      // unknown query params, so this is byte-for-byte the request it expects.
      const startRes = await post(
        `${endpoint.base}/bundle/start?sha256=${sha256}&bytes=${size}&chunk=${chunkBytes}`,
        endpoint.auth, null, 'application/json', 30_000,
      )
      if (startRes.status !== 200) {
        return { ok: false, bytes: 0, chunks: 0, error: `start: HTTP ${startRes.status} ${startRes.body.slice(0, 200)}` }
      }
      const started = JSON.parse(startRes.body) as { uploadId: string; resumable?: boolean; nextSeq?: number; resumed?: boolean }
      uploadId = started.uploadId
      resumable = started.resumable === true
      if (resumable) {
        startSeq = Math.min(Math.max(0, Number(started.nextSeq) || 0), totalChunks)
        if (started.resumed) {
          log.git.info('bundle push adopted hub-side lease for identical bundle', { uploadId, fromChunk: startSeq, totalChunks })
        }
        await writeLeaseState(gitDir, {
          uploadId, sha256, bytes: size, chunkBytes, base: endpoint.base, ref,
          nextSeq: startSeq, updatedAt: new Date().toISOString(),
        })
      }
    }

    // 4. chunks — sequential, one connection each, per-chunk retry, then
    //    additional SWEEPS that re-send only what is still missing.
    const deadline = Date.now() + tuning.budgetMs
    const resumedFromSeq = startSeq
    let seq = startSeq
    let sweeps = 0
    let chunksSent = 0
    let delivered = false
    let lastErr = ''
    let leaseDead = false
    const fd = await fsp.open(bundlePath, 'r')
    try {
      const buf = Buffer.alloc(chunkBytes)
      for (let sweep = 0; sweep < tuning.sweeps && !delivered && !leaseDead; sweep++) {
        sweeps = sweep + 1
        if (sweep > 0) {
          // Give the wire time to recover, then re-ask the hub where it is: a
          // chunk whose ACK was lost is already stored, and blindly resending
          // the stalled seq would only earn a 409.
          await sleep(sweepBackoffMs(sweep - 1))
          if (resumable) {
            const status = await queryLeaseStatus(endpoint.base, endpoint.auth, uploadId, declared)
            if (status.kind === 'ok') seq = Math.min(status.nextSeq, totalChunks)
            else if (status.kind === 'gone' || status.kind === 'mismatch') {
              leaseDead = true
              lastErr = `lease unusable (${status.kind})`
              break
            }
          }
          log.git.warn('bundle push sweeping missing chunks', {
            branch: opts.branch, sweep: sweeps, fromChunk: seq, totalChunks, lastError: lastErr.slice(0, 200),
          })
        }

        // One sequential pass from `seq`. Everything before it is on the hub.
        let stalled = false
        for (; seq < totalChunks && !stalled; seq++) {
          const { bytesRead } = await fd.read(buf, 0, chunkBytes, seq * chunkBytes)
          const piece = Buffer.from(buf.subarray(0, bytesRead)) // copy — buf is reused next iteration
          let sent = false
          for (let attempt = 0; attempt < tuning.chunkRetries && !sent; attempt++) {
            try {
              const res = await post(
                `${endpoint.base}/bundle/chunk?upload=${uploadId}&seq=${seq}`,
                endpoint.auth, piece, 'application/octet-stream', CHUNK_TIMEOUT_MS,
              )
              chunksSent++
              if (res.status === 200) { sent = true; break }
              lastErr = `HTTP ${res.status}`
              // 404 = lease gone server-side; nothing about this upload can
              // be retried, and the persisted state is now worthless.
              if (res.status === 404) { leaseDead = true; break }
              // 409 = our seq disagrees with the hub's. Only ever jump FORWARD
              // (the hub already has this chunk — a lost ACK): adopting an
              // equal-or-lower seq would re-send the same chunk forever, which
              // is what a `busy` 409 answers with. Those fall through to the
              // ordinary retry+backoff below.
              if (res.status === 409) {
                try {
                  const hubSeq = Number((JSON.parse(res.body) as { nextSeq?: number }).nextSeq)
                  if (Number.isInteger(hubSeq) && hubSeq > seq) { seq = hubSeq - 1; sent = true; break }
                } catch { /* fall through to retry */ }
              }
              // 413 = over the hub's size budget; no retry can fix that.
              if (res.status === 413) { leaseDead = true; break }
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err)
              chunksSent++
            }
            if (attempt + 1 < tuning.chunkRetries) await sleep(chunkRetryDelayMs(attempt))
          }
          if (!sent) {
            stalled = true
            break // leave `seq` on the failed chunk — the next sweep starts here
          }
          if (Date.now() > deadline) { stalled = true; seq++; break }
        }
        if (!stalled) delivered = true
        else if (Date.now() > deadline) break
      }
    } finally {
      await fd.close()
    }

    if (!delivered) {
      // Chunk-level failure: KEEP the lease. Everything the hub already has
      // stays, and the next run resumes from there if it builds the same
      // bundle. A dead lease (404/mismatch/413) is worthless — drop it.
      if (leaseDead || !resumable) await clearLeaseState(gitDir)
      else {
        await writeLeaseState(gitDir, {
          uploadId, sha256, bytes: size, chunkBytes, base: endpoint.base, ref,
          nextSeq: seq, updatedAt: new Date().toISOString(),
        })
      }
      const budgetHit = Date.now() > deadline
      return {
        ok: false, bytes: size, chunks: totalChunks, chunksSent, sweeps, resumedFromSeq,
        leaseKept: !leaseDead && resumable,
        error: `chunk ${seq}/${totalChunks} failed after ${sweeps} sweep(s)`
          + `${budgetHit ? ' (delivery budget exhausted)' : ''}: ${lastErr}`
          + `${!leaseDead && resumable ? ' — lease kept for resume' : ''}`,
      }
    }

    // 5. finish — server verifies hash + bundle, fetches, CAS-updates the ref.
    //    The lease is single-shot server-side, so the state file is spent
    //    whatever the answer is.
    const finishRes = await post(
      `${endpoint.base}/bundle/finish`, endpoint.auth,
      Buffer.from(JSON.stringify({
        uploadId, sha256,
        ref,
        oldValue: opts.oldValue ?? '',
        newValue,
      })),
      'application/json', 600_000,
    )
    await clearLeaseState(gitDir)
    if (finishRes.status !== 200) {
      return { ok: false, bytes: size, chunks: totalChunks, chunksSent, sweeps, resumedFromSeq, error: `finish: HTTP ${finishRes.status} ${finishRes.body.slice(0, 300)}` }
    }
    log.git.info('bundle push delivered', {
      branch: opts.branch, bytes: size, chunks: totalChunks, chunksSent, sweeps, resumedFromSeq,
    })
    return { ok: true, bytes: size, chunks: totalChunks, chunksSent, sweeps, resumedFromSeq }
  } catch (err) {
    return { ok: false, bytes: 0, chunks: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
