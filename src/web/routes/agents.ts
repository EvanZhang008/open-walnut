/**
 * Agents routes — CRUD for agent definitions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  getAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
} from '../../core/agent-registry.js'
import { getToolSchemas } from '../../agent/tools.js'
import { getConfig } from '../../core/config-manager.js'
import { listAvailableSkills } from '../../core/skill-loader.js'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export function createAgentsRouter(): Router {
  const router = Router()

  // GET /api/agents/meta/tools — list available tool names
  // MUST be registered before /:id to avoid "meta" being treated as an ID
  router.get('/meta/tools', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const schemas = getToolSchemas()
      const tools = schemas.map((t) => t.name)
      res.json({ tools })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/agents/meta/skills — list available skills
  router.get('/meta/skills', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const all = await listAvailableSkills()
      const skills = all.map((s) => ({ dirName: s.dirName, name: s.name, description: s.description }))
      res.json({ skills })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/agents/meta/models — list available model IDs
  router.get('/meta/models', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await getConfig()
      const models = config.agent?.available_models ?? []
      res.json({ models })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/agents — list all agents (merged from all sources)
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const agents = await getAllAgents()
      res.json({ agents })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/agents/:id — single agent
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const agent = await getAgent(id)
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${id}` })
        return
      }
      res.json({ agent })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/agents — create config agent
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, name, ...rest } = req.body
      if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'id is required (slug format)' })
        return
      }
      if (!SLUG_PATTERN.test(id)) {
        res.status(400).json({ error: 'id must be a lowercase slug (letters, numbers, hyphens, underscores)' })
        return
      }
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' })
        return
      }
      const agent = await createAgent({ id, name, runner: 'embedded', ...rest })
      res.status(201).json({ agent })
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        res.status(409).json({ error: err.message })
        return
      }
      if (err instanceof Error && err.message.includes('not in the available models')) {
        res.status(400).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // PATCH /api/agents/:id — update config agent
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      const { id: _id, source: _source, ...updates } = req.body
      const agent = await updateAgent(id, updates)
      res.json({ agent })
    } catch (err) {
      if (err instanceof Error && (err.message.includes('not found') || err.message.includes('not in the available models'))) {
        const status = err.message.includes('not found') ? 404 : 400
        res.status(status).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // DELETE /api/agents/:id — delete config agent
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string
      await deleteAgent(id)
      res.status(204).end()
    } catch (err) {
      if (err instanceof Error && (err.message.includes('cannot be deleted') || err.message.includes('not found'))) {
        const status = err.message.includes('not found') ? 404 : 400
        res.status(status).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // POST /api/agents/:id/clone — clone any agent as a new config agent
  router.post('/:id/clone', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sourceId = req.params.id as string
      const source = await getAgent(sourceId)
      if (!source) {
        res.status(404).json({ error: `Agent not found: ${sourceId}` })
        return
      }
      const newId = req.body.id
      if (!newId || typeof newId !== 'string') {
        res.status(400).json({ error: 'id is required for the cloned agent' })
        return
      }
      if (!SLUG_PATTERN.test(newId)) {
        res.status(400).json({ error: 'id must be a lowercase slug' })
        return
      }
      const { source: _source, id: _oldId, ...rest } = source
      const agent = await createAgent({ ...rest, id: newId, name: req.body.name || `${rest.name} (Copy)` })
      res.status(201).json({ agent })
    } catch (err) {
      if (err instanceof Error && err.message.includes('already exists')) {
        res.status(409).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  return router
}
