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
import { CALLER_KIND_HEADER, SENDER_LABEL_HEADER } from '../lib/cli-sender.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { TEST_RUN_HEADER, ambientTestRun, parseTestRunLabel } from '../core/test-run.js'
import { answerByHeader } from '../lib/answer-by.js'
import { CALLER_UNPROVEN_HEADER } from '../lib/caller-unproven.js'
const humanCallerScope = new AsyncLocalStorage<boolean>()
const explicitCallerScope = new AsyncLocalStorage<{ sid?: string; kind: 'person' | 'agent'; pluginId?: string; unproven?: true }>()
import { getOp, type HttpBinding, type WalnutOp } from './registry.js'
import { defaultAddressNote, demoApiHeaders, getSelfApiRoot, getSelfCallToken, walnutApiTarget } from '../lib/self-api-root.js'
import { fetchErrorCode } from '../lib/fetch-error.js'
import {
  LOCAL_ORIGIN, ORIGIN_HEADER, UNKNOWN_ORIGIN, ambientCallerOrigin, isLocalOrigin, isRemoteHostOrigin, lowerOrigin, withCallerOrigin,
} from '../lib/caller-origin.js'
import { selfCallRefusal } from './origin-policy.js'
import { declaredKeysNote, invalidTypeHint, unknownKeyHint, unknownKeyNotes } from './arg-hints.js'
import { isCallId, takeCallIdArg, writeOpId } from '../lib/op-call-id.js'
import { runOnce } from './op-calls.js'
import { FULL_ARG, agentAnswer, answerFit, cutTextRefusal, takeFullArg, type AnswerFit, type AnswerSurface } from './answer.js'
import { COLLECTION_MAX, oversizedCollection } from '../lib/zod-rules.js'
import { TASK_DIR_VAR, opTmpPathNote } from '../lib/tmp-draft-path.js'
import { opLinkNotes } from '../lib/missing-links.js'

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Resolve the `/api/v1` base. `OPEN_WALNUT_API_URL` may be the server root or
 * already carry the prefix — both accepted (same contract the MCP tools had).
 * Inside a listening server its own root wins over the env: a server's ops must
 * never land on another Walnut (see src/lib/self-api-root.ts).
 */
export function resolveApiBase(override?: string): string {
  return `${walnutApiTarget({ given: override }).root}/api/v1`
}

export type OpOutcome =
  /** `retry`: a self-call on the way got no answer or one a retry may change, though the op answered ok. */
  | { ok: true; result: unknown; retry?: true }
  /**
   * `unreachable`: nothing answered at all (a session's CLI may ask its host daemon instead).
   * `lost`: the request went but its answer did not come back (a timeout, a dropped
   * connection), so a write may have applied. `retry`: a self-call was answered with a status a
   * retry may change (5xx, 408, 429): a copy of the same call runs again (op-calls.ts).
   */
  | { ok: false; message: string; result?: unknown; unreachable?: true; lost?: true; retry?: true
      /** The call named no op, or arguments the op does not take: the caller's to fix, nothing ran. */
      invalidArgs?: true
      /** The HTTP status Walnut's API answered this failure with, when it answered one. */
      status?: number
      /** The error code it answered with beside the status (`disk_full`, `host_reconnecting`), when it named one. */
      code?: string
      /** How long it said to wait before trying again (its `retryAfter`, seconds), in ms. */
      retryAfterMs?: number }

/** Header every op request carries when the caller's session id is known. */
export const CALLER_SID_HEADER = 'x-walnut-caller-sid'

/** Host the calling CLI runs on (daemon hostKey) — provenance for anonymous
 *  senders' fence labels. Same trust level as the sid header: never gated on. */
export const CALLER_HOST_HEADER = 'x-walnut-caller-host'

/** The plugin a call was made through (callPluginOp). Provenance only, like the sid header:
 *  it grants no read and never makes a caller a person (task_create keeps such a plugin's tasks). */
export const CALLER_PLUGIN_HEADER = 'x-walnut-plugin-id'
/**
 * The job of that plugin a call was made by (a host replica's own gateway calls only): a host
 * replica takes it, with its in-process credential, as the maker of an away write.
 */
