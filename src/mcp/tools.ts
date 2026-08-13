/**
 * Walnut MCP tools — thin HTTP wrappers over the frozen `/api/v1` REST facade.
 *
 * Every tool here is deliberately dumb: validate input with zod, call one v1
 * endpoint, hand the JSON back as text. No business logic, no local store
 * access — the server owns task semantics (project auto-create, phase
 * derivation, sync outbox), so an MCP consumer gets EXACTLY the same behavior
 * as the web UI and the iOS app. Requests from an AI coding session on this
 * machine hit 127.0.0.1, where v1 auth is bypassed for private networks
 * (src/web/middleware/auth.ts), so no token plumbing is needed.
 *
 * Split read vs write: `--readonly` registers only the READ_TOOLS set, for
 * triage-style consumers that must never mutate the user's task list.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { taskRefTag } from '../utils/entity-refs.js'

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_API_ROOT = 'http://127.0.0.1:3456'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Resolve the `/api/v1` base. `OPEN_WALNUT_API_URL` may be given either as the
 * server root (`http://127.0.0.1:3456`) or with the prefix already attached —
 * both are accepted so a user can paste whichever they have at hand.
 */
export function resolveApiBase(override?: string): string {
  const raw = (override ?? process.env.OPEN_WALNUT_API_URL ?? DEFAULT_API_ROOT).trim()
  const root = raw.replace(/\/+$/, '')
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`
}

// ── Result helpers ───────────────────────────────────────────────────────────

/** JSON text content — the one result shape every tool returns on success. */
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** MCP tool error (isError) carrying a human-readable message. */
function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

const REF_INSTRUCTION =
  'Include the `ref` string verbatim in your reply to the user so Walnut renders a clickable task pill.'

/** Attach the ref tag + paste instruction to a task-mutating tool result. */
function withRef(task: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  const t = (task ?? {}) as { id?: unknown; title?: unknown }
  const id = typeof t.id === 'string' ? t.id : ''
  const title = typeof t.title === 'string' ? t.title : ''
  return ok({ ...extra, task, ref: taskRefTag(id, title), instruction: REF_INSTRUCTION })
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface ApiOk { ok: true; status: number; body: unknown }
interface ApiErr { ok: false; message: string }
type ApiResult = ApiOk | ApiErr

/** Pull the deepest cause code out of a fetch failure (Node wraps in TypeError). */
function causeCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * One v1 request. Never throws: a transport failure, a timeout, or a non-2xx
 * status all come back as `{ ok: false, message }` for the caller to turn into
 * an MCP tool error.
 */
async function apiRequest(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const url = `${base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const code = causeCode(err)
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
      return {
        ok: false,
        message: `Walnut server not running at ${base} — start with \`open-walnut web\``,
      }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, message: `Walnut request timed out after ${REQUEST_TIMEOUT_MS}ms: ${init.method ?? 'GET'} ${path}` }
    }
    return { ok: false, message: `Walnut request failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const text = await res.text().catch(() => '')
  let body: unknown = undefined
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }

  if (!res.ok) {
    const e = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
    const code = typeof e?.code === 'string' ? e.code : String(res.status)
    const msg = typeof e?.message === 'string' ? e.message : (text || res.statusText)
    return { ok: false, message: `Walnut API error (${code}): ${msg}` }
  }
  return { ok: true, status: res.status, body }
}

/** Build a query string from defined values only. */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// ── Shared enums ─────────────────────────────────────────────────────────────

const PRIORITY = z.enum(['immediate', 'important', 'backlog', 'none'])
const STATUS = z.enum(['todo', 'in_progress', 'done'])

export const READ_TOOL_NAMES = [
  'task_list',
  'task_get',
  'search',
  'project_list',
  'session_list',
  'walnut_status',
] as const

export const WRITE_TOOL_NAMES = [
  'task_create',
  'task_update',
  'task_complete',
  'task_delete',
] as const

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register Walnut's tools on an McpServer. `readonly` restricts the surface to
 * READ_TOOL_NAMES (nothing that mutates the user's data is even advertised, so
 * a read-only consumer cannot be talked into a write).
 */
export function registerWalnutTools(
  server: McpServer,
  options: { readonly?: boolean; apiBase?: string } = {},
): void {
  const base = resolveApiBase(options.apiBase)

  // ── Reads ──

  server.registerTool('task_list', {
    title: 'List Walnut tasks',
    description:
      'List the user\'s tasks (open tasks + anything completed in the last 14 days). ' +
      'Filters combine: status, project (exact, case-insensitive; "" = Inbox), tag (exact), ' +
      'q (case-insensitive substring on the title). Returns slim task rows plus syncedAt.',
    inputSchema: {
      status: STATUS.optional().describe('todo | in_progress | done'),
      project: z.string().optional().describe('Project name; "" for the Inbox'),
      tag: z.string().optional().describe('Exact tag match'),
      q: z.string().optional().describe('Case-insensitive substring on the task title'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ status, project, tag, q }) => {
    const r = await apiRequest(base, `/tasks${qs({ status, project, tag, q })}`)
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('task_get', {
    title: 'Get one Walnut task',
    description:
      'Full detail for one task — including description, note, summary, session_ids, and ' +
      'dependency/child/parent decorations that the list view omits. The id accepts a unique prefix.',
    inputSchema: {
      id: z.string().min(1).describe('Task id or a unique id prefix'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const r = await apiRequest(base, `/tasks/${encodeURIComponent(id)}`)
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('search', {
    title: 'Search Walnut',
    description:
      'Global search across the user\'s tasks, memory, and sessions (string + semantic legs). ' +
      'Use this to check whether something already exists before creating a task.',
    inputSchema: {
      q: z.string().min(1).describe('Search query'),
      types: z.string().optional().describe('Comma-separated subset of: task,memory,session'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ q, types, limit }) => {
    const r = await apiRequest(base, `/search${qs({ q, types, limit })}`)
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('project_list', {
    title: 'List Walnut projects',
    description:
      'Project registry rows with per-project task counts, favorite flags, and the Inbox counts. ' +
      'Project is the only grouping layer; a task with no project lives in the Inbox.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await apiRequest(base, '/projects')
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('session_list', {
    title: 'List Walnut coding sessions',
    description:
      'The user\'s tracked AI coding sessions (id, title, owning task, host, process_status, ' +
      'model, message_count). Read-only — use it to see what else is running before starting work.',
    inputSchema: {
      status: z.enum(['running', 'idle', 'stopped', 'error']).optional().describe('Filter by process status'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ status }) => {
    const r = await apiRequest(base, `/sessions${qs({ status })}`)
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('walnut_status', {
    title: 'Walnut server status',
    description:
      'Server health and identity: mode (LIVE primary vs REPLICA cloud companion), version, ' +
      'server time, last sync time. Call this first if another tool reports a connection problem.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await apiRequest(base, '/status')
    return r.ok ? ok(r.body) : fail(r.message)
  })

  if (options.readonly) return

  // ── Writes ──

  server.registerTool('task_create', {
    title: 'Create a Walnut task',
    description:
      'Create a task. An omitted/empty project means the Inbox; an unknown project name ' +
      'auto-creates its registry row. `description` is write-only (stored, but not echoed in the ' +
      'slim response). The result carries a `ref` tag — paste it verbatim in your reply so the ' +
      'user gets a clickable task pill.',
    inputSchema: {
      title: z.string().min(1).describe('Task title (required)'),
      project: z.string().optional().describe('Project name; omit or "" for the Inbox'),
      priority: PRIORITY.optional().describe('immediate | important | backlog | none'),
      due_date: z.string().optional().describe('YYYY-MM-DD or a full ISO-8601 datetime'),
      description: z.string().optional().describe('Longer body text (write-only)'),
    },
  }, async ({ title, project, priority, due_date: dueDate, description }) => {
    const r = await apiRequest(base, '/tasks', {
      method: 'POST',
      body: {
        title,
        ...(project === undefined ? {} : { project }),
        ...(priority === undefined ? {} : { priority }),
        ...(dueDate === undefined ? {} : { due_date: dueDate }),
        ...(description === undefined ? {} : { description }),
      },
    })
    if (!r.ok) return fail(r.message)
    return withRef((r.body as { task?: unknown } | undefined)?.task)
  })

  server.registerTool('task_update', {
    title: 'Update a Walnut task',
    description:
      'Patch any subset of a task\'s fields. At least one field is required. `tags` is a FULL ' +
      'replace ([] clears). Pass "" to clear due_date/start_date. The id accepts a unique prefix. ' +
      'Prefer task_complete for the common "mark it done" case.',
    inputSchema: {
      id: z.string().min(1).describe('Task id or a unique id prefix'),
      status: STATUS.optional().describe('todo | in_progress | done (the server derives phase)'),
      priority: PRIORITY.optional(),
      due_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
      start_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
      project: z.string().optional().describe('Project name; "" = Inbox'),
      title: z.string().optional().describe('New title (non-empty, <= 500 chars)'),
      description: z.string().optional().describe('Replaces the description (write-only)'),
      tags: z.array(z.string()).optional().describe('FULL replacement of the task tags'),
    },
    annotations: { destructiveHint: false },
  }, async ({ id, ...fields }) => {
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v
    }
    if (Object.keys(body).length === 0) {
      return fail('task_update needs at least one field to change besides `id`.')
    }
    const r = await apiRequest(base, `/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body })
    return r.ok ? ok(r.body) : fail(r.message)
  })

  server.registerTool('task_complete', {
    title: 'Complete a Walnut task',
    description:
      'Mark a task done. The id accepts a unique prefix. The result carries a ' +
      '`ref` tag — paste it verbatim in your reply so the user gets a clickable task pill.',
    inputSchema: {
      id: z.string().min(1).describe('Task id or a unique id prefix'),
    },
    annotations: { destructiveHint: false },
  }, async ({ id }) => {
    // POST /complete, NOT PATCH {status:'done'}: only completeTask() semantics
    // auto-unpin from the Focus bar and surface a sync-push failure (the v1
    // PATCH swallows it via asyncPush). Same reasoning as the CLI's `done`.
    const r = await apiRequest(base, `/tasks/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: {},
    })
    if (!r.ok) return fail(r.message)
    return withRef((r.body as { task?: unknown } | undefined)?.task, { completed: true })
  })

  server.registerTool('task_delete', {
    title: 'Delete a Walnut task',
    description:
      'Permanently delete a task. Only do this when the user explicitly asked for a deletion — ' +
      'completing a task (task_complete) is almost always what is wanted instead. A task with ' +
      'active sessions refuses the delete unless force is true (which stops those sessions first).',
    inputSchema: {
      id: z.string().min(1).describe('Task id or a unique id prefix'),
      force: z.boolean().optional().describe('Stop the task\'s active sessions and delete anyway'),
    },
    annotations: { destructiveHint: true },
  }, async ({ id, force }) => {
    const r = await apiRequest(
      base,
      `/tasks/${encodeURIComponent(id)}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    )
    return r.ok ? ok({ deleted: true, id }) : fail(r.message)
  })
}
