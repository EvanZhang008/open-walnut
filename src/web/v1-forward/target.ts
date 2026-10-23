/**
 * The Mac's half of the companion's forward (policy.ts): run one /api/v1 call
 * the companion carried here (`server.http` over the bridge) against this
 * server's own routes, as the paired client it came from. The console's
 * task-store writes on the exact list in policy.ts (CONSOLE_TASK_WRITES) come
 * the same way; no other path outside /api/v1 is run.
 *
 * The call is a loopback request to this server, labelled with the caller's
 * class (`x-walnut-origin: remote-http`), exactly as the plugin HTTP relay and
 * the op executor label theirs. The console's calls about what the companion's copy does not
 * keep (policy.ts CONSOLE_COPY_READS and CONSOLE_COPY_WRITES) come the same way.
 * So every route applies the rule it applies to a
 * paired phone, and none of the "this Mac only" ones open: they read the label
 * (src/web/middleware/request-origin.ts). No credential crosses: the phone's
 * token stays on the companion, and the label is how this server knows the call
 * is not its own.
 */

import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, lowerOrigin } from '../../lib/caller-origin.js'
import {
  FORWARD_METHODS, FORWARD_TARGET_TIMEOUT_MS, MAX_FORWARD_REQUEST_BYTES, MAX_FORWARD_RESPONSE_BYTES,
  companionAnswers, forwardRequestHeaders, forwardResponseHeaders, noteForwardedTaskWrite, parseConsoleCopyCall, parseConsoleTaskWrite, parseForwardUrl, phoneCopyReadOf,
} from './policy.js'

/**
 * `refused`: nothing ran here (a bad or unforwardable call); the companion may
 * answer it itself. `failed`: the call went to the route and no answer came
 * back, so a write may have been applied.
 */
export class ForwardError extends Error {
  constructor(message: string, readonly status: number, readonly code: 'forward_refused' | 'forward_failed') {
    super(message)
    this.name = 'ForwardError'
  }
}

export interface ForwardReply {
  status: number
  headers: Record<string, string>
  size: number
  /** The body, base64. Absent when `tooLarge`. */
  data?: string
  /** The reply was larger than the bridge carries: nothing of it came back. */
  tooLarge?: true
}

const refuse = (message: string, status = 400): ForwardError => new ForwardError(message, status, 'forward_refused')

function decodeBody(data: unknown, size: unknown): Buffer {
  if (data === undefined || data === null || data === '') return Buffer.alloc(0)
  if (typeof data !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw refuse('Invalid forwarded body')
  }
  if (size > MAX_FORWARD_REQUEST_BYTES || data.length > Math.ceil(MAX_FORWARD_REQUEST_BYTES / 3) * 4 + 4) {
    throw refuse('Forwarded body is too large', 413)
  }
  const body = Buffer.from(data, 'base64')
  if (body.byteLength !== size || body.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    throw refuse('Invalid forwarded body encoding')
  }
  return body
}