export const CALLER_PLUGIN_JOB_HEADER = 'x-walnut-plugin-job'
/**
 * A relayed plugin job's credential (core/plugin-jobs/job-caller.ts): a token only this process
 * holds, naming the job its host's daemon vouched for. Unlike the two labels above it is read as
 * who the caller is (the start-mode ceiling), so it is never a value a caller writes.
 */
export const CALLER_JOB_HEADER = 'x-walnut-caller-job'

/**
 * Who is calling. `sid` and `host` are labels, never gated on. `origin` is the
 * trust class the self-call carries (src/lib/caller-origin.ts): the receiving
 * route may LOWER trust on it, never raise it.
 */
interface CallerProvenance {
  host?: string; proof?: string; trigger?: string; job?: string; sid?: string; unproven?: true; explicitSid?: string; callerKind: 'person' | 'agent'; pluginId?: string; pluginJob?: string; origin: string; beforeMutation?: () => Promise<void>; sender?: string
  /** The op call's id (src/lib/op-call-id.ts): each write it makes carries an op id derived from it. */
  callId?: string
  /** Writes made so far per route, for those op ids. */
  writes?: Map<string, number>
  /** The op ids this run sent its writes under. */
  writtenIds?: string[]
  /** Set when a self-call of this run got no answer: a failure then may hide a write that applied. */
  lostAny?: boolean
  /** Set when a self-call was answered with a status a retry may change (the ledger's `settles`), or reached no server. */
  unsettled?: boolean
  /** Set when a self-call got no answer from any server: refused, no such host, or reset before one (then lost too). */
  unreachedAny?: boolean
  /** Set when any self-call got an answer from a server, whatever its status. */
  answeredAny?: boolean
}

/** The op id of the next write of this call to `method path` (src/lib/op-call-id.ts writeOpId). */
function nextWriteOpId(prov: CallerProvenance, method: string, path: string): string | undefined {
  if (!prov.callId || method === 'GET' || method === 'HEAD') return undefined
  const route = `${method} ${path.split('?')[0]}`
  prov.writes ??= new Map()
  const seq = prov.writes.get(route) ?? 0
  prov.writes.set(route, seq + 1)
  const id = writeOpId(prov.callId, method, path, seq)
  ;(prov.writtenIds ??= []).push(id)
  return id
}

/** The op-id header the applied-ops ledger dedups a write by (src/web/middleware/op-id.ts). */
const OP_ID_HEADER = 'x-walnut-op-id'

/**
 * Marks an op's own call to this API: real use counts it under its tool (core/usage-watch), so
 * the request log leaves it out of the routes' numbers. Not a credential; it changes no access.
 */
export const OP_CALL_HEADER = 'x-walnut-op-call'

/** An error a handler op's self-call throws, carrying whether its answer was lost. */
class SelfCallError extends Error {
  constructor(message: string, readonly lost: boolean, readonly status?: number, readonly code?: string, readonly retryAfterMs?: number) { super(message) }
}

/**
 * What an agent reads after a 507 (the server's disk guard: its data disk is full). The disk is
 * the machine, not the work and not the user's decision: on 2026-10-28 agents that hit it asked
 * the user, and their tasks read Needs you. Walnut wakes a task that reports waiting on the
 * machine once writes work again (src/core/sessions/machine-wake.ts).
 */
export const DISK_FULL_HINT = ' This is the machine, not your work: do not ask the user about it and do not stop on it.'
  + ' Free space only from your own build output or scratch if you have some. Otherwise, in your status report (Walnut asks'
  + ' for it in a question of its own right after your turn; never write its lines in a reply), say you are waiting on the'
  + ' machine: free disk on the Walnut server;'
  + ' Walnut tells your lead, and wakes this task when writes work again.'

/**
 * A test run's header (src/core/test-run.ts): the scope this call runs in, else the CLI's
 * `WALNUT_TEST_RUN`, so `WALNUT_TEST_RUN=<label> walnut tools call ...` makes test objects.
 */
function testRunHeader(): Record<string, string> {
  const label = parseTestRunLabel(ambientTestRun() ?? process.env.WALNUT_TEST_RUN)
  return label ? { [TEST_RUN_HEADER]: label } : {}
}

