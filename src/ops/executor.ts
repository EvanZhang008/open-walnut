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
 *
 * Every request carries x-walnut-origin, the class of the caller the op acts
 * for (src/lib/caller-origin.ts), so a route that trusts this machine can tell a
 * self-call made for a remote host from a request typed on this Mac. What such a
 * call may reach is src/ops/origin-policy.ts.
 */

import { z } from 'zod'
import { getOp, type HttpBinding, type WalnutOp } from './registry.js'
import { getSelfApiRoot } from '../lib/self-api-root.js'
import {
  ORIGIN_HEADER, UNKNOWN_ORIGIN, ambientCallerOrigin, isLocalOrigin, isRemoteHostOrigin, lowerOrigin, withCallerOrigin,
} from '../lib/caller-origin.js'
import { selfCallRefusal } from './origin-policy.js'

const DEFAULT_API_ROOT = 'http://127.0.0.1:3456'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Resolve the `/api/v1` base. `OPEN_WALNUT_API_URL` may be the server root or
 * already carry the prefix — both accepted (same contract the MCP tools had).
 * Inside a listening server its own root wins over the env: a server's ops must
 * never land on another Walnut (see src/lib/self-api-root.ts).
 */
export function resolveApiBase(override?: string): string {
  const raw = (override ?? getSelfApiRoot() ?? process.env.OPEN_WALNUT_API_URL ?? DEFAULT_API_ROOT).trim()
  const root = raw.replace(/\/+$/, '')
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`
}

export type OpOutcome =
  | { ok: true; result: unknown }
  /** `unreachable`: nothing answered at all (a session's CLI may ask its host daemon instead). */
  | { ok: false; message: string; result?: unknown; unreachable?: true }

/** Header every op request carries when the caller's session id is known. */
export const CALLER_SID_HEADER = 'x-walnut-caller-sid'

/** Host the calling CLI runs on (daemon hostKey) — provenance for anonymous
 *  senders' fence labels. Same trust level as the sid header: never gated on. */
export const CALLER_HOST_HEADER = 'x-walnut-caller-host'

/**
 * Who is calling. `sid` and `host` are labels, never gated on. `origin` is the
 * trust class the self-call carries (src/lib/caller-origin.ts): the receiving
 * route may LOWER trust on it, never raise it.
 */
interface CallerProvenance { sid?: string; host?: string; origin: string }

/**
 * Who is calling, for ops whose server side stamps provenance (the human inbox
 * stamps a letter's sender from it). An explicit `callerSid` always wins — the
 * gateway resolved it from the daemon's own view of the calling CLI. The env
 * fallback covers the OTHER processes: `walnut tools call` and `walnut mcp`, which
 * run inside a managed session and inherit WALNUT_SESSION_ID.
 *
 * The header is provenance within the user's OWN trust domain — the socket is
 * owner-only 0600 and the localhost route is unauthenticated, so anyone who can
 * set this header is already the user (or a process the user ran). It is NOT a
 * cross-tenant credential. It does drive two same-user integrity choices, not
 * just labels: which session may answer a reply-request (session-send-core
 * performReply) and the "from session X" name on a peer fence. A local process
 * that forges it can therefore impersonate one of the user's OTHER sessions to
 * a third — but never escalate authorization: the fence still declares the
 * message unauthorized. Do not rely on this header as a security boundary
 * against a hostile local process (that boundary is the 0600 socket itself).
 */
function resolveCallerSid(explicit?: string): string | undefined {
  const sid = (explicit ?? process.env.WALNUT_SESSION_ID ?? '').trim()
  return sid || undefined
}

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
  body: unknown,
  timeoutMs: number,
  prov: CallerProvenance,
): Promise<OpOutcome> {
  const serverRoot = base.replace(/\/api\/v1$/, '')
  const url = path.startsWith('/api/') ? `${serverRoot}${path}` : `${base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(prov.sid ? { [CALLER_SID_HEADER]: prov.sid } : {}),
        ...(prov.host ? { [CALLER_HOST_HEADER]: prov.host } : {}),
        // Always sent, so no self-call can reach a loopback-trusting route unlabelled.
        [ORIGIN_HEADER]: prov.origin,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const code = causeCode(err)
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
      return { ok: false, unreachable: true, message: `Walnut server not running at ${base} — start with \`open-walnut web\`` }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, message: `Walnut request timed out after ${timeoutMs}ms: ${method} ${path}` }
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

export interface ExecuteOpOptions {
  apiBase?: string
  callerSid?: string
  callerHost?: string
  /**
   * REQUIRED: who this call acts for (src/lib/caller-origin.ts). `__local__` only
   * for a caller on this Mac; a gateway call passes its host, a route passes the
   * request's origin. A missing value runs as the strictest class, and the origin
   * already in effect (a nested call) can only lower it.
   */
  origin: string
}

/** Why `op` may not run for `origin`, or null. Every entry point meets this check. */
function originRefusal(op: WalnutOp, origin: string): string | null {
  if (op.tags.localHostGateway && !isLocalOrigin(origin)) {
    return `${op.name} refused: ${op.localOnlyMessage ?? 'this data is only available to sessions on this Mac'}`
  }
  if (op.tags.remote === 'deny' && isRemoteHostOrigin(origin)) {
    return `${op.name} is local-only (destructive): a session on another host cannot run it`
  }
  return null
}

/**
 * Execute one op by name. Refuses an origin the op may not run for, then
 * validates args against the op's zod shape, so every surface rejects both
 * identically.
 */
export async function executeOp(
  name: string,
  rawArgs: Record<string, unknown>,
  options: ExecuteOpOptions,
): Promise<OpOutcome> {
  const op = getOp(name)
  if (!op) return { ok: false, message: `Unknown op: ${name}. Run \`walnut tools list\` for the catalog.` }
  // Untyped callers (tests, plain JS) may still pass nothing: that runs as the strictest class.
  options = options ?? ({} as ExecuteOpOptions)
  const origin = lowerOrigin(options.origin || UNKNOWN_ORIGIN, ambientCallerOrigin())
  const refused = originRefusal(op, origin)
  if (refused) return { ok: false, message: refused }

  const parsed = z.object(op.input).strict().safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, message: `Invalid arguments for ${name}: ${issues}` }
  }
  const args = parsed.data as Record<string, unknown>

  const base = resolveApiBase(options.apiBase)
  return runOp(op, args, base, {
    sid: resolveCallerSid(options.callerSid),
    host: options.callerHost?.trim() || undefined,
    origin,
  })
}

