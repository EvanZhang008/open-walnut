/**
 * /api/v1 library (additive, Wave 3) — agent definitions, command templates,
 * skill write CRUD + references, and repository YAML profiles. Semantics are
 * identical to the internal routes (agents.ts / commands.ts / skills.ts /
 * repositories.ts) because both call the SAME core/store functions.
 *
 *   GET    /agents/meta/tools|skills|models      → editor dropdown catalogs
 *   GET    /agents/:id                           → { agent }
 *   POST   /agents                               → 201 { agent }
 *   PATCH  /agents/:id                           → { agent }
 *   DELETE /agents/:id                           → 204
 *   POST   /agents/:id/clone                     → 201 { agent }
 *   GET    /commands                             → { commands }
 *   GET    /commands/:name                       → { command }
 *   POST   /commands                             → 201 { command }
 *   PUT    /commands/:name                       → { command }
 *   DELETE /commands/:name                       → 204
 *   POST   /skills                               → 201 { skill }
 *   PUT    /skills/:dirName                      → { skill }
 *   PATCH  /skills/:dirName { enabled }          → { skill }
 *   DELETE /skills/:dirName                      → 204
 *   GET    /skills/:dirName/references           → { files }
 *   GET    /skills/:dirName/references/:file     → { content }
 *   GET    /repositories                         → { repositories }
 *   GET    /repositories/:name                   → { slug, content, modified }
 *   POST   /repositories/:name { content }       → { ok, status }
 *   DELETE /repositories/:name                   → { ok }
 *
 * Scope rule for skills (deliberate): v1 only WRITES the Walnut-managed skills
 * dir (~/.open-walnut/skills — git-synced). The Claude CLI's own global store
 * (~/.claude/skills) stays READ-ONLY through v1: create forces target
 * 'walnut', and update/delete refuse 'claude'-sourced skills with 403. The
 * enable/disable toggle is allowed for every source because it only writes
 * Walnut's own skill-settings.json, never the CLI's directory.
 *
 * Cloud companion (REPLICA):
 * - Agents are stored in config.yaml, which is MACHINE-LOCAL (never
 *   git-synced) — reads answer with the replica's own agents (the replica
 *   runs its own butler), but writes answer 501 not_supported_cloud: a
 *   replica-local agent would silently diverge from the primary console.
 * - Commands, skills, and repositories live in git-synced dirs — Class A,
 *   full read/write on both boxes.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const libraryV1Router = Router()

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** Agent writes land in machine-local config.yaml — refuse loudly on a REPLICA. */
function agentWriteRefused(res: Response): boolean {
  if (!CLOUD_MODE) return false
  sendError(res, 501, 'not_supported_cloud', 'Agent definitions live in the primary box\'s machine-local config (no replica write-back channel)')
  return true
}

// ── Agents ───────────────────────────────────────────────────────────────────