/** "No server here", naming the address and, when it is only the default, that nothing named one. */
function notRunningMessage(base: string): string {
  return `Walnut server not running at ${base}${defaultAddressNote(base)} — start with \`open-walnut web\``
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
  // A call to this process's own server proves itself (a cloud-mode server has no
  // loopback waiver); the credential never goes to any other root.
  const self = getSelfApiRoot()
  const selfToken = self && resolveApiBase(self) === base ? getSelfCallToken() : null
  let res: Response
  if (method !== 'GET' && method !== 'HEAD') await prov.beforeMutation?.()
  const opId = nextWriteOpId(prov, method, path)
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(prov.sid ? { [CALLER_SID_HEADER]: prov.sid } : {}),
        ...(prov.host ? { [CALLER_HOST_HEADER]: prov.host } : {}),
        ...(prov.pluginId ? { [CALLER_PLUGIN_HEADER]: prov.pluginId } : {}),
        ...(prov.pluginId && prov.pluginJob ? { [CALLER_PLUGIN_JOB_HEADER]: prov.pluginJob } : {}),
        // A host daemon's word on the asking process, by a token only this process holds (relay-proof.ts).
        ...(prov.proof ? { 'x-walnut-caller-proof': prov.proof } : {}),
        // A trigger check's call, by a token only this process holds (core/hosts/trigger-caller.ts).
        ...(prov.trigger ? { 'x-walnut-caller-trigger': prov.trigger } : {}),
        // A relayed plugin job's call, by a token only this process holds (core/plugin-jobs/job-caller.ts).
        ...(prov.job ? { [CALLER_JOB_HEADER]: prov.job } : {}),
        // A session sid the host's daemon could not prove (lib/caller-unproven.ts): it only lowers trust.
        ...(prov.unproven ? { [CALLER_UNPROVEN_HEADER]: '1' } : {}),
        // No session and no person behind it: a script or a scheduled job (src/lib/cli-sender.ts).
        ...(!prov.sid && prov.callerKind === 'agent' ? { [CALLER_KIND_HEADER]: 'automation', ...(prov.sender ? { [SENDER_LABEL_HEADER]: prov.sender } : {}) } : {}),
        ...(selfToken ? { Authorization: `Bearer ${selfToken}` } : {}),
        // A retry of the same call meets this write's first answer instead of applying it twice.
        ...(opId ? { [OP_ID_HEADER]: opId } : {}),
        ...testRunHeader(),
        ...demoApiHeaders(url),
        // A relayed call's deadline (src/lib/answer-by.ts), so a route that holds an answer lets go in time.
        ...answerByHeader(),
        // Always sent, so no self-call can reach a loopback-trusting route unlabelled.
        [ORIGIN_HEADER]: prov.origin,
        [OP_CALL_HEADER]: '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const code = fetchErrorCode(err)
    // Refused or not found: the request never reached a server, so it ran nothing; a copy of
    // the call still runs again. A reset may come after the server took the request: lost.
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      prov.unsettled = true
      prov.unreachedAny = true
      return { ok: false, unreachable: true, message: notRunningMessage(base) }
    }
    prov.lostAny = true
    if (code === 'ECONNRESET') {
      prov.unreachedAny = true
      return { ok: false, unreachable: true, lost: true, message: notRunningMessage(base) }
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, lost: true, message: `Walnut request timed out after ${timeoutMs}ms: ${method} ${path}` }
    }
    return { ok: false, lost: true, message: `Walnut request failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  prov.answeredAny = true
  // The headers came, the body did not (a reset, a timeout mid-answer): the answer was lost.
  let text = ''
  try {
    text = await res.text()
  } catch (err) {
    prov.lostAny = true
    return { ok: false, lost: true, message: `Walnut request failed reading its answer (${res.status}): ${err instanceof Error ? err.message : String(err)}: ${method} ${path}` }
  }
  let parsed: unknown = undefined
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 408 || res.status === 429) prov.unsettled = true
    const body = parsed as { error?: { code?: unknown; message?: unknown } | string; code?: unknown } | undefined
    const e = body?.error
    // Two shapes answer an error: { error: { code, message } } and { error: "<message>", code }.
    // The code is what a caller acts on (approval_used, denied), so either one keeps it.
    // A 5xx keeps its number: callers read "503" as the server being away (trigger-check-core.ts).
    const flat = res.status < 500 && typeof e === 'string' && typeof body?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(body.code) ? body.code : undefined
    const code = typeof e === 'object' && typeof e?.code === 'string' ? e.code : flat ?? String(res.status)
    const msg = typeof e === 'object' && typeof e?.message === 'string' ? e.message
      : typeof e === 'string' ? e
        : (text || res.statusText)
    // The answer's own code at any status, kept apart from the words (a 5xx's message names its number).
    const named = typeof e === 'object' && typeof e?.code === 'string' ? e.code : typeof body?.code === 'string' ? body.code : undefined
    const apiCode = named && /^[a-z][a-z0-9_]{0,63}$/.test(named) ? named : undefined
    const wait = typeof e === 'object' ? (e as { retryAfter?: unknown }).retryAfter : undefined
    const retryAfterMs = typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3600) * 1000 : undefined
    return {
      ok: false, status: res.status, ...(apiCode ? { code: apiCode } : {}), ...(retryAfterMs ? { retryAfterMs } : {}),
      message: `Walnut API error (${code}): ${msg}${res.status === 507 ? DISK_FULL_HINT : ''}`,
    }
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
  // An object goes as JSON (host_exec_read's wait_for); String() would send "[object Object]".
  for (const [k, v] of queryEntries) sp.set(k, v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : String(v))
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
  /** The plugin the call is made through (callPluginOp): provenance, whoever the caller is. */
  callerPluginId?: string
  /** The job of that plugin (a relayed plugin job call on a host replica): provenance only. */
  callerPluginJob?: string
  /** Human clicks never inherit a session id from headers or the process environment. */
  callerMode?: 'session' | 'human'
  /**
   * The call's id, chosen by its caller (src/lib/op-call-id.ts). A write op runs at most
   * once per id (op-calls.ts), and each write it makes carries an op id derived from it.
   * A caller re-running a call may give it as `_call_id` in the arguments instead.
   */
  callId?: string
  /**
   * The answer goes to an agent, printed by this surface: `mcp` (a session's MCP tool) or `cli`
   * (`walnut tools call` in its shell). Shaped and held to the op's answer policy on that surface
   * (answer.ts). Server code that reads the result itself leaves it out.
   */
  forAgent?: AnswerSurface
  /** The CLI's automation label when no session and no person stands behind the call (cli-sender.ts). */
  sender?: string
  /** Recheck a frozen human plan immediately before each mutation self-call. */
  beforeMutation?: () => Promise<void>
  callerHost?: string
  /** A relayed caller proof's token (core/approvals/relay-proof.ts): only the gateway relay sets it. */
  callerProof?: string
  /** A relayed trigger check's token (core/hosts/trigger-caller.ts): only the gateway relay sets it. */
  callerTrigger?: string
  /** A relayed plugin job's token (core/plugin-jobs/job-caller.ts): only the gateway relay sets it. */
  callerJob?: string
  /**
   * The host's daemon could not prove the session sid it relays (lib/caller-unproven.ts): the
   * start-mode ceiling reads this caller as anonymous. Nested ops of the call keep it.
   */
  callerUnproven?: boolean
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
    return `${op.name} is local-only (destructive): a session on another host cannot run it.${op.remoteDenyNext ? ` ${op.remoteDenyNext}` : ''}`
  }
  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `raw` without the fields `op` retired (WalnutOp.retiredInput); copies only what it changes. */
function dropRetiredInput(op: WalnutOp, raw: Record<string, unknown>): Record<string, unknown> {
  let out = raw
  const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
  const carry = (o: Record<string, unknown>, from: string, to: string, max: number): Record<string, unknown> => {
    const text = o[from]
    if (typeof text !== 'string' || !text.trim() || own(o, to)) return o
    return { ...o, [to]: Array.from(text.trim()).slice(0, max).join('') }
  }
  for (const r of op.renamedInput ?? []) {
    const cut = r.from.indexOf('[].')
    if (cut < 0) { out = carry(out, r.from, r.to, r.max); continue }
    const list = r.from.slice(0, cut)
    const items = out[list]
    if (!Array.isArray(items)) continue
    const field = r.from.slice(cut + 3)
    const toField = r.to.slice(r.to.indexOf('[].') + 3)
    out = { ...out, [list]: items.map((i) => isPlainObject(i) ? carry(i, field, toField, r.max) : i) }
  }
  for (const path of op.retiredInput ?? []) {
    const cut = path.indexOf('[].')
    if (cut < 0) {
      if (!own(out, path)) continue
      if (out === raw) out = { ...raw }
      delete out[path]
      continue
    }
    const list = path.slice(0, cut)
    const field = path.slice(cut + 3)
    const items = out[list]
    if (!Array.isArray(items) || !items.some((i) => isPlainObject(i) && own(i, field))) continue
    if (out === raw) out = { ...raw }
    out[list] = items.map((i) => {
      if (!isPlainObject(i) || !own(i, field)) return i
      const { [field]: _retired, ...rest } = i
      return rest
    })
  }
  return out
}

/**
 * Validate `rawArgs` against `op`'s input exactly as every surface does: a
 * retired field is dropped, any other unknown key is refused (with a "did you
 * mean" hint when the intended key is clear, and always the keys it takes:
 * src/ops/arg-hints.ts). Nothing is coerced; the one rewrite is a schema's own
 * transform, such as isoDateTime() adding `:00` seconds (src/lib/zod-rules.ts).
 */
export function parseOpArgs(
  op: WalnutOp,
  rawArgs: Record<string, unknown> | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string; invalidArgs: true } {
  const raw = rawArgs ?? {}
  const input = isPlainObject(raw) ? dropRetiredInput(op, raw) : raw
  // Before zod, which walks every entry of a record or an unbounded list (lib/zod-rules.ts).
  const oversized = oversizedCollection(input)
  if (oversized) return { ok: false, message: `Invalid arguments for ${op.name}: ${oversized}: more than ${COLLECTION_MAX} entries`, invalidArgs: true }
  const parsed = z.object(op.input).strict().safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      // A "did you mean" never stands alone: the keys the object takes follow it, so a wrong guess costs no round trip.
      const hint = i.code === 'unrecognized_keys'
        ? unknownKeyHint(op.input, input, i.path, i.keys)
          + unknownKeyNotes(op.input, i.path, i.keys)
          + declaredKeysNote(op.input, i.path, i.path.length ? `${op.name} ${i.path.join('.')}` : op.name)
        : i.code === 'invalid_type' ? invalidTypeHint(op.input, input, i.path, i.expected) : ''
      return `${i.path.join('.') || '(root)'}: ${i.message}${hint}`
    }).join('; ')
    return { ok: false, message: `Invalid arguments for ${op.name}: ${issues}`, invalidArgs: true }
  }
  return { ok: true, args: parsed.data as Record<string, unknown> }
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
  if (!op) return { ok: false, message: `Unknown op: ${name}. Run \`walnut tools list\` for the catalog.`, invalidArgs: true }
  // Untyped callers (tests, plain JS) may still pass nothing: that runs as the strictest class.
  options = options ?? ({} as ExecuteOpOptions)
  const origin = lowerOrigin(options.origin || UNKNOWN_ORIGIN, ambientCallerOrigin())
  const refused = originRefusal(op, origin)
  if (refused) return { ok: false, message: refused }

  // A caller re-running a call names it with `_call_id`: never one of the op's own arguments.
  let given = rawArgs
  let callId = isCallId(options.callId) ? options.callId : undefined
  if (isPlainObject(rawArgs) && Object.hasOwn(rawArgs, '_call_id')) {
    given = { ...rawArgs }
    const taken = takeCallIdArg(given)
    if (taken.bad) return { ok: false, message: `Invalid arguments for ${op.name}: ${taken.bad}`, invalidArgs: true }
    callId = taken.callId ?? callId
  }
  // An agent caller lifts its answer's cap for one call with `_full` (answer.ts): never one of the op's own arguments.
  let full = false
  if (isPlainObject(given) && Object.hasOwn(given, FULL_ARG)) {
    if (given === rawArgs) given = { ...rawArgs }
    const taken = takeFullArg(given)
    if (taken.bad) return { ok: false, message: `Invalid arguments for ${op.name}: ${taken.bad}`, invalidArgs: true }
    full = taken.full
  }
  const parsed = parseOpArgs(op, given)
  if (!parsed.ok) return parsed
  const args = parsed.args
  // A shortened read written back would delete the rest of what it was cut from (answer.ts).
  const cutText = cutTextRefusal(op, args)
  if (cutText) return { ok: false, message: cutText, invalidArgs: true }

  const base = resolveApiBase(options.apiBase)
  const inherited = explicitCallerScope.getStore()
  const human = inherited ? inherited.kind === 'person' : options.callerMode === 'human' || humanCallerScope.getStore() === true
  const explicitSid = human ? undefined : inherited ? inherited.sid : options.callerSid?.trim() || undefined
  const callerKind = human ? 'person' : 'agent'
  // The plugin making this call names it; a call naming none keeps the one it runs under.
  const pluginId = options.callerPluginId?.trim() || inherited?.pluginId
  // Once marked, every nested op of the call keeps the mark: it only lowers trust.
  const unproven = !human && (options.callerUnproven === true || inherited?.unproven === true)
  // A read runs again freely; a write runs once per call id.
  const once = callId && op.tags.readonly !== true ? callId : undefined
  // An agent's answer is held to the op's cap on the surface that prints it (answer.ts). An untyped
  // caller's `true` names no surface, so it gets the smaller one. A handler builds a part for it.
  const surface: AnswerSurface | undefined = options.forAgent ? (options.forAgent === 'mcp' ? 'mcp' : 'cli') : undefined
  const fit = surface && !full && !human && !pluginId && !op.answer?.whole_for?.(args) ? answerFit(op, surface) : undefined
  const run = async (): Promise<OpOutcome> => {
    const prov: CallerProvenance = {
      sid: explicitSid,
      explicitSid,
      callerKind,
      ...(pluginId ? { pluginId } : {}),
      ...(pluginId && options.callerPluginJob?.trim() ? { pluginJob: options.callerPluginJob.trim() } : {}),
      host: options.callerHost?.trim() || undefined,
      beforeMutation: options.beforeMutation,
      origin,
      ...(options.sender ? { sender: options.sender } : {}),
      ...(options.callerProof ? { proof: options.callerProof } : {}),
      ...(options.callerTrigger ? { trigger: options.callerTrigger } : {}),
      ...(options.callerJob ? { job: options.callerJob } : {}),
      ...(unproven ? { unproven: true as const } : {}),
      ...(once ? { callId: once } : {}),
    }
    const outcome = await humanCallerScope.run(human, () => explicitCallerScope.run({ sid: explicitSid, kind: callerKind, ...(pluginId ? { pluginId } : {}), ...(unproven ? { unproven: true as const } : {}) }, () => runOp(op, args, base, prov, fit)))
    // A handler that caught a lost or refused-for-now self-call and answered ok (a bulk op's
    // failed row): a copy must run it again, and the ledger answers the rows that applied.
    if (outcome.ok) return prov.lostAny || prov.unsettled ? { ...outcome, retry: true } : outcome
    // A handler that caught a lost self-call and failed another way still may have written.
    if (prov.lostAny && !outcome.lost) return { ...outcome, lost: true }
    if (prov.unsettled && !outcome.lost) return { ...outcome, retry: true }
    // A re-run whose handler stops before its write (it read the state the first try's write
    // made, say an edit already applied) is told what that first try already applied.
    return once && op.handler ? withEarlierWrites(outcome, base, prov) : outcome
  }
  const outcome = once ? await runOnce(once, op.name, args, explicitSid, run) : await run()
  // Text a session hands on gets one line back when it names a draft in a temp dir (tmp-draft-path.ts)
  // or, for the user, an id with no link to open it (missing-links.ts).
  if (human || pluginId) return outcome
  const noted = await withHandedTextNote(op.name, args, outcome, origin, explicitSid)
  // An agent reads a receipt for a write and capped content for a read (answer.ts).
  if (!surface || noted.result === undefined) return noted
  return { ...noted, result: agentAnswer(op, args, noted.result, full, surface) }
}

