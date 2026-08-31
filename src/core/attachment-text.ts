/**
 * attachment-text.ts — extract searchable text from binary attachments
 * (PDF text layer / Vision OCR) into notes-index.sqlite's attachment_text.
 *
 * Design constraints (same bar as the drift scan):
 * - ALL heavy work happens in a spawned, niced CHILD process (swift helper
 *   using PDFKit + Vision) — the server event loop only awaits.
 * - Strictly serial: one extraction at a time, queued.
 * - Content-hash keyed: a file is never re-extracted unless its bytes change;
 *   failed extractions are recorded and not retried for the same bytes.
 * - Compiling, signing and caching the swift helper belong to
 *   src/core/helper-build.ts (system frameworks only, no third-party deps). No
 *   swiftc on the box and the feature quietly degrades to 'unavailable'.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR, CLOUD_MODE } from '../constants.js'
import { ensureHelper, type HelperSpec } from './helper-build.js'
import { log } from '../logging/index.js'
import {
  getAttachmentMeta,
  upsertAttachmentText,
  deleteAttachmentText,
  listAttachmentMeta,
} from './notes-index.js'

const EXTRACTABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.gif'])
/** Attachments larger than this are skipped (huge scans stall the queue). */
const MAX_BYTES = 50 * 1024 * 1024
const EXTRACT_TIMEOUT_MS = 60_000
const HELPER_VERSION = 'v1'

export function isExtractableAttachment(relPath: string): boolean {
  if (relPath.split('/').some((p) => p.startsWith('.'))) return false
  return EXTRACTABLE.has(path.extname(relPath).toLowerCase())
}

// ── Lazy helper compilation ──────────────────────────────────────────────────

/** No infoPlist and no identifier-stability worry from TCC: PDFKit and Vision
 *  need no permission at all. The identifier is still pinned and version-free so
 *  every helper signs the same way (see src/core/helper-build.ts). */
const HELPER_SPEC: HelperSpec = {
  name: 'walnut-extract',
  version: HELPER_VERSION,
  identifier: 'dev.openwalnut.extract',
}

// ── Extraction (out-of-process, serial) ──────────────────────────────────────

function runExtractor(bin: string, absPath: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const child = spawn('nice', ['-n', '15', bin, absPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { child.kill('SIGKILL') }, EXTRACT_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, text: '' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(chunks).toString('utf-8').trim()
      resolve({ ok: code === 0, text })
    })
  })
}

/** Serial work queue — extraction is CPU-heavy in the child; never parallel. */
let queueTail: Promise<void> = Promise.resolve()
const queuedPaths = new Set<string>()

/**
 * Queue one attachment for extraction. Coalesces duplicates; resolves when
 * THIS path's extraction (or skip) completes.
 */
export function scheduleAttachmentExtract(relPath: string): Promise<void> {
  const norm = relPath.replace(/\\/g, '/')
  if (!isExtractableAttachment(norm)) return Promise.resolve()
  if (queuedPaths.has(norm)) return Promise.resolve()
  queuedPaths.add(norm)
  const run = queueTail.then(async () => {
    queuedPaths.delete(norm)
    try {
      await extractOne(norm)
    } catch (err) {
      log.memory.debug('attachment-text: extract failed', {
        path: norm,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  queueTail = run
  return run
}

async function extractOne(relPath: string): Promise<void> {
  const abs = path.join(NOTES_DIR, relPath)
  let stat: fs.Stats
  try {
    stat = await fsp.stat(abs)
  } catch {
    deleteAttachmentText(relPath) // gone → drop its text
    return
  }
  if (stat.size > MAX_BYTES) return

  const bytes = await fsp.readFile(abs)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const existing = getAttachmentMeta(relPath)
  // Same bytes → done ('ok'/'empty') or known-bad input ('failed'). 'unavailable'
  // means the EXTRACTOR was missing, not that the file is bad — retry those, so
  // rows written before the helper compiled (or on a machine without swiftc)
  // heal once it exists.
  if (existing && existing.content_hash === hash && existing.status !== 'unavailable') return

  const bin = await ensureHelper(HELPER_SPEC, 'walnut-extract.swift')
  if (!bin) {
    upsertAttachmentText({
      path: relPath, content_hash: hash, text: '', method: 'none',
      status: 'unavailable', mtime: stat.mtime.toISOString(), size: stat.size,
    })
    return
  }
  const started = Date.now()
  const { ok, text } = await runExtractor(bin, abs)
  const method = path.extname(relPath).toLowerCase() === '.pdf' ? 'pdf' : 'ocr'
  upsertAttachmentText({
    path: relPath,
    content_hash: hash,
    text: ok ? text.slice(0, 500_000) : '',
    method,
    status: ok ? (text ? 'ok' : 'empty') : 'failed',
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  })
  log.memory.debug('attachment-text: extracted', {
    path: relPath, ok, chars: text.length, ms: Date.now() - started,
  })
}

// ── Backfill (deferred, serial, resumable) ───────────────────────────────────

let backfillStarted = false

/** Recursively collect extractable attachment relpaths under NOTES_DIR. */
async function collectAttachmentPaths(): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const rel = path.relative(NOTES_DIR, full).replace(/\\/g, '/')
        if (isExtractableAttachment(rel)) out.push(rel)
      }
    }
  }
  await walk(NOTES_DIR)
  return out
}

/**
 * Backfill every attachment that has no up-to-date extraction. Runs through the
 * same serial queue (one niced child at a time), so however large the backlog,
 * server impact stays "one background child process". Content-hash skip makes
 * it resumable/idempotent — restarting mid-backfill costs only stats+hashes.
 */
export async function backfillAttachments(): Promise<{ queued: number; total: number }> {
  const all = await collectAttachmentPaths()
  const known = new Map(listAttachmentMeta().map((r) => [r.path, r]))
  let queued = 0
  for (const rel of all) {
    const row = known.get(rel)
    // Unchanged stat → skip, UNLESS the row is 'unavailable' (extractor was
    // missing when it was written — retry now that it may exist).
    if (row && row.status !== 'unavailable') {
      try {
        const stat = await fsp.stat(path.join(NOTES_DIR, rel))
        if (stat.mtime.toISOString() === row.mtime && stat.size === row.size) continue
      } catch { continue }
    }
    void scheduleAttachmentExtract(rel)
    queued++
  }
  // Deletions: extracted rows whose file vanished.
  const onDisk = new Set(all)
  for (const rel of known.keys()) {
    if (!onDisk.has(rel)) deleteAttachmentText(rel)
  }
  if (queued > 0) {
    log.memory.info('attachment-text: backfill queued', { queued, total: all.length })
  }
  return { queued, total: all.length }
}

/** Kick the backfill once per process, deferred off the boot path. */
export function startAttachmentBackfill(delayMs = 60_000): void {
  if (backfillStarted || CLOUD_MODE || process.platform !== 'darwin') return
  backfillStarted = true
  const timer = setTimeout(() => {
    void backfillAttachments().catch((err) => {
      log.memory.warn('attachment-text: backfill failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, delayMs)
  timer.unref?.()
}
