/**
 * Commands routes — CRUD for markdown-based slash commands.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  listCommands,
  getCommand,
  createCommand,
  updateCommand,
  deleteCommand,
} from '../../core/command-store.js'

export function createCommandsRouter(): Router {
  const router = Router()

  // GET /api/commands — list all commands
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const commands = await listCommands()
      res.json({ commands })
    } catch (err) {
      next(err)
    }
  })

  // GET /api/commands/:name — get single command
  router.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cmd = await getCommand(req.params.name as string)
      if (!cmd) {
        res.status(404).json({ error: `Command not found: ${req.params.name}` })
        return
      }
      res.json({ command: cmd })
    } catch (err) {
      if (err instanceof Error && err.message.includes('Invalid')) {
        res.status(400).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // POST /api/commands — create user command
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, content, description } = req.body
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' })
        return
      }
      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' })
        return
      }
      const cmd = await createCommand(name, content, description)
      res.status(201).json({ command: cmd })
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('already exists')) {
          res.status(409).json({ error: err.message })
          return
        }
        if (err.message.includes('Invalid') || err.message.includes('reserved')) {
          res.status(400).json({ error: err.message })
          return
        }
      }
      next(err)
    }
  })

  // PUT /api/commands/:name — update user command
  router.put('/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = req.params.name as string
      const { content, description } = req.body
      if (content !== undefined && typeof content !== 'string') {
        res.status(400).json({ error: 'content must be a string' })
        return
      }
      if (description !== undefined && typeof description !== 'string') {
        res.status(400).json({ error: 'description must be a string' })
        return
      }
      const cmd = await updateCommand(name, { content, description })
      res.json({ command: cmd })
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message })
          return
        }
        if (err.message.includes('Cannot modify')) {
          res.status(403).json({ error: err.message })
          return
        }
      }
      next(err)
    }
  })

  // DELETE /api/commands/:name — delete user command
  router.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteCommand(req.params.name as string)
      res.status(204).end()
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message })
          return
        }
        if (err.message.includes('Cannot delete')) {
          res.status(403).json({ error: err.message })
          return
        }
      }
      next(err)
    }
  })

  return router
}