// GET /api/v1/agents/meta/tools — tool-name catalog for the agent editor.
// MUST be registered before /:id-shaped agent routes ("meta" is not an id).
libraryV1Router.get('/agents/meta/tools', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getToolSchemas } = await import('../../agent/tools.js')
    res.json({ tools: getToolSchemas().map((t) => t.name) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/agents/meta/skills — skill catalog for the agent editor.
libraryV1Router.get('/agents/meta/skills', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listAvailableSkills } = await import('../../core/skill-loader.js')
    const all = await listAvailableSkills()
    res.json({ skills: all.map((s) => ({ dirName: s.dirName, name: s.name, description: s.description })) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/agents/meta/models — model-id catalog for the agent editor.
libraryV1Router.get('/agents/meta/models', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    res.json({ models: config.agent?.available_models ?? [] })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/agents/:id — one agent definition (full editor payload; the
// frozen GET /v1/agents list stays the slim chat-picker projection).
libraryV1Router.get('/agents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    const { getAgent } = await import('../../core/agent-registry.js')
    const agent = await getAgent(id)
    if (!agent) {
      sendError(res, 404, 'not_found', `Agent not found: ${id}`)
      return
    }
    res.json({ agent })
  } catch (err) {
    next(err)
  }
})

/** Map agent-registry message-based errors onto the frozen v1 shape. True = handled. */
function sendAgentError(res: Response, err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('already exists')) {
    sendError(res, 409, 'conflict', err.message)
    return true
  }
  if (err.message.includes('not found')) {
    sendError(res, 404, 'not_found', err.message)
    return true
  }
  if (err.message.includes('not in the available models') || err.message.includes('cannot be deleted')) {
    sendError(res, 400, 'bad_request', err.message)
    return true
  }
  return false
}

// POST /api/v1/agents — create a config-defined agent.
libraryV1Router.post('/agents', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (agentWriteRefused(res)) return
    const { id, name, ...rest } = (req.body ?? {}) as Record<string, unknown>
    if (!id || typeof id !== 'string' || !SLUG_PATTERN.test(id)) {
      sendError(res, 400, 'bad_request', 'id is required and must be a lowercase slug (letters, numbers, hyphens, underscores)')
      return
    }
    if (!name || typeof name !== 'string') {
      sendError(res, 400, 'bad_request', 'name is required')
      return
    }
    const { createAgent } = await import('../../core/agent-registry.js')
    try {
      const agent = await createAgent({ id, name, runner: 'embedded', ...rest })
      res.status(201).json({ agent })
    } catch (err) {
      if (sendAgentError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/agents/:id — update a config-defined agent.
libraryV1Router.patch('/agents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (agentWriteRefused(res)) return
    const id = String(req.params.id ?? '')
    const { id: _id, source: _source, ...updates } = (req.body ?? {}) as Record<string, unknown>
    const { updateAgent } = await import('../../core/agent-registry.js')
    try {
      res.json({ agent: await updateAgent(id, updates) })
    } catch (err) {
      if (sendAgentError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/agents/:id — delete a config-defined agent (builtins refuse).
libraryV1Router.delete('/agents/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (agentWriteRefused(res)) return
    const id = String(req.params.id ?? '')
    const { deleteAgent } = await import('../../core/agent-registry.js')
    try {
      await deleteAgent(id)
      res.status(204).end()
    } catch (err) {
      if (sendAgentError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/agents/:id/clone { id, name? } — clone ANY agent (incl. a
// builtin) as a new config-defined agent.
libraryV1Router.post('/agents/:id/clone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (agentWriteRefused(res)) return
    const sourceId = String(req.params.id ?? '')
    const { getAgent, createAgent } = await import('../../core/agent-registry.js')
    const source = await getAgent(sourceId)
    if (!source) {
      sendError(res, 404, 'not_found', `Agent not found: ${sourceId}`)
      return
    }
    const newId = (req.body ?? {}).id
    if (!newId || typeof newId !== 'string' || !SLUG_PATTERN.test(newId)) {
      sendError(res, 400, 'bad_request', 'id is required for the cloned agent and must be a lowercase slug')
      return
    }
    const { source: _source, id: _oldId, ...rest } = source
    try {
      const agent = await createAgent({ ...rest, id: newId, name: (req.body ?? {}).name || `${rest.name} (Copy)` })
      res.status(201).json({ agent })
    } catch (err) {
      if (sendAgentError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ── Commands (markdown slash-command templates; git-synced dir) ─────────────

/** Map command-store message-based errors onto the frozen v1 shape. True = handled. */
function sendCommandError(res: Response, err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('already exists')) {
    sendError(res, 409, 'conflict', err.message)
    return true
  }
  if (err.message.includes('not found')) {
    sendError(res, 404, 'not_found', err.message)
    return true
  }
  if (err.message.includes('Cannot modify') || err.message.includes('Cannot delete')) {
    sendError(res, 403, 'forbidden', err.message)
    return true
  }
  if (err.message.includes('Invalid') || err.message.includes('reserved')) {
    sendError(res, 400, 'bad_request', err.message)
    return true
  }
  return false
}

// GET /api/v1/commands — user + builtin command templates.
libraryV1Router.get('/commands', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listCommands } = await import('../../core/command-store.js')
    res.json({ commands: await listCommands() })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/commands/:name — one command with its full content.
libraryV1Router.get('/commands/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getCommand } = await import('../../core/command-store.js')
    try {
      const command = await getCommand(String(req.params.name ?? ''))
      if (!command) {
        sendError(res, 404, 'not_found', `Command not found: ${req.params.name}`)
        return
      }
      res.json({ command })
    } catch (err) {
      if (sendCommandError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/commands { name, content, description? } — create a user command.
libraryV1Router.post('/commands', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, content, description } = (req.body ?? {}) as Record<string, unknown>
    if (!name || typeof name !== 'string') {
      sendError(res, 400, 'bad_request', 'name is required')
      return
    }
    if (!content || typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content is required')
      return
    }
    const { createCommand } = await import('../../core/command-store.js')
    try {
      res.status(201).json({ command: await createCommand(name, content, description as string | undefined) })
    } catch (err) {
      if (sendCommandError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/commands/:name { content?, description? } — update a user
// command (builtins refuse with 403).
libraryV1Router.put('/commands/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, description } = (req.body ?? {}) as Record<string, unknown>
    if (content !== undefined && typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content must be a string')
      return
    }
    if (description !== undefined && typeof description !== 'string') {
      sendError(res, 400, 'bad_request', 'description must be a string')
      return
    }
    const { updateCommand } = await import('../../core/command-store.js')
    try {
      res.json({ command: await updateCommand(String(req.params.name ?? ''), { content: content as string | undefined, description: description as string | undefined }) })
    } catch (err) {
      if (sendCommandError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/commands/:name — delete a user command (builtins refuse).
libraryV1Router.delete('/commands/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deleteCommand } = await import('../../core/command-store.js')
    try {
      await deleteCommand(String(req.params.name ?? ''))
      res.status(204).end()
    } catch (err) {
      if (sendCommandError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ── Skills: write CRUD + references (read list/detail shipped in Wave 2) ────

/** Map skill-store message-based errors onto the frozen v1 shape. True = handled. */
function sendSkillError(res: Response, err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('already exists')) {
    sendError(res, 409, 'conflict', err.message)
    return true
  }
  if (err.message.includes('not found')) {
    sendError(res, 404, 'not_found', err.message)
    return true
  }
  if (err.message.includes('Cannot modify') || err.message.includes('Cannot delete')) {
    sendError(res, 403, 'forbidden', err.message)
    return true
  }
  if (err.message.includes('Invalid')) {
    sendError(res, 400, 'bad_request', err.message)
    return true
  }
  return false
}

/**
 * v1 scope guard: the Claude CLI's global skills dir is read-only through v1.
 * Resolves the skill and refuses 'claude'-sourced ones with 403 (the shared
 * store only refuses 'workspace'). Returns false after replying; true = OK.
 */
async function requireWalnutManaged(res: Response, dirName: string): Promise<boolean> {
  const { getSkill } = await import('../../core/skill-store.js')
  const skill = await getSkill(dirName)
  if (!skill) {
    sendError(res, 404, 'not_found', `Skill not found: ${dirName}`)
    return false
  }
  if (skill.source === 'claude') {
    sendError(res, 403, 'forbidden', 'This skill lives in the Claude CLI\'s global store — read-only through the mobile API. Edit it with the CLI or the desktop console.')
    return false
  }
  return true
}

// POST /api/v1/skills { dirName, content, category? } — create a skill in the
// WALNUT-managed dir (git-synced). No `target` param on purpose: v1 never
// writes ~/.claude/skills.
libraryV1Router.post('/skills', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dirName, content, category } = (req.body ?? {}) as Record<string, unknown>
    if (!dirName || typeof dirName !== 'string') {
      sendError(res, 400, 'bad_request', 'dirName is required')
      return
    }
    if (!content || typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content is required')
      return
    }
    if (category !== undefined && typeof category !== 'string') {
      sendError(res, 400, 'bad_request', 'category must be a string')
      return
    }
    const { createSkill } = await import('../../core/skill-store.js')
    try {
      res.status(201).json({ skill: await createSkill(dirName, content, 'walnut', category as string | undefined) })
    } catch (err) {
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/skills/:dirName { content } — rewrite SKILL.md (walnut-managed only).
libraryV1Router.put('/skills/:dirName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dirName = String(req.params.dirName ?? '')
    const { content } = (req.body ?? {}) as Record<string, unknown>
    if (typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content must be a string')
      return
    }
    if (!(await requireWalnutManaged(res, dirName))) return
    const { updateSkill } = await import('../../core/skill-store.js')
    try {
      res.json({ skill: await updateSkill(dirName, content) })
    } catch (err) {
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/skills/:dirName { enabled } — enable/disable. Allowed for ANY
// source (it only writes Walnut's own skill-settings.json, never the skill dir).
libraryV1Router.patch('/skills/:dirName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { enabled } = (req.body ?? {}) as Record<string, unknown>
    if (typeof enabled !== 'boolean') {
      sendError(res, 400, 'bad_request', 'enabled must be a boolean')
      return
    }
    const { setSkillEnabled } = await import('../../core/skill-store.js')
    try {
      res.json({ skill: await setSkillEnabled(String(req.params.dirName ?? ''), enabled) })
    } catch (err) {
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/skills/:dirName — delete a skill dir (walnut-managed only).
libraryV1Router.delete('/skills/:dirName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dirName = String(req.params.dirName ?? '')
    if (!(await requireWalnutManaged(res, dirName))) return
    const { deleteSkill } = await import('../../core/skill-store.js')
    try {
      await deleteSkill(dirName)
      res.status(204).end()
    } catch (err) {
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/skills/:dirName/references — reference files of a skill (read-only).
libraryV1Router.get('/skills/:dirName/references', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { listReferences } = await import('../../core/skill-store.js')
    try {
      res.json({ files: await listReferences(String(req.params.dirName ?? '')) })
    } catch (err) {
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/skills/:dirName/references/:file — one reference file's content.
libraryV1Router.get('/skills/:dirName/references/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getReference } = await import('../../core/skill-store.js')
    try {
      res.json({ content: await getReference(String(req.params.dirName ?? ''), String(req.params.file ?? '')) })
    } catch (err) {
      if (err instanceof Error && err.message === 'Invalid filename') {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      if (sendSkillError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ── Repositories (YAML profiles; git-synced dir) ─────────────────────────────

/** Run a repository op, mapping RepositoryOpError to the frozen v1 shape. */
async function runRepoOp(res: Response, next: NextFunction, fn: () => Promise<unknown>): Promise<void> {
  const { RepositoryOpError } = await import('./repositories.js')
  try {
    res.json(await fn())
  } catch (err) {
    if (err instanceof RepositoryOpError) {
      sendError(res, err.statusCode, err.statusCode === 413 ? 'too_large' : err.statusCode === 404 ? 'not_found' : 'bad_request', err.message)
      return
    }
    next(err)
  }
}

// GET /api/v1/repositories — all repo profiles (parsed headers).
libraryV1Router.get('/repositories', async (_req: Request, res: Response, next: NextFunction) => {
  const { listRepositories } = await import('./repositories.js')
  await runRepoOp(res, next, () => listRepositories())
})

// GET /api/v1/repositories/:name — one profile's full YAML.
libraryV1Router.get('/repositories/:name', async (req: Request, res: Response, next: NextFunction) => {
  const { readRepository } = await import('./repositories.js')
  await runRepoOp(res, next, () => readRepository(req.params.name))
})

// POST /api/v1/repositories/:name { content } — create or update (idempotent).
libraryV1Router.post('/repositories/:name', async (req: Request, res: Response, next: NextFunction) => {
  const { writeRepository } = await import('./repositories.js')
  await runRepoOp(res, next, () => writeRepository(req.params.name, req.body?.content))
})

// DELETE /api/v1/repositories/:name — delete a profile.
libraryV1Router.delete('/repositories/:name', async (req: Request, res: Response, next: NextFunction) => {
  const { deleteRepository } = await import('./repositories.js')
  await runRepoOp(res, next, () => deleteRepository(req.params.name))
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
libraryV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 library route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
