/**
 * The names the real-use monitor keeps, and only from fixed sets: a registered op's name, the
 * route template Express matched, an error code of the fixed identifier shape, an error type
 * from a short list, and the name of a built code chunk. Never content: no argument, answer,
 * message, path segment, file name or stack.
 */
import { base, simpleCommands, unwrap } from './shell-words.js'

/** An error code an API or the gateway answered: a short identifier, never free text. */
const CODE_RE = /^[a-z][a-z0-9_]{0,47}$/

export function safeCode(code: unknown): string | undefined {
  return typeof code === 'string' && CODE_RE.test(code) ? code : undefined
}

/** A mount segment shaped like an id: a long word with three or more digits (`rq-b83e9eb1dd8d`), or a uuid. `notes-v2` is not. */
const ID_SEGMENT_RE = /^(?=(?:[^\d]*\d){3})[A-Za-z0-9_-]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{14,}$/i

/** The route template Express matched (`/api/tasks/:id`), or `unmatched`. Never the URL itself. */
export function registeredTemplate(baseUrl: unknown, routePath: unknown): string {
  if (typeof routePath !== 'string' || !routePath) return 'unmatched'
  // The mount path is the URL's own (Express keeps no template for it): a router mounted under a
  // parameter (`/api/plugins/:pluginId`) shows the value there. A segment shaped like an id
  // (digits in a long word, a uuid) becomes `:id`, so no id is kept and names stay few.
  const base = (typeof baseUrl === 'string' ? baseUrl : '').split('/').map((seg) => (ID_SEGMENT_RE.test(seg) ? ':id' : seg)).join('/')
  const full = `${base}${routePath === '/' && base ? '' : routePath}`
  // A template is made of literal words and `:params`; anything else (a regex route) is not kept.
  return /^[A-Za-z0-9_\-/:.*]{1,160}$/.test(full) ? full : 'unmatched'
}

/** A query that asks the server to hold the answer on purpose (a long poll): never a slow read. */
const WAIT_QUERY_RE = /[?&](?:wait|wait_ms|waitMs|wait_for|timeout_ms|long_poll|follow)=/i

export function isLongPoll(url: string): boolean {
  return WAIT_QUERY_RE.test(url) || /\/(?:wait|events|stream)(?:\/|$)/.test(url.split('?')[0] ?? '')
}

/**
 * The route templates this server answered, for naming a request a page says failed: a path is
 * kept only as a template it matches, never as itself.
 */
export class TemplateMatcher {
  private readonly seen = new Map<string, RegExp>()

  add(method: string, template: string): void {
    if (template === 'unmatched' || this.seen.size >= 2_000) return
    const key = `${method} ${template}`
    if (this.seen.has(key)) return
    const pattern = template.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')
    this.seen.set(key, new RegExp(`^${pattern}/?$`))
  }

  /** `GET /api/tasks/:id` for `GET /api/tasks/abc?x=1`, or null when no answered template matches. */
  match(method: string, url: string): string | null {
    const path = url.split('?')[0] ?? ''
    let best: string | null = null
    for (const [key, re] of this.seen) {
      if (!key.startsWith(`${method} `) || !re.test(path)) continue
      // The most literal template wins (`/api/tasks/search` over `/api/tasks/:id`).
      if (!best || literalCount(key) > literalCount(best)) best = key
    }
    return best
  }
}

function literalCount(key: string): number {
  return key.split('/').filter((s) => s && !s.startsWith(':')).length
}

const ERROR_TYPES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'ChunkLoadError', 'AbortError', 'NotFoundError', 'SecurityError', 'QuotaExceededError', 'InvalidStateError', 'NotAllowedError', 'Error'])

/** The built chunk a stack frame or file names (`/assets/ThreadCard-AbC123xy.js` → `ThreadCard`), else null. */
function chunkOf(text: string): string | null {
  const m = /\/assets\/([A-Za-z][A-Za-z0-9_]{0,40})-[A-Za-z0-9_-]{6,12}\.js/.exec(text)
  return m ? m[1]! : null
}

function errorTypeOf(text: string): string {
  const m = /\b([A-Z][A-Za-z]{2,30}Error|Error)\b/.exec(text)
  return m && ERROR_TYPES.has(m[1]!) ? m[1]! : 'Other'
}

/** The web client's own line for a request that failed in the page (web/src/api/client.ts). */
const CLIENT_FAIL_RE = /^\[api\] (GET|POST|PUT|PATCH|DELETE) (\S+) (FAILED|rejected)\b(.*)$/