/** Read at most `limit` bytes; null when the body is longer. */
async function readUpTo(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/**
 * A kept phone read of a copy the box does not hold (policy.ts phoneCopyReadOf): this Mac's
 * choice turned the kind off for the companion, or turned it on again and no round of it has
 * reached the box since (its copy is still the off marker, so the box would answer
 * not_kept_here; docs/plan/walnut-companion-unified-replica.md, 4f).
 */
async function companionKeepsNot(method: string, rel: string): Promise<boolean> {
  const read = phoneCopyReadOf(method, rel)
  if (!read) return false
  const [{ getConfig }, { copyChoiceFrom, copyKindHeldBy }, { companionCopiesOf }] = await Promise.all([
    import('../../core/config-manager.js'), import('../../core/replication/kinds/copy-kind.js'), import('../../core/replication/companion-keep.js'),
  ])
  const choice = copyChoiceFrom(companionCopiesOf(await getConfig())) as unknown as Record<string, boolean>
  return choice[read.choice] === false || !copyKindHeldBy('companion', read.kind)
}

export type Checked = { ok: true; path: string; rel: string } | { ok: false; status: number; message: string }
/** A /api/v1 call the companion keeps for itself: run here only when its copy cannot answer it (companionKeepsNot). */
export interface KeptCall { ok: 'kept'; method: string; rel: string; path: string; pathname: string; kept: string }

/**
 * The one check both of this Mac's doors run on a forwarded call before anything runs
 * (target.ts for a server.http frame, stream-door.ts for a stream): a /api/v1 call the
 * companion does not keep for itself, or keeps but cannot answer (companionKeepsNot); one
 * of the console's task-store writes, exactly as listed (policy.ts CONSOLE_TASK_WRITES); or
 * one of its calls about what the companion's copy does not keep (CONSOLE_COPY_READS and
 * CONSOLE_COPY_WRITES). `path` is the path and query to run, `rel` what isTaskCopyWrite reads.
 *
 * In two steps, so a stream's refusal goes out before its parser reads on: what the call
 * itself says (checkForwardCall, synchronous), then, for a kept call only, the config
 * (settleKeptCall). checkForwardTarget runs both.
 */
export function checkForwardCall(method: unknown, url: unknown): Checked | KeptCall {
  const m = typeof method === 'string' ? method.toUpperCase() : ''
  if (!FORWARD_METHODS.has(m)) return { ok: false, status: 405, message: 'Unsupported method' }
  const v1 = parseForwardUrl(url)
  const parsed = v1 ?? parseConsoleTaskWrite(m, url) ?? parseConsoleCopyCall(m, url)
  if (!parsed) return { ok: false, status: 400, message: 'Invalid forwarded path' }
  const path = `${parsed.pathname}${parsed.search}`
  const kept = v1 ? companionAnswers(m, v1.rel) : null
  if (kept) return { ok: 'kept', method: m, rel: parsed.rel, path, pathname: parsed.pathname, kept }
  return { ok: true, path, rel: parsed.rel }
}

export async function settleKeptCall(k: KeptCall): Promise<Checked> {
  if (!(await companionKeepsNot(k.method, k.rel))) return { ok: false, status: 400, message: `The companion answers ${k.pathname} itself (${k.kept})` }
  return { ok: true, path: k.path, rel: k.rel }
}

export async function checkForwardTarget(method: unknown, url: unknown): Promise<Checked> {
  const c = checkForwardCall(method, url)
  return c.ok === 'kept' ? settleKeptCall(c) : c
}

/**
 * Run one forwarded call. `relayOrigin` is who the relay acts for (the cloud
 * bridge: remote-http); the call never acts above a client off this Mac.
 */
export async function runForwardedCall(params: Record<string, unknown>, relayOrigin?: string): Promise<ForwardReply> {
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : ''
  const url = await checkForwardTarget(method, params.url)
  if (!url.ok) throw refuse(url.message, url.status)
  const body = decodeBody(params.data, params.size)
  if ((method === 'GET' || method === 'HEAD') && body.byteLength > 0) throw refuse(`${method} cannot have a body`)
  const root = getSelfApiRoot()
  if (!root) throw refuse('This server is not listening yet', 503)

  const headers = { ...forwardRequestHeaders(params.headers), [ORIGIN_HEADER]: lowerOrigin(REMOTE_HTTP_ORIGIN, relayOrigin) }
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? Math.min(params.timeoutMs, FORWARD_TARGET_TIMEOUT_MS) : FORWARD_TARGET_TIMEOUT_MS
  let response: Response
  try {
    response = await fetch(new URL(url.path, root), {
      method,
      headers,
      ...(body.byteLength > 0 ? { body: body as unknown as BodyInit } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new ForwardError(timedOut ? 'The route did not answer in time' : `The route could not be reached: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 504 : 502, 'forward_failed')
  }
  let content: Buffer | null
  try {
    content = await readUpTo(response, MAX_FORWARD_RESPONSE_BYTES)
  } catch (err) {
    throw new ForwardError(`The reply broke off: ${err instanceof Error ? err.message : String(err)}`, 502, 'forward_failed')
  }
  noteForwardedTaskWrite(method, url.rel, response.status)
  const replyHeaders = forwardResponseHeaders(Object.fromEntries(response.headers.entries()))
  if (content === null) return { status: response.status, headers: replyHeaders, size: MAX_FORWARD_RESPONSE_BYTES + 1, tooLarge: true }
  return { status: response.status, headers: replyHeaders, size: content.byteLength, data: content.toString('base64') }
}
