/**
 * QMD (embedding model) management API — status, download, reindex.
 *
 * State machine for currentStatus:
 *   ready ──→ downloading ──→ indexing ──→ ready
 *                  │              │
 *                  └──→ error ←───┘
 *
 * Guards:
 *   - If downloading, reject reindex requests.
 *   - If indexing, reject download requests.
 *   - Only one async operation at a time.
 */

import { Router, type NextFunction, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { log } from '../../logging/index.js'
import { resolveConfiguredQmdModel } from '../../core/qmd-model.js'
import { runQmdBackgroundIndex } from '../../core/qmd-background-indexer.js'
import type { QmdCorpusStats } from '../../core/qmd-stats.js'

export const qmdRouter = Router()

// ── Shared state for async operations ──

type QmdStatus = 'ready' | 'indexing' | 'downloading' | 'error'

let currentStatus: QmdStatus = 'ready'
let currentError: string | null = null
let currentStoreStats: QmdCorpusStats = {
  memory: null,
  notes: null,
  tasks: null,
  sessions: null,
}
let stopDownloadModelPoll: (() => void) | null = null

// Embedding progress — updated via onProgress callback during embed()
interface EmbedProgressInfo {
  chunksEmbedded: number
  totalChunks: number
  bytesProcessed: number
  totalBytes: number
  store: string // 'memory' | 'notes' | 'task' | 'session'
}
let currentProgress: EmbedProgressInfo | null = null

/**
 * Reset module-level state. Called on server startup and useful for tests
 * where the module may persist across restarts.
 */
export function resetQmdRouteState(): void {
  stopDownloadModelPoll?.()
  stopDownloadModelPoll = null
  currentStatus = 'ready'
  currentError = null
  currentProgress = null
  currentStoreStats = {
    memory: null,
    notes: null,
    tasks: null,
    sessions: null,
  }
}

/**
 * Set QMD route status from external callers (e.g. server.ts init path).
 * Ensures init errors are surfaced to the customer via GET /api/qmd/status.
 */
export function setQmdRouteStatus(status: QmdStatus, error?: string): void {
  currentStatus = status
  currentError = error ?? null
  if (status !== 'indexing') currentProgress = null
}

/**
 * Update embedding progress from external callers (e.g. qmd-store init).
 */
export function setQmdEmbedProgress(store: string, progress: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }): void {
  currentProgress = { ...progress, store }
}

export function setQmdStoreStats(stats: QmdCorpusStats): void {
  currentStoreStats = stats
}

// TODO: cancel endpoint — would need to abort the underlying embed() / update()
// operations, which QMD SDK doesn't currently support.

/**
 * Format bytes as a human-readable string (e.g. "1.16 GB").
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Parse a selected model URI to determine its expected GGUF filename and path.
 * Format: "hf:org/repo/filename.gguf" → file "hf_org_repo_filename.gguf"
 *
 * For non-hf: URIs, returns the raw URI as the file field with downloaded: null.
 */
