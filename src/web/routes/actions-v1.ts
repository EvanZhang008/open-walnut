/**
 * POST /api/v1/actions/invoke — run ONE registry op because the human clicked it.
 *
 * This is the backend for `<suggest>` action cards (web/src/utils/suggest-parse.ts):
 * the Personal AI writes a card into its answer, the user clicks a button, and
 * that click is the authorization to run the op. Nothing here is a new
 * capability — every op is the same declaration the CLI, MCP, and the gateway
 * already expose, executed through the same executor, so validation, provenance,
 * and event-bus emits are identical no matter which surface fired it.
 *
 *   POST /api/v1/actions/invoke { tool, args?, confirmed? }
 *     200 { ok: true,  tool, result }          op ran
 *     200 { ok: false, tool, error }           op ran and the API refused it
 *     400 unknown_tool | bad_request | invalid_arguments | confirmation_required
 *     501 not_supported_cloud                  replica (see below)
 *
 * Deliberate refusals:
 *  - the `api` passthrough op is NOT invocable from a card. It can POST to any
 *    /api/ path, so a card carrying it would be a generic HTTP client with a
 *    one-click trigger; named ops carry product semantics, that one carries none.
 *  - anything destructive (registry `tags.destructive`, plus a named floor so a
 *    future op that forgets the tag is still covered) needs `confirmed: true`,
 *    which the card only sends after its inline confirmation step. So does
 *    anything that executes code or replaces a whole document — see POWERFUL_OPS.
 *
 * Replica: the executor reaches the op over loopback HTTP, and a cloud replica
 * disables the private-network auth bypass — the call would 401 with a confusing
 * message. Refuse honestly instead; cards are a console feature today.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const actionsV1Router = Router()

/**
 * The route answers within this budget or degrades. It sits OUTSIDE the
 * executor's own 10s per-op timeout on purpose: the op gives up first, so a slow
 * op still produces a real answer instead of a 504.
 */
const ROUTE_DEADLINE_MS = 12_000

/** Never invocable from a card — see the header. */
const BLOCKED_OPS = new Set(['api'])

/**
 * Confirmation floor. The registry's `destructive` tag is the real signal; these
 * names are pinned so a rename or a forgotten tag cannot quietly make a
 * one-click delete unconfirmed.
 */
const DESTRUCTIVE_OPS = new Set(['task_delete', 'task_merge'])

/**
 * The second half of the floor, for a different reason than data loss: these ops
 * EXECUTE CODE (session_start spawns a coding CLI with a model-chosen prompt,
 * cwd and permission mode; session_send types into a live one) or WRITE THE
 * USER'S DOCUMENTS (memory_write; note_write with an expectedHash overwrites an
 * existing note, without one it creates a new file in the vault; note_edit
 * rewrites a passage inside an existing note; note_attach drops a binary file
 * into the vault).
 *
 * The threat is not only a buggy model. The Personal AI reads task titles from
 * sync plugins, notes, and session transcripts, so any of those can steer it into
 * emitting a harmless-looking `label` over an arbitrary call — and the card face
 * shows the label, not the args. One click must not be enough for these.
 */
const POWERFUL_OPS = new Set([
  'session_start', 'session_send', 'memory_write', 'note_write', 'note_edit', 'note_attach',
])

/** Why `tool` may not run on a bare click, or null when a bare click is fine. */
function confirmReason(tool: string, destructiveTag: boolean): string | null {
  if (destructiveTag || DESTRUCTIVE_OPS.has(tool)) return `${tool} cannot be undone — confirm before running it`
  if (POWERFUL_OPS.has(tool)) return `${tool} runs code or writes the user's documents — confirm before running it`
  return null
}

function body(req: Request): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

/** The caller's session id, forwarded as provenance (never as authorization). */
function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return sid || undefined
}

/**
 * Loopback base for the executor: THIS server, on the port the request arrived
 * on. Without it the executor falls back to OPEN_WALNUT_API_URL → :3456, so an
 * ephemeral or test server would mutate production data.
 */
function apiBaseFor(req: Request): string {
  const fromHost = Number(req.get('host')?.split(':')[1])
  if (Number.isInteger(fromHost) && fromHost > 0) return `http://127.0.0.1:${fromHost}`
  const local = req.socket.localPort
  return `http://127.0.0.1:${Number.isInteger(local) && local! > 0 ? local : 3456}`
}

/**
 * Refuse before anything runs, and say so in the log. Refusals are part of the
 * audit trail: "a card tried to delete without confirmation" is exactly the line
 * someone will look for later.
 */
function refuse(res: Response, status: number, code: string, message: string, tool: string): void {
  log.web.info('actions: invoke refused', { tool, code })
  sendError(res, status, code, message)
}

/** Run one handler under the route deadline; unexpected failures still go to next(). */
async function guard(res: Response, next: NextFunction, label: string, fn: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ROUTE_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([fn().then(() => 'done' as const), deadline])
    if (outcome === 'timeout' && !res.headersSent) {
      log.web.warn('actions: route deadline exceeded', { route: label })
      sendError(res, 504, 'timeout', `${label} did not finish in ${ROUTE_DEADLINE_MS}ms — try again`)
    }
  } catch (err) {
    next(err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// POST /api/v1/actions/invoke { tool, args?, confirmed? }
actionsV1Router.post('/actions/invoke', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /actions/invoke', async () => {
    const b = body(req)
    const tool = typeof b.tool === 'string' ? b.tool.trim() : ''
    if (CLOUD_MODE) {
      refuse(res, 501, 'not_supported_cloud', 'Action cards run on the primary box only', tool)
      return
    }
    if (!tool) {
      refuse(res, 400, 'bad_request', 'tool (string) is required', '(none)')
      return
    }
    const rawArgs = b.args
    if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
      refuse(res, 400, 'bad_request', 'args must be a JSON object', tool)
      return
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>

    // Imported lazily: src/ops/index.ts pulls in every op module, and no route
    // file should widen the server's boot import graph for a feature that idles.
    const { getOp, executeOp } = await import('../../ops/index.js')

    const op = getOp(tool)
    if (!op) {
      refuse(res, 400, 'unknown_tool', `Unknown action: ${tool}`, tool)
      return
    }
    if (BLOCKED_OPS.has(tool)) {
      refuse(res, 400, 'not_invocable', `${tool} cannot be invoked from an action card`, tool)
      return
    }
    const needsConfirm = confirmReason(tool, op.tags.destructive === true)
    if (needsConfirm && b.confirmed !== true) {
      refuse(res, 400, 'confirmation_required', needsConfirm, tool)
      return
    }

    const parsed = z.object(op.input).strict().safeParse(args)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      refuse(res, 400, 'invalid_arguments', `Invalid arguments for ${tool}: ${issues}`, tool)
      return
    }

    const sid = callerSid(req)
    const startedAt = Date.now()
    const outcome = await executeOp(tool, parsed.data as Record<string, unknown>, {
      apiBase: apiBaseFor(req),
      ...(sid ? { callerSid: sid } : {}),
    })
    const ms = Date.now() - startedAt

    // Every invoke is logged with its outcome: a card click is a real mutation
    // the user authorized, so it needs the same audit trail an agent call has.
    if (outcome.ok) {
      log.web.info('actions: invoke ok', { tool, ms, callerSid: sid })
      res.json({ ok: true, tool, result: outcome.result })
      return
    }
    log.web.warn('actions: invoke failed', { tool, ms, error: outcome.message })
    res.json({ ok: false, tool, error: { code: 'op_failed', message: outcome.message } })
  })
})
