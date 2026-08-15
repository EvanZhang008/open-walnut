/**
 * Registry executor — turns an op call into HTTP against the /api/v1 facade.
 *
 * The ONLY execution engine for registry ops: the MCP server, the CLI's
 * `tools call`, and (P2) the hub-side gateway dispatch all run ops through
 * here, so behavior — arg validation, path fill, error shaping — is identical
 * no matter which surface the call came from.
 *
 * Never throws for expected failures: transport errors, timeouts, and non-2xx
 * statuses come back as `{ ok: false, message }` so every surface renders the
 * same friendly error. Only programmer errors (unknown op) throw.
 */

import { z } from 'zod'
import { getOp, type HttpBinding, type WalnutOp } from './registry.js'

const DEFAULT_API_ROOT = 'http://127.0.0.1:3456'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Resolve the `/api/v1` base. `OPEN_WALNUT_API_URL` may be the server root or
 * already carry the prefix — both accepted (same contract the MCP tools had).
 */
export function resolveApiBase(override?: string): string {
  const raw = (override ?? process.env.OPEN_WALNUT_API_URL ?? DEFAULT_API_ROOT).trim()
  const root = raw.replace(/\/+$/, '')
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`
}

export type OpOutcome =
  | { ok: true; result: unknown }
  | { ok: false; message: string }

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
 * One raw request. `path` is normally relative to the /api/v1 base; a path
 * that itself starts with `/api/` is treated as SERVER-ROOT-absolute (the
 * `api` passthrough op needs to reach non-v1 routes too).
 */
async function rawRequest(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<OpOutcome> {
  const serverRoot = base.replace(/\/api\/v1$/, '')
  const url = path.startsWith('/api/') ? `${serverRoot}${path}` : `${base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const code = causeCode(err)
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
      return { ok: false, message: `Walnut server not running at ${base} — start with \`open-walnut web\`` }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, message: `Walnut request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}` }
    }
    return { ok: false, message: `Walnut request failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const text = await res.text().catch(() => '')
  let parsed: unknown = undefined
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }

  if (!res.ok) {
    const e = (parsed as { error?: { code?: unknown; message?: unknown } | string } | undefined)?.error
    const code = typeof e === 'object' && typeof e?.code === 'string' ? e.code : String(res.status)
    const msg = typeof e === 'object' && typeof e?.message === 'string' ? e.message
      : typeof e === 'string' ? e
        : (text || res.statusText)
    return { ok: false, message: `Walnut API error (${code}): ${msg}` }
  }
  return { ok: true, result: parsed }
}

/**
 * Fill a binding's `:name` segments from args; remaining args become the query
 * string (GET/DELETE) or JSON body (other methods), unless the binding pins
 * them explicitly. Returns the concrete path + body.
 */
export function materializeBinding(
  bind: HttpBinding,
  args: Record<string, unknown>,
): { path: string; body: unknown } {
  const used = new Set<string>()
  const path = bind.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    used.add(name)
    const v = args[name]
    if (v === undefined || v === null || v === '') {
      throw new Error(`missing required path arg :${name}`)
    }
    return encodeURIComponent(String(v))
  })

  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!used.has(k) && v !== undefined) rest[k] = v
  }

  const queryKeys = new Set(bind.query ?? [])
  const bodyKeys = new Set(bind.body ?? [])
  const defaultToQuery = bind.method === 'GET' || bind.method === 'DELETE'

  const queryEntries: Array<[string, unknown]> = []
  const bodyEntries: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(rest)) {
    if (queryKeys.has(k)) queryEntries.push([k, v])
    else if (bodyKeys.has(k)) bodyEntries.push([k, v])
    else if (defaultToQuery) queryEntries.push([k, v])
    else bodyEntries.push([k, v])
  }

  const sp = new URLSearchParams()
  for (const [k, v] of queryEntries) sp.set(k, String(v))
  const qs = sp.toString()

  // Writes always send a JSON object (even empty) — several v1 handlers read
  // `req.body ?? {}` but express's json parser only runs with a body present.
  const needsBody = bind.method !== 'GET' && bind.method !== 'DELETE'
  const body = bodyEntries.length > 0
    ? Object.fromEntries(bodyEntries)
    : (needsBody ? {} : undefined)

  return { path: qs ? `${path}?${qs}` : path, body }
}

/**
 * Execute one op by name. Validates args against the op's zod shape first, so
 * every surface rejects malformed input identically.
 */
export async function executeOp(
  name: string,
  rawArgs: Record<string, unknown>,
  options: { apiBase?: string } = {},
): Promise<OpOutcome> {
  const op = getOp(name)
  if (!op) return { ok: false, message: `Unknown op: ${name}. Run \`walnut tools list\` for the catalog.` }

  const parsed = z.object(op.input).strict().safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, message: `Invalid arguments for ${name}: ${issues}` }
  }
  const args = parsed.data as Record<string, unknown>

  const base = resolveApiBase(options.apiBase)
  return runOp(op, args, base)
}

async function runOp(op: WalnutOp, args: Record<string, unknown>, base: string): Promise<OpOutcome> {
  if (op.handler) {
    try {
      const call = async (method: HttpBinding['method'], path: string, body?: unknown): Promise<unknown> => {
        const r = await rawRequest(base, method, path, body)
        if (!r.ok) throw new Error(r.message)
        return r.result
      }
      return { ok: true, result: await op.handler(args, call) }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  let materialized: { path: string; body: unknown }
  try {
    materialized = materializeBinding(op.bind!, args)
  } catch (err) {
    return { ok: false, message: `Invalid arguments for ${op.name}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const r = await rawRequest(base, op.bind!.method, materialized.path, materialized.body)
  if (!r.ok) return r
  const result = op.mapResult ? op.mapResult({ body: r.result, args }) : r.result
  return { ok: true, result }
}
