/**
 * Search route — full-text + semantic search across tasks and memory.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { search } from '../../core/search.js'
import type { SearchMode } from '../../core/embedding/types.js'

export const searchRouter = Router()

// GET /api/search?q=...&types=task,memory&limit=20&mode=hybrid
searchRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string) ?? ''
    const typesParam = req.query.types as string | undefined
    const types = typesParam
      ? (typesParam.split(',') as ('task' | 'memory')[])
      : undefined
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
    const mode = (req.query.mode as SearchMode | undefined) ?? undefined

    const results = await search(q, { types, limit, mode })
    res.json({ results })
  } catch (err) {
    next(err)
  }
})