async function runOp(
  op: WalnutOp,
  args: Record<string, unknown>,
  base: string,
  prov: CallerProvenance,
): Promise<OpOutcome> {
  const timeoutMs = op.timeoutMs ?? REQUEST_TIMEOUT_MS
  if (op.handler) {
    try {
      const call = async (method: HttpBinding['method'], path: string, body?: unknown): Promise<unknown> => {
        const refused = selfCallRefusal(op.name, method, path, prov.origin)
        if (refused) throw new Error(refused)
        const r = await rawRequest(base, method, path, body, timeoutMs, prov)
        if (!r.ok) throw new Error(r.message)
        return r.result
      }
      // A handler that runs another op in-process (a plugin's walnut.ops.call)
      // acts for the same caller: the nested call cannot climb above this origin.
      const result = await withCallerOrigin(prov.origin, () => op.handler!(args, call))
      const message = op.resultError?.(result)
      return message ? { ok: false, message, result } : { ok: true, result }
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
  const refused = selfCallRefusal(op.name, op.bind!.method, materialized.path, prov.origin)
  if (refused) return { ok: false, message: refused }
  const r = await rawRequest(base, op.bind!.method, materialized.path, materialized.body, timeoutMs, prov)
  if (!r.ok) return r
  try {
    const result = op.mapResult ? op.mapResult({ body: r.result, args }) : r.result
    const message = op.resultError?.(result)
    return message ? { ok: false, message, result } : { ok: true, result }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
