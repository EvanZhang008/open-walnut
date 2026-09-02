/**
 * Search index management API — status + rebuild.
 *
 * Mounted twice: `/api/search-index` (canonical) and `/api/qmd` (legacy alias
 * kept one release; `/api/v1/qmd/status` is in the frozen v1 contract and
 * forwards to buildSearchIndexStatusPayload below).
 *
 * The payload keeps the old shape — `{model, stores, status, error, progress}` —
 * because the web notification rail and the frozen v1 doc both read it. What
 * changed underneath: ONE index instead of four stores, an ONNX model instead
 * of a GGUF download (nothing to "download" on demand), and a rebuild that is
 * the only long operation left.
 */

import { Router, type NextFunction, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'

export const searchIndexRouter = Router()

type IndexStatus = 'ready' | 'indexing' | 'error'

/** Rebuild bookkeeping for THIS route (the wiring owns backfill state). */
let routeStatus: IndexStatus = 'ready'
let routeError: string | null = null

export function resetSearchIndexRouteState(): void {
  routeStatus = 'ready'
  routeError = null
}

/**
 * Status payload shared by GET /api/search-index/status, the legacy
 * /api/qmd/status alias, and the frozen /api/v1/qmd/status.
 *
 * `stores` keeps the four-key shape the UI renders, now filled from the single
 * index's per-kind counts (notes and skills are separate kinds; `memory` is
 * the memory dir). A kind with no docs reports null, exactly as an
 * uninitialised store used to.
 */
export async function buildSearchIndexStatusPayload(): Promise<Record<string, unknown>> {
  let status: IndexStatus = routeStatus
  let error: string | null = routeError
  let stores: Record<string, unknown> = { memory: null, notes: null, tasks: null, sessions: null }
  let model: Record<string, unknown> = { name: 'disabled', file: 'disabled', size: null, path: null, downloaded: null }
  try {
    const { getSearchIndexStatus } = await import('../../core/search/wiring.js')
    const s = getSearchIndexStatus()
    if (s.enabled) {
      const kindStore = (kind: string) => (s.byKind[kind]
        ? { collections: 1, totalIndexed: s.byKind[kind], totalEmbedded: null, totalChunks: null }
        : null)
      stores = {
        // The memory store used to cover memory + skills; keep both visible.
        memory: kindStore('memory'),
        notes: kindStore('note'),
        tasks: kindStore('task'),
        sessions: kindStore('session'),
        skills: kindStore('skill'),
      }
      model = {
        name: s.model ?? 'keyword-only',
        file: s.model ?? 'keyword-only',
        size: null,
        path: null,
        // ONNX weights are fetched by the embed worker on first use; there is
        // no user-triggered download step to report progress for.
        downloaded: s.model ? true : null,
      }
      if (s.backfillRunning && status === 'ready') status = 'indexing'
      if (s.error && !error) { status = 'error'; error = s.error }
    }
  } catch (err) {
    status = 'error'
    error = err instanceof Error ? err.message : String(err)
  }
  return { model, stores, status, error, progress: null }
}

// GET /status
searchIndexRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildSearchIndexStatusPayload())
  } catch (err) {
    next(err)
  }
})

// POST /reindex — full rebuild from the canonical stores (async, fire-and-forget).
searchIndexRouter.post('/reindex', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (routeStatus === 'indexing') {
      res.status(409).json({ status: 'indexing', message: 'Reindex already in progress' })
      return
    }
    const { rebuildSearchIndex, isSearchV2Enabled } = await import('../../core/search/wiring.js')
    if (!isSearchV2Enabled()) {
      res.status(409).json({ status: 'error', message: 'search indexing is disabled on this host' })
      return
    }
    routeStatus = 'indexing'
    routeError = null
    void rebuildSearchIndex()
      .then(({ inserted }) => {
        routeStatus = 'ready'
        log.memory.info('search index reindex complete', { inserted })
      })
      .catch((err) => {
        routeStatus = 'error'
        routeError = err instanceof Error ? err.message : String(err)
        log.memory.error('search index reindex failed', { error: routeError })
      })
    res.status(202).json({ status: 'indexing' })
  } catch (err) {
    routeStatus = 'error'
    routeError = err instanceof Error ? err.message : String(err)
    next(err)
  }
})

// POST /download — kept as a no-op for the legacy Settings button: the ONNX
// model is fetched by the embed worker on first use, so there is nothing to
// trigger. Answers 200 with the current status instead of 404.
searchIndexRouter.post('/download', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ status: routeStatus, message: 'model weights are fetched automatically on first use' })
  } catch (err) {
    next(err)
  }
})

// POST /rebuild-history — the conversation history FTS index (history.db), not
// the search index. Lives here because this is where the UI's maintenance
// buttons already point. Synchronous (FTS only, no embeddings).
searchIndexRouter.post('/rebuild-history', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rebuildHistoryDb } = await import('../../core/history-db.js')
    const result = await rebuildHistoryDb()
    res.json({ status: 'ok', ...result })
  } catch (err) {
    next(err)
  }
})
