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
import { getMemoryStore, getNotesStore, getTaskStore, getSessionStore, initQmdStores, DEFAULT_QMD_MODEL } from '../../core/qmd-store.js'

export const qmdRouter = Router()

// ── Shared state for async operations ──

type QmdStatus = 'ready' | 'indexing' | 'downloading' | 'error'

let currentStatus: QmdStatus = 'ready'
let currentError: string | null = null

// Embedding progress — updated via onProgress callback during embed()
interface EmbedProgressInfo {
  chunksEmbedded: number
  totalChunks: number
  bytesProcessed: number
  totalBytes: number
  store: string // 'memory' | 'notes'
}
let currentProgress: EmbedProgressInfo | null = null

/**
 * Reset module-level state. Called on server startup and useful for tests
 * where the module may persist across restarts.
 */
export function resetQmdRouteState(): void {
  currentStatus = 'ready'
  currentError = null
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
 * Parse QMD_EMBED_MODEL env var to determine expected GGUF filename and path.
 * Format: "hf:org/repo/filename.gguf" → file "hf_org_repo_filename.gguf"
 *
 * For non-hf: URIs, returns the raw URI as the file field with downloaded: null.
 */
function getModelInfo(): {
  name: string
  file: string
  size: string | null
  path: string | null
  downloaded: boolean | null
} {
  const envModel = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL

  // Non-hf: URIs — we don't know the local path or download status
  if (!envModel.startsWith('hf:')) {
    return {
      name: envModel,
      file: envModel,
      size: null,
      path: null,
      downloaded: null,
    }
  }

  // Parse hf:org/repo/filename.gguf → hf_org_filename.gguf
  // QMD/node-llama-cpp naming convention: hf_{org}_{filename} (repo name is skipped)
  const parts3 = envModel.slice(3).split('/')
  const file = parts3.length >= 3
    ? `hf_${parts3[0]}_${parts3[parts3.length - 1]}`
    : 'hf_' + envModel.slice(3).replace(/\//g, '_')

  // Parse model name from URI: hf:org/repo/filename.gguf → "repo (org/repo)"
  const parts = envModel.slice(3).split('/')
  const name = parts.length >= 2 ? `${parts[1]} (${parts[0]}/${parts[1]})` : envModel

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

/**
 * Build collection stats from a QMD store — indexed docs, embedded docs, chunks.
 *
 * - indexed: files scanned into the DB (from store.listCollections)
 * - embedded: docs that have vector embeddings (from content_vectors)
 * - chunks: total embedding chunks (each doc is split into multiple chunks)
 */
async function getStoreStats(storeFn: () => Promise<import('@tobilu/qmd').QMDStore>): Promise<{
  collections: Record<string, { indexed: number; embedded: number; chunks: number }>
  totalIndexed: number
  totalEmbedded: number
  totalChunks: number
} | null> {
  try {
    const store = await storeFn()
    const collections = await store.listCollections()

    // Query embedding stats per collection from SQLite (source of truth)
    // Note: multiple docs can share the same content hash — count docs, not distinct hashes
    const embeddingStats = new Map<string, { embedded: number; chunks: number }>()
    try {
      const rows = store.internal.db.prepare(`
        SELECT d.collection,
          SUM(CASE WHEN d.hash IN (SELECT hash FROM content_vectors) THEN 1 ELSE 0 END) as embedded,
          (SELECT COUNT(*) FROM content_vectors cv2
           WHERE cv2.hash IN (SELECT hash FROM documents WHERE collection=d.collection AND active=1)
          ) as chunks
        FROM documents d
        WHERE d.active=1
        GROUP BY d.collection
      `).all() as Array<{ collection: string; embedded: number; chunks: number }>
      for (const row of rows) {
        embeddingStats.set(row.collection, { embedded: row.embedded, chunks: row.chunks })
      }
    } catch {
      // content_vectors may not exist yet — leave counts at 0
    }

    const collMap: Record<string, { indexed: number; embedded: number; chunks: number }> = {}
    let totalIndexed = 0
    let totalEmbedded = 0
    let totalChunks = 0
    for (const col of collections) {
      const emb = embeddingStats.get(col.name) ?? { embedded: 0, chunks: 0 }
      collMap[col.name] = { indexed: col.doc_count, embedded: emb.embedded, chunks: emb.chunks }
      totalIndexed += col.doc_count
      totalEmbedded += emb.embedded
      totalChunks += emb.chunks
    }
    return { collections: collMap, totalIndexed, totalEmbedded, totalChunks }
  } catch (err) {
    log.memory.warn('getStoreStats failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// GET /api/qmd/status
qmdRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const model = getModelInfo()

    const [memoryStats, notesStats, tasksStats, sessionsStats] = await Promise.all([
      getStoreStats(getMemoryStore),
      getStoreStats(getNotesStore),
      getStoreStats(getTaskStore).catch(() => null),
      getStoreStats(getSessionStore).catch(() => null),
    ])

    res.json({
      model,
      stores: {
        memory: memoryStats,
        notes: notesStats,
        tasks: tasksStats,
        sessions: sessionsStats,
      },
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

    // Fire-and-forget: initQmdStores triggers download via embed(), then indexes.
    // State transitions: downloading → indexing → ready (or error at any point).
    initQmdStores()
      .then(() => {
        currentStatus = 'ready'
        currentError = null
        log.memory.info('QMD model download + init complete')
      })
      .catch((err) => {
        currentStatus = 'error'
        currentError = err instanceof Error ? err.message : String(err)
        log.memory.error('QMD model download failed', { error: currentError })
      })

    // Transition to 'indexing' once the model file appears on disk.
    // initQmdStores calls createStore (downloads model) then update+embed (indexing).
    // We poll briefly to detect when the download phase is done.
    const model = getModelInfo()
    if (model.path) {
      const pollForModel = setInterval(() => {
        if (currentStatus !== 'downloading') {
          clearInterval(pollForModel)
          return
        }
        try {
          if (fs.existsSync(model.path!)) {
            currentStatus = 'indexing'
            log.memory.info('QMD model downloaded, transitioning to indexing')
            clearInterval(pollForModel)
          }
        } catch {
          // Ignore — keep polling
        }
      }, 2000)
      // Safety: stop polling after 30 minutes even if model never appears
      setTimeout(() => clearInterval(pollForModel), 30 * 60 * 1000)
    }

    res.status(202).json({ status: 'downloading' })
  } catch (err) {
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

    // Fire-and-forget: update + embed on both stores sequentially (MEDIUM-4).
    // Sequential avoids concurrent embed() calls which can cause memory pressure
    // from loading two model instances simultaneously.
    const embedModel = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL
    ;(async () => {
      const mem = await getMemoryStore()
      await mem.update()
      await mem.embed({ force: true, model: embedModel, onProgress: (p) => {
        currentProgress = { ...p, store: 'memory' }
      }})
      const notes = await getNotesStore()
      await notes.update()
      await notes.embed({ force: true, model: embedModel, onProgress: (p) => {
        currentProgress = { ...p, store: 'notes' }
      }})
    })()
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