/**
 * A session's successful op whose arguments hand on text that needs one more step, as `walnut_note`
 * on its result:
 *  - a draft, plan or evidence path in a temp dir: move the file into the task directory and send
 *    the new path (tmp-draft-path.ts; WALNUT_TMP_WRITE_NOTE=0 turns it off);
 *  - words for the user (a thread summary, a letter, a Needs you ask) naming a code review, ticket or
 *    pull request with no link: add its full URL; a GitHub commit link GitHub does not have: take
 *    it out, the user wants no commit links (missing-links.ts; WALNUT_LINK_NOTE=0).
 * In the session's own process (WALNUT_TASK_DIR set: its MCP server, its CLI) and on the server
 * answering a session (a gateway call); never for a person or a plugin.
 */
async function withHandedTextNote(name: string, args: Record<string, unknown>, outcome: OpOutcome, origin: string, sid: string | undefined): Promise<OpOutcome> {
  if (!outcome.ok || !isPlainObject(outcome.result)) return outcome
  // This process is the calling session's own (its MCP server, its CLI) only when it runs under
  // that session's id: a server started from a task's shell inherits a task directory too.
  const self = process.env.WALNUT_SESSION_ID?.trim()
  const own = !sid || sid === self ? process.env.WALNUT_TASK_DIR?.trim() : undefined
  if (!own && !sid) return outcome
  const notes: string[] = []
  try {
    const tmp = process.env.WALNUT_TMP_WRITE_NOTE === '0' ? null : opTmpPathNote(name, args, {
      taskDir: own || TASK_DIR_VAR,
      ...(own && process.env.TMPDIR ? { tmpdir: process.env.TMPDIR } : {}),
      checkDisk: !!own || !isRemoteHostOrigin(origin),
    })
    if (tmp) notes.push(tmp)
  } catch { /* a note never fails the call */ }
  if (process.env.WALNUT_LINK_NOTE !== '0') notes.push(...await opLinkNotes(name, args))
  return notes.length ? { ...outcome, result: { ...outcome.result, walnut_note: notes.join(' ') } } : outcome
}

