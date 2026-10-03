/**
 * /api/mcp: the MCP servers plugins registered (src/core/mcp-servers/), for Settings, the
 * `walnut mcp <server> tools …` CLI and the mcp_* ops.
 *
 *   GET  /api/mcp/servers                     every server and its state (never starts one)
 *   GET  /api/mcp/servers/:name/tools         its tools (starts it when needed)
 *   POST /api/mcp/servers/:name/read          call a tool the server marks readOnlyHint
 *   POST /api/mcp/servers/:name/call          call any tool: servers registered `sessions: 'all'`,
 *                                             from this Mac only
 *   POST /api/mcp/servers/:name/restart       stop the process and start it again
 *
 * Who may call what is decided here, not by the caller: `read-only` (the default) exposes only
 * tools the server itself marks read-only, so a plugin that gates its writes behind an approval
 * (posting to a chat) keeps that gate. Every call carries the server's deadline; nothing here can
 * pin a connection longer than the call it makes.
 */

import { Router, type Request, type Response } from 'express'
import { isLocalOrigin } from '../../lib/caller-origin.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { getMcpConnection, listMcpServers } from '../../core/mcp-servers/registry.js'
import { McpCallError, type McpCallResult } from '../../core/mcp-servers/types.js'

/** Upper bound on a caller-chosen deadline (a tool that runs a long search, a first start). */
const MAX_CALL_TIMEOUT_MS = 5 * 60_000
/** A restart answers within this, finished or not. */
const RESTART_ANSWER_MS = 15_000

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } })
}

function connectionFor(req: Request, res: Response) {
  const name = String(req.params.name ?? '')
  const connection = getMcpConnection(name)
  if (!connection) {
    fail(res, 404, 'mcp_server_not_found', `No MCP server named "${name}" is registered. Registered: ${
      listMcpServers().map((one) => one.name).join(', ') || 'none'}.`)
    return null
  }
  return connection
}

function sendFailure(res: Response, error: unknown): void {
  if (error instanceof McpCallError) {
    const status = error.failure === 'timeout' ? 504 : error.failure === 'refused' ? 422 : 503
    fail(res, status, `mcp_${error.failure}`, error.message, { stage: error.stage })
    return
  }
  fail(res, 500, 'mcp_error', error instanceof Error ? error.message : String(error))
}

function callInput(req: Request, res: Response): { tool: string; args: Record<string, unknown>; timeoutMs?: number } | null {
  const body = (req.body ?? {}) as { tool?: unknown; arguments?: unknown; timeout_ms?: unknown }
  if (typeof body.tool !== 'string' || !body.tool) {
    fail(res, 400, 'invalid_request', 'Name the tool to call: { "tool": "<name>", "arguments": { … } }.')
    return null
  }
  const args = body.arguments ?? {}
  if (typeof args !== 'object' || Array.isArray(args) || args === null) {
    fail(res, 400, 'invalid_request', '"arguments" is a JSON object.')
    return null
  }
  const timeoutMs = typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms) && body.timeout_ms > 0
    ? Math.min(Math.floor(body.timeout_ms), MAX_CALL_TIMEOUT_MS)
    : undefined
  return { tool: body.tool, args: args as Record<string, unknown>, ...(timeoutMs ? { timeoutMs } : {}) }
}

/** The answer as data: the parsed JSON text when the server sent one, so a caller need not unwrap it. */
function shapeResult(result: McpCallResult): Record<string, unknown> {
  const texts = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => String(part.text))
  let data: unknown
  if (result.structuredContent !== undefined) data = result.structuredContent
  else if (texts.length === 1) {
    try { data = JSON.parse(texts[0]!) } catch { data = undefined }
  }
  return {
    isError: result.isError === true,
    ...(data !== undefined ? { data } : { text: texts.join('\n') }),
    ...(result.content.some((part) => part.type !== 'text') ? { content: result.content } : {}),
  }
}

export function createMcpServersRouter(): Router {
  const router = Router()

  router.get('/servers', (_req, res) => {
    res.json({ servers: listMcpServers() })
  })

  router.get('/servers/:name/tools', async (req, res) => {
    const connection = connectionFor(req, res)
    if (!connection) return
    try {
      const tools = await connection.listTools({ refresh: req.query.refresh === '1' })
      res.json({ server: connection.status(), tools })
    } catch (error) {
      sendFailure(res, error)
    }
  })

  router.post('/servers/:name/read', async (req, res) => {
    const connection = connectionFor(req, res)
    if (!connection) return
    const input = callInput(req, res)
    if (!input) return
    const { sessions, name } = connection.status()
    if (sessions === 'none') {
      fail(res, 403, 'mcp_not_exposed', `The MCP server "${name}" is for its plugin only.`)
      return
    }
    try {
      const tool = (await connection.listTools()).find((one) => one.name === input.tool)
      if (!tool) {
        fail(res, 404, 'mcp_tool_not_found', `"${name}" has no tool named ${input.tool}.`)
        return
      }
      if (!tool.readOnly) {
        fail(res, 403, 'mcp_tool_not_read_only', sessions === 'all'
          ? `${input.tool} is not a read-only tool: call it with mcp_call (this Mac only).`
          : `${input.tool} changes something, and "${name}" lets outside callers use its read-only tools only.`)
        return
      }
      res.json(shapeResult(await connection.call(input.tool, input.args, input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})))
    } catch (error) {
      sendFailure(res, error)
    }
  })

  router.post('/servers/:name/call', async (req, res) => {
    const connection = connectionFor(req, res)
    if (!connection) return
    const input = callInput(req, res)
    if (!input) return
    const { sessions, name } = connection.status()
    if (sessions !== 'all') {
      fail(res, 403, 'mcp_not_exposed', sessions === 'none'
        ? `The MCP server "${name}" is for its plugin only.`
        : `"${name}" lets outside callers use its read-only tools only (mcp_read).`)
      return
    }
    if (!isLocalOrigin(requestOrigin(req))) {
      fail(res, 403, 'mcp_local_only', `Calling a tool that may change something on "${name}" works from this Mac only.`)
      return
    }
    try {
      res.json(shapeResult(await connection.call(input.tool, input.args, input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})))
    } catch (error) {
      sendFailure(res, error)
    }
  })

  router.post('/servers/:name/restart', async (req, res) => {
    const connection = connectionFor(req, res)
    if (!connection) return
    if (!isLocalOrigin(requestOrigin(req))) {
      fail(res, 403, 'mcp_local_only', 'Restarting an MCP server works from this Mac only.')
      return
    }
    // A start may take its whole startup budget; the window hears the outcome on mcp:status-changed.
    const settled = await Promise.race([
      connection.restart().then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), RESTART_ANSWER_MS).unref?.() }),
    ])
    res.status(settled ? 200 : 202).json({ server: connection.status() })
  })

  return router
}
