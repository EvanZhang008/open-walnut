/**
 * System health API — exposes embedding status and allows manual reindex.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { broadcastEvent } from '../ws/handler.js'
import { log } from '../../logging/index.js'

export const systemRouter = Router()

// GET /api/system/health — current health snapshot
systemRouter.get('/health', (_req, res) => {
  const health = getSystemHealth()
  // Also include git-sync status inline (frontend can use either endpoint)
  res.json(health)
})

// POST /api/system/health/reindex — trigger re-reconciliation
systemRouter.post('/health/reindex', async (_req, res) => {
  try {
    // Run reconciliation in background, respond immediately
    res.json({ status: 'started' })

    const { reconcileAllEmbeddings } = await import('../../core/embedding/pipeline.js')
    const result = await reconcileAllEmbeddings()

    // Update the shared health state (imported by reference)
    const health = getSystemHealth()
    health.embedding = {
      total: result.totalTasks,
      indexed: result.indexedTasks,
      unindexed: result.totalTasks - result.indexedTasks,
      ollamaAvailable: result.ollamaAvailable,
      lastReconcileAt: new Date().toISOString(),
    }

    broadcastEvent('system:health', health)
    log.memory.info('manual reindex complete', {
      total: result.totalTasks,
      indexed: result.indexedTasks,
      ollamaAvailable: result.ollamaAvailable,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.memory.error('manual reindex failed', { error: errMsg })

    const health = getSystemHealth()
    health.embedding.ollamaAvailable = false
    health.embedding.lastError = errMsg
    broadcastEvent('system:health', health)
  }
})