/**
 * A handler op's failure under a call id whose earlier try's writes applied (the try whose
 * answer was lost, before a restart too): the failure says so, with those writes, because
 * they, not this run, are what the call did. Writes this run made itself are not counted.
 */
async function withEarlierWrites(outcome: Extract<OpOutcome, { ok: false }>, base: string, prov: CallerProvenance): Promise<OpOutcome> {
  if (!prov.callId) return outcome
  const mine = new Set(prov.writtenIds ?? [])
  const read = await rawRequest(base, 'GET', `/op-calls/${encodeURIComponent(prov.callId)}`, undefined, 5_000, { origin: prov.origin, callerKind: prov.callerKind, ...(prov.sid ? { sid: prov.sid, explicitSid: prov.explicitSid } : {}), ...(prov.pluginId ? { pluginId: prov.pluginId } : {}) })
  const writes = read.ok ? ((read.result as { writes?: Array<{ route?: string; status?: number; outcome?: string; state?: string; opId?: string }> })?.writes ?? []) : []
  const earlier = writes.filter((w) => w.state === 'recorded' && w.outcome === 'applied' && (!w.opId || !mine.has(w.opId)))
  if (!earlier.length) return outcome
  const list = earlier.map((w) => `${w.route ?? 'a write'} (${w.status ?? 'applied'})`).join(', ')
  return {
    ok: false,
    message: `${outcome.message} An earlier try of this call (${prov.callId}) already applied ${list}, whose answer was lost; that is what this call did, and likely why running it again now fails. Do not run it again.`,
    result: { ...(isPlainObject(outcome.result) ? outcome.result : {}), call_id: prov.callId, earlier_writes: earlier },
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
  }
}