function getModelInfo(modelUri: string): {
  name: string
  file: string
  size: string | null
  path: string | null
  downloaded: boolean | null
} {
  // Non-hf: URIs — we don't know the local path or download status
  if (!modelUri.startsWith('hf:')) {
    return {
      name: modelUri,
      file: modelUri,
      size: null,
      path: null,
      downloaded: null,
    }
  }

  // Parse hf:org/repo/filename.gguf → hf_org_filename.gguf
  // QMD/node-llama-cpp naming convention: hf_{org}_{filename} (repo name is skipped)
  const parts3 = modelUri.slice(3).split('/')
  const file = parts3.length >= 3
    ? `hf_${parts3[0]}_${parts3[parts3.length - 1]}`
    : 'hf_' + modelUri.slice(3).replace(/\//g, '_')

  // Parse model name from URI: hf:org/repo/filename.gguf → "repo (org/repo)"
  const parts = modelUri.slice(3).split('/')
  const name = parts.length >= 2 ? `${parts[1]} (${parts[0]}/${parts[1]})` : modelUri

  // Respect XDG_CACHE_HOME if set
  const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  const modelDir = path.join(cacheBase, 'qmd', 'models')
  const modelPath = path.join(modelDir, file)

  // Check actual file size on disk
  let downloaded = false
  let size: string | null = null
  try {
    const stat = fs.statSync(modelPath)
    downloaded = true
    size = formatBytes(stat.size)
  } catch {
    // File doesn't exist — not downloaded
    downloaded = false
    size = null
  }

  return {
    name,
    file,
    size,
    path: modelPath,
    downloaded,
  }
}

// GET /api/qmd/status
qmdRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const model = getModelInfo(await resolveConfiguredQmdModel())

    res.json({
      model,
      stores: currentStoreStats,
      status: currentStatus,
      error: currentError,
      progress: currentStatus === 'indexing' ? currentProgress : null,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/qmd/download — trigger model download + store init (async, fire-and-forget)
qmdRouter.post('/download', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    log.memory.info('POST /api/qmd/download requested', { currentStatus })

    if (currentStatus === 'downloading') {
      res.status(409).json({ status: 'downloading', message: 'Download already in progress' })
      return
    }
    if (currentStatus === 'indexing') {
      res.status(409).json({ status: 'indexing', message: 'Cannot download while indexing is in progress' })
      return
    }

    currentStatus = 'downloading'
    currentError = null
    const modelUri = await resolveConfiguredQmdModel()

    // Fire-and-forget: initialization downloads the model, then the same
    // recovery path reconciles notes, tasks, and sessions before reporting ready.
    const indexRun = runQmdBackgroundIndex({
      initialize: true,
      force: true,
      model: modelUri,
      resetStores: true,
      onProgress: setQmdEmbedProgress,
      onStats: setQmdStoreStats,
    })
    let pollForModel: ReturnType<typeof setInterval> | null = null
    let pollTimeout: ReturnType<typeof setTimeout> | null = null
    const stopPolling = () => {
      if (pollForModel) clearInterval(pollForModel)
      if (pollTimeout) clearTimeout(pollTimeout)
      pollForModel = null
      pollTimeout = null
      if (stopDownloadModelPoll === stopPolling) stopDownloadModelPoll = null
    }
    stopDownloadModelPoll?.()
    stopDownloadModelPoll = stopPolling

    void indexRun
      .then(() => {
        currentStatus = 'ready'
        currentError = null
        log.memory.info('QMD model download + corpus sync complete')
      })
      .catch((err) => {
        currentStatus = 'error'
        currentError = err instanceof Error ? err.message : String(err)
        currentProgress = null
        log.memory.error('QMD model download failed', { error: currentError })
      })
      .finally(stopPolling)

    // Transition to 'indexing' once the model file appears on disk.
    // Store initialization downloads the model during its first embed pass.
    // We poll briefly to detect when the download phase is done.
    const model = getModelInfo(modelUri)
    if (model.path) {
      pollForModel = setInterval(() => {
        if (currentStatus !== 'downloading') {
          stopPolling()
          return
        }
        try {
          if (fs.existsSync(model.path!)) {
            currentStatus = 'indexing'
            log.memory.info('QMD model downloaded, transitioning to indexing')
            stopPolling()
          }
        } catch {
          // Ignore — keep polling
        }
      }, 2000)
      // Safety: stop polling after 30 minutes even if model never appears
      pollTimeout = setTimeout(stopPolling, 30 * 60 * 1000)
      ;(pollForModel as { unref?: () => void }).unref?.()
      ;(pollTimeout as { unref?: () => void }).unref?.()
    }

    res.status(202).json({ status: 'downloading' })
  } catch (err) {
    currentStatus = 'error'
    currentError = err instanceof Error ? err.message : String(err)
    currentProgress = null
    next(err)
  }
})

// POST /api/qmd/reindex — trigger full reindex (async, fire-and-forget)
qmdRouter.post('/reindex', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    log.memory.info('POST /api/qmd/reindex requested', { currentStatus })

    if (currentStatus === 'indexing') {
      res.status(409).json({ status: 'indexing', message: 'Reindex already in progress' })
      return
    }
    if (currentStatus === 'downloading') {
      res.status(409).json({ status: 'downloading', message: 'Cannot reindex while model is downloading' })
      return
    }

    currentStatus = 'indexing'
    currentError = null
    const modelUri = await resolveConfiguredQmdModel()

    // Rebuild all stores through their canonical source adapters. Notes use
    // their programmatic QMD sync rather than store.update(), which would
    // create duplicate virtual paths.
    runQmdBackgroundIndex({
      force: true,
      model: modelUri,
      resetStores: true,
      onProgress: setQmdEmbedProgress,
      onStats: setQmdStoreStats,
    })
      .then(() => {
        currentStatus = 'ready'
        currentError = null
        currentProgress = null
        log.memory.info('QMD reindex complete')
      })
      .catch((err) => {
        currentStatus = 'error'
        currentError = err instanceof Error ? err.message : String(err)
        currentProgress = null
        log.memory.error('QMD reindex failed', { error: currentError })
      })

    // Use 'indexing' consistently (CRITICAL-3)
    res.status(202).json({ status: 'indexing' })
  } catch (err) {
    currentStatus = 'error'
    currentError = err instanceof Error ? err.message : String(err)
    currentProgress = null
    next(err)
  }
})

// Rebuild the conversation history FTS index (history.db) from
// conversations/*.json. Synchronous (no embeddings — FTS only, fast).
qmdRouter.post('/rebuild-history', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rebuildHistoryDb } = await import('../../core/history-db.js')
    const result = await rebuildHistoryDb()
    res.json({ status: 'ok', ...result })
  } catch (err) {
    next(err)
  }
})