export interface PageErrorKind {
  /** The kind's name, from fixed parts only. */
  kind: string
  /** The request template a failed request names (for skipping a cause its route already rang). */
  route?: string
  /** A failed or timed-out request (true), or a thrown error in the page (false). */
  request: boolean
}

/**
 * A page's error line as a kind, or null when it is neither a failed request nor an uncaught
 * error (an app's own console.error stays only in the log).
 */
export function pageErrorKind(message: string, args: string | undefined, templates: TemplateMatcher): PageErrorKind | null {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  const fail = CLIENT_FAIL_RE.exec(text)
  if (fail) {
    const how = fail[3] === 'rejected' ? 'rejected' : /time(?:d)? ?out|timeout/i.test(fail[4] ?? '') ? 'timed out' : 'failed'
    const route = templates.match(fail[1]!, fail[2]!)
    return route
      ? { kind: `${route} ${how} in the page`, route, request: true }
      : { kind: `${fail[1]} unknown request ${how} in the page`, request: true }
  }
  if (!text.startsWith('[uncaught]') && !text.startsWith('[unhandledrejection]')) return null
  const all = `${text} ${String(args ?? '').slice(0, 2_000)}`
  const type = errorTypeOf(all)
  const chunk = chunkOf(all)
  return { kind: `${type} in the ${chunk ?? 'unknown'} chunk`, request: false }
}

/**
 * Claude Code's own note that it cut a tool's answer to a file: the characters it held, or 0
 * when the note names none. null when the text is not such a note.
 *  - MCP: `Error: result (27,446 characters across 178 lines) exceeds maximum allowed tokens.`
 *  - Bash: `<persisted-output> Output too large (22.1KB). Full output saved to: ...`
 */
export function agentCutChars(result: string): number | null {
  // Only the note itself, at the start of the result: an answer that quotes such a note (a
  // task_history or search reading another session) is not a cut.
  const head = String(result ?? '').slice(0, 600).replace(/^\s*(?:<error>|<tool_use_error>)?\s*/, '')
  const mcp = /^(?:Error: )?result \(([\d,]+) characters[^)\n]*\) exceeds maximum allowed tokens/.exec(head)
  if (mcp) return Number(mcp[1]!.replace(/,/g, ''))
  const bash = /^<persisted-output>\s*Output too large \(([\d.]+)(KB|MB)\)\. Full output saved to/.exec(head)
  if (bash) return Math.round(Number(bash[1]) * (bash[2] === 'MB' ? 1024 * 1024 : 1024))
  if (/^(?:Error: |MCP tool )[^\n]{0,160}exceeds maximum allowed tokens/.test(head)) return 0
  return null
}

/** The Walnut op a tool call names: `mcp__walnut__task_get`, or a Bash line running `walnut tools call task_get`. */
export function walnutOpOfToolCall(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const mcp = /^mcp__walnut__([a-z][a-z0-9_]*)$/.exec(toolName)
  if (mcp) return mcp[1]!
  if (toolName !== 'Bash') return null
  const command = typeof input?.command === 'string' ? input.command : ''
  // The command the line runs, never a word it reads (`grep "walnut tools call x"`).
  for (const words of simpleCommands(command)) {
    const w = unwrap(words)
    if (base(w[0]) === 'walnut' && w[1] === 'tools' && w[2] === 'call' && /^[a-z][a-z0-9_]*$/.test(w[3] ?? '')) return w[3]!
  }
  return null
}

/** How a failed op call ended, from what the op answered (executor.ts OpOutcome). */
export function failureClass(r: { invalidArgs?: boolean; unreachable?: boolean; lost?: boolean; status?: number; code?: string; result?: unknown }): { cls: 'refused' | 'bad_args' | 'error' | 'timeout' | 'unreachable'; code: string } {
  const code = safeCode(r.code)
  if (r.invalidArgs) return { cls: 'bad_args', code: code ?? 'invalid_args' }
  if (r.unreachable) return { cls: 'unreachable', code: code ?? 'unreachable' }
  if (r.lost) return { cls: 'timeout', code: code ?? 'lost' }
  const s = r.status
  if (typeof s === 'number') {
    const c = code ?? `http_${s}`
    if (s === 408 || s === 504) return { cls: 'timeout', code: c }
    if (s === 502 || s === 503) return { cls: 'unreachable', code: c }
    if (s >= 500) return { cls: s === 501 || s === 507 ? 'refused' : 'error', code: c }
    if (s === 400 || s === 422) return { cls: 'bad_args', code: c }
    return { cls: 'refused', code: c }
  }
  // A handler's own answer (resultError) carries its result: a refusal. A throw carries none.
  return r.result !== undefined || code ? { cls: 'refused', code: code ?? 'refused' } : { cls: 'error', code: 'thrown' }
}