/**
 * A handler op's run whose self-calls got no answer from any server (refused, or reset, which is
 * also `lost`): it failed for want of one, as a bound op's call does, so a session's CLI asks its host daemon instead (tools.ts). The
 * handler's own error (or its result's) used to hide that: task_create from a session of a
 * Walnut on another port failed while task_get went through (2026-11-20).
 */
function reachedNoServer(prov: CallerProvenance): boolean {
  return prov.unreachedAny === true && prov.answeredAny !== true
}

async function runOp(
  op: WalnutOp,
  args: Record<string, unknown>,
  base: string,
  prov: CallerProvenance,
  fit: AnswerFit | undefined,
): Promise<OpOutcome> {
  const timeoutMs = (typeof op.timeoutMs === 'function' ? op.timeoutMs(args) : op.timeoutMs) ?? REQUEST_TIMEOUT_MS
  if (op.handler) {
    try {
      const call = async (method: HttpBinding['method'], path: string, body?: unknown): Promise<unknown> => {
        const refused = selfCallRefusal(op.name, method, path, prov.origin)
        if (refused) throw new Error(refused)
        const r = await rawRequest(base, method, path, body, timeoutMs, prov)
        if (!r.ok) throw new SelfCallError(r.message, r.lost === true, r.status, r.code, r.retryAfterMs)
        return r.result
      }
      // A handler that runs another op in-process (a plugin's walnut.ops.call)
      // acts for the same caller: the nested call cannot climb above this origin.
      const result = await withCallerOrigin(prov.origin, () => op.handler!(args, call, { sid: prov.explicitSid, kind: prov.callerKind, ...(fit ? { answer: fit } : {}) }))
      const message = op.resultError?.(result)
      return message ? { ok: false, message, result, ...(reachedNoServer(prov) ? { unreachable: true as const } : {}) } : { ok: true, result }
    } catch (err) {
      // A write of this call whose answer was lost (also inside a handler) may have applied.
      const lost = err instanceof SelfCallError && err.lost
      const status = err instanceof SelfCallError ? err.status : undefined
      const code = err instanceof SelfCallError ? err.code : undefined
      const retryAfterMs = err instanceof SelfCallError ? err.retryAfterMs : undefined
      const unreachable = reachedNoServer(prov)
      return {
        ok: false, message: err instanceof Error ? err.message : String(err), ...(lost ? { lost: true as const } : {}),
        ...(unreachable ? { unreachable: true as const } : {}),
        ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }
    }
  }

  let materialized: { path: string; body: unknown }
  try {
    materialized = materializeBinding(op.bind!, args)
  } catch (err) {
    return { ok: false, message: `Invalid arguments for ${op.name}: ${err instanceof Error ? err.message : String(err)}`, invalidArgs: true }
  }
  const refused = selfCallRefusal(op.name, op.bind!.method, materialized.path, prov.origin)
  if (refused) return { ok: false, message: refused }
  const r = await rawRequest(base, op.bind!.method, materialized.path, materialized.body, timeoutMs, prov)
  if (!r.ok) return r
  try {
    const result = op.mapResult ? op.mapResult({ body: r.result, args, ...(fit ? { answer: fit } : {}) }) : r.result
    const message = op.resultError?.(result)
    return message ? { ok: false, message, result } : { ok: true, result }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** How long the CLI waits for its call's record before it exits anyway. */
const OP_CALL_RECORD_TIMEOUT_MS = 2_000

/**
 * Tell the server what a session's call of a carded op said (core/sessions/op-call-log.ts),
 * so the session's chat card shows its words however the arguments reached the CLI
 * (`@file`, stdin, a subshell). Only from a session, only for an op core/op-cards.ts
 * covers; never throws, and a server that is away or too old costs nothing but the card's
 * words.
 */
export async function recordSessionOpCall(input: {
  op: string
  args: Record<string, unknown>
  result?: unknown
  ok: boolean
  error?: string
  form: string
  path?: string
}): Promise<void> {
  // A session's own CLI names its session in its env; a person's terminal has none.
  const sid = (process.env.WALNUT_SESSION_ID ?? '').trim()
  if (!sid || humanCallerScope.getStore() === true) return
  try {
    const { opCardFields } = await import('../core/op-cards.js')
    const fields = opCardFields(input.op, input.args, input.result)
    if (!fields) return
    await rawRequest(resolveApiBase(), 'POST', '/sessions/op-calls', {
      op: input.op,
      form: input.form,
      ...(input.path ? { path: input.path } : {}),
      ok: input.ok,
      ...(input.error ? { error: input.error.slice(0, 600) } : {}),
      fields,
    }, OP_CALL_RECORD_TIMEOUT_MS, { sid, explicitSid: sid, callerKind: 'agent', origin: LOCAL_ORIGIN })
  } catch { /* display data only */ }
}
