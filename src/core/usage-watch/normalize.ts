/**
 * The names the real-use monitor keeps, and only from fixed sets: a registered op's name, the
 * route template Express matched, an error code of the fixed identifier shape, an error type
 * from a short list, and the name of a built code chunk. Never content: no argument, answer,
 * message, path segment, file name or stack.
 */
import { base, shellCommands, unwrap, type ShellCommand } from './shell-words.js'

/** An error code an API or the gateway answered: a short identifier, never free text. */
const CODE_RE = /^[a-z][a-z0-9_]{0,47}$/

export function safeCode(code: unknown): string | undefined {
  return typeof code === 'string' && CODE_RE.test(code) ? code : undefined
}

/** A mount segment shaped like an id: a long word with three or more digits (`rq-b83e9eb1dd8d`), or a uuid. `notes-v2` is not. */
const ID_SEGMENT_RE = /^(?=(?:[^\d]*\d){3})[A-Za-z0-9_-]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{14,}$/i

/** A path segment shaped like an id (ID_SEGMENT_RE): the recorder never keeps one in a name. */
export function looksLikeId(seg: string): boolean {
  return ID_SEGMENT_RE.test(seg)
}

/** The route template Express matched (`/api/tasks/:id`), or `unmatched`. Never the URL itself. */
export function registeredTemplate(baseUrl: unknown, routePath: unknown): string {
  if (typeof routePath !== 'string' || !routePath) return 'unmatched'
  // The mount path is the URL's own (Express keeps no template for it): a router mounted under a
  // parameter (`/api/plugins/:pluginId`) shows the value there. A segment shaped like an id
  // (digits in a long word, a uuid) becomes `:id`, so no id is kept and names stay few.
  const base = (typeof baseUrl === 'string' ? baseUrl : '').split('/').map((seg) => (looksLikeId(seg) ? ':id' : seg)).join('/')
  const full = `${base}${routePath === '/' && base ? '' : routePath}`
  // A template is made of literal words and `:params`; anything else (a regex route) is not kept.
  return /^[A-Za-z0-9_\-/:.*]{1,160}$/.test(full) ? full : 'unmatched'
}

/**
 * The route template a request is named by, on the path its client called (`originalUrl`).
 * Express builds `baseUrl` from the path the routers saw, which a rewrite changes: the calendar
 * alias (web/routes/calendar-alias.ts) hands `/api/calendar/events` to the plugin dispatcher as
 * `/calendar/events`, and it was named `/api/calendar/calendar/events` (2026-11-24: one call in a
 * week, under a name no caller uses). The route's own path is the tail of both, so the name is
 * the called path's head and the route's path. A route path whose parts do not line up one to one
 * with the URL's segments (a wildcard, an optional part) keeps the routers' name.
 */
export function publicTemplate(originalUrl: unknown, baseUrl: unknown, routePath: unknown): string {
  const seen = registeredTemplate(baseUrl, routePath)
  if (seen === 'unmatched' || typeof originalUrl !== 'string' || typeof routePath !== 'string' || /[*?{}()]/.test(routePath)) return seen
  const called = (originalUrl.split('?')[0] ?? '').replace(/\/+$/, '').split('/')
  const tail = routePath.replace(/\/+$/, '').split('/').slice(1)
  if (called.length - 1 < tail.length) return seen
  return registeredTemplate(called.slice(0, called.length - tail.length).join('/'), routePath)
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
  private resolver: ((method: string, url: string) => string | null) | null = null

  /** The server's own router, asked when no answered template matches (a request that never reached it). */
  resolveWith(fn: ((method: string, url: string) => string | null) | null): void {
    this.resolver = fn
  }

  add(method: string, template: string): void {
    if (template === 'unmatched' || this.seen.size >= 2_000) return
    const key = `${method} ${template}`
    if (this.seen.has(key)) return
    const pattern = template.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')
    this.seen.set(key, new RegExp(`^${pattern}/?$`))
  }

  /** `GET /api/tasks/:id` for `GET /api/tasks/abc?x=1`, or null when neither an answered template nor the router matches. */
  match(method: string, url: string): string | null {
    const path = url.split('?')[0] ?? ''
    let best: string | null = null
    for (const [key, re] of this.seen) {
      if (!key.startsWith(`${method} `) || !re.test(path)) continue
      // The most literal template wins (`/api/tasks/search` over `/api/tasks/:id`).
      if (!best || literalCount(key) > literalCount(best)) best = key
    }
    if (best || !this.resolver) return best
    try { return this.resolver(method, url) } catch { return null }
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

/**
 * Error lines the browser makes itself, with no stack or file to place them, by a name of their own.
 * A ResizeObserver loop is a callback that changed a watched box's size inside the observer's own
 * delivery (Chromium's older words: "loop limit exceeded"); "Script error." is any error from a
 * script of another origin, whose details the browser hides.
 */
const BROWSER_ERRORS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /^\[uncaught\] ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/, kind: 'ResizeObserver loop in the page' },
  { re: /^\[uncaught\] (?:Uncaught )?Script error\.?$/, kind: 'Script error from another origin' },
]

/** The web client's own line for a request that failed in the page (web/src/api/client.ts). */
const CLIENT_FAIL_RE = /^\[api\] (GET|POST|PUT|PATCH|DELETE) (\S+) (FAILED|rejected)\b(.*)$/

export interface PageErrorKind {
  /** The kind's name, from fixed parts only. */
  kind: string
  /** The request template a failed request names (for skipping a cause its route already rang). */
  route?: string
  /** A failed or timed-out request (true), or a thrown error in the page (false). */
  request: boolean
  /**
   * How a request went wrong: `rejected` (the page's connection queue gave up; never sent),
   * `failed` (a network error: it never reached the server), `timed out`, or `refused` (the
   * browser would not send it: a fault of the page itself).
   */
  how?: PageRequestHow
}

export type PageRequestHow = 'rejected' | 'failed' | 'timed out' | 'refused'

/** A fetch that threw for the network (Chromium, WebKit, Firefox), not for the request itself. */
const NETWORK_ERROR_RE = /Failed to fetch|Load failed|NetworkError|network connection was lost|Could not connect|ERR_[A-Z_]{4,}/i

/**
 * How a request can go wrong on its way, as pageErrorKind names it: never the page's own error, and
 * never rung alone (usage-watch/record.ts recordPageError). Ratchet: tests/core/usage-watch/usage-watch.test.ts.
 */
export const PAGE_REQUEST_HOWS = ['failed', 'rejected', 'timed out'] as const
type OnTheWay = (typeof PAGE_REQUEST_HOWS)[number]

/** A page kind of a request that went wrong on its way, as pageErrorKind writes it: its route, then how. */
const PAGE_REQUEST_KIND_RE = new RegExp(`^((?:GET|POST|PUT|PATCH|DELETE) (?:/\\S*|unknown request)) (${PAGE_REQUEST_HOWS.join('|')}) in the page$`)

/**
 * The request a page kind names when it went wrong on its way, with how: its route's template
 * (`GET /api/sessions/:sessionId/supervision`, or `GET unknown request`), else null (an error thrown
 * in the page, or a request the browser itself refused to send: the page's own).
 */
export function pageRequestOf(kind: string): { route: string; how: OnTheWay } | null {
  const m = PAGE_REQUEST_KIND_RE.exec(kind)
  return m ? { route: m[1]!, how: m[2] as OnTheWay } : null
}

/**
 * Whether a page kind is the page's own failure: an error thrown in the page, or a request the
 * browser itself refused to send. A request that went wrong on its way never is: one that failed for
 * the network never reached the server (a deploy restart, sleep, the network), one the page's queue
 * rejected was never sent, and one that timed out waited on its route, its server or the way
 * between them (2026-11-24: 253 restart failures on the session page; then supervision timeouts in
 * the minutes its server read slowly, four servers timeouts on a server being replaced for a deploy,
 * which never recorded them, and a notes list the server answered in 24 ms that the page waited 15 s
 * for, failed the page watches of tasks that changed only how controls look).
 */
export function pageKindIsPagesOwn(kind: string): boolean {
  return pageRequestOf(kind) === null
}

/**
 * A page's error line as a kind, or null when it is neither a failed request nor an uncaught
 * error (an app's own console.error stays only in the log).
 */
export function pageErrorKind(message: string, args: string | undefined, templates: TemplateMatcher): PageErrorKind | null {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  const fail = CLIENT_FAIL_RE.exec(text)
  if (fail) {
    // A request held in the page's queue, or out on the network, while the page was in the
    // background (leaving it, or a hidden window whose timers and answers ran late) never was a
    // problem (web/src/api/client.ts names both).
    if (/\(.*\bpage (?:suspended|hidden)\)$/.test(fail[4] ?? '')) return null
    // A fetch that threw with no network error in its error text was refused by the browser itself
    // (an invalid header, a GET with a body): with no error text at all it reads as the network's.
    const err = String(args ?? '')
    const how: PageRequestHow = fail[3] === 'rejected' ? 'rejected'
      : /time(?:d)? ?out|timeout/i.test(fail[4] ?? '') ? 'timed out'
        : !err.trim() || NETWORK_ERROR_RE.test(err) ? 'failed' : 'refused'
    const words = how === 'refused' ? 'refused by the browser' : `${how} in the page`
    const route = templates.match(fail[1]!, fail[2]!)
    return route
      ? { kind: `${route} ${words}`, route, request: true, how }
      : { kind: `${fail[1]} unknown request ${words}`, request: true, how }
  }
  if (!text.startsWith('[uncaught]') && !text.startsWith('[unhandledrejection]')) return null
  // Errors the browser itself raises carry no stack and no file, so they would all read as
  // "Other in the unknown chunk" (2026-11-23: 43 ResizeObserver loops in a day, by that name).
  const own = BROWSER_ERRORS.find((b) => b.re.test(text))
  if (own) return { kind: own.kind, request: false }
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
  return walnutToolCall(toolName, input)?.op ?? null
}

/**
 * The Walnut op a tool call names, and whether what its agent reads back can be that op's answer
 * (`answered`): not when the caller asked for the whole answer (`_full`), nor when the walnut
 * call's output went to a file, into another program or into a word of another command (`o=$(walnut
 * ...)`), nor when another command of the line prints on its own, so the saved output is not the
 * answer alone. 2026-11-23: `walnut tools call task_history '{..}' > /tmp/x 2>&1; python3 - <<EOF`
 * printed 16 KB from the python, and it was counted as task_history's answer cut. 2026-11-24:
 * `o=$(walnut tools call host_copy_result ..); ...; tar -xzf .. && ls ..; grep -rn .. | head` printed
 * 19 KB of file names and log lines around a 521-byte answer, and rang host_copy_result's cut alarm.
 */
export function walnutToolCall(toolName: string, input: Record<string, unknown> | undefined): { op: string; answered: boolean } | null {
  const mcp = /^mcp__walnut__([a-z][a-z0-9_]*)$/.exec(toolName)
  if (mcp) return { op: mcp[1]!, answered: input?._full !== true }
  if (toolName !== 'Bash') return null
  const command = typeof input?.command === 'string' ? input.command : ''
  // The command the line runs, never a word it reads (`grep "walnut tools call x"`).
  const cmds = shellCommands(command)
  const calls = cmds.flatMap((c, i) => {
    const w = unwrap(c.words)
    return base(w[0]) === 'walnut' && w[1] === 'tools' && w[2] === 'call' && /^[a-z][a-z0-9_]*$/.test(w[3] ?? '') ? [{ i, c, w }] : []
  })
  // The call whose output reaches the screen names the line (`id=$(walnut tools call a); walnut
  // tools call b` is b's), else the first.
  const onScreen = (x: (typeof calls)[number]) => !x.c.pipe && !x.c.sub && !sentAway(x.w.slice(4))
  const pick = calls.find(onScreen) ?? calls[0]
  if (!pick) return null
  const full = /"_full"\s*:\s*true/.test(pick.w[4] ?? '')
  const others = cmds.some((c, j) => j !== pick.i && printsOnItsOwn(c))
  return { op: pick.w[3]!, answered: onScreen(pick) && !full && !others }
}

/** `>`, `>>`, `1>`, `&>` send a command's output away; `2>...` and `>&2` leave it on the agent's screen. */
const sentAway = (args: readonly string[]): boolean => args.some((word) => /^(?:1|&)?>>?(?!&2$)/.test(word))

/** Commands that print nothing of their own when they work (a failure's one line is not a cut). */
const QUIET_COMMANDS = new Set([
  'cd', 'pushd', 'popd', 'read', 'pwd', 'date', 'hostname', 'whoami', 'export', 'unset', 'set', 'shopt', 'local', 'declare', 'readonly', 'trap', 'umask',
  'sleep', 'true', 'false', ':', 'source', '.', 'wait', 'test', '[', '[[', 'exit', 'return', 'break', 'continue',
  'shift', 'mkdir', 'rm', 'rmdir', 'cp', 'mv', 'touch', 'chmod', 'chown', 'ln',
  'for', 'case', 'esac', 'done', 'fi', '}', ';;',
])

/**
 * Whether a command of a shell line adds output of its own to what its agent reads: not one whose
 * output goes on (a pipe, a substitution, a file), a quiet command or one that prints a line, a
 * `grep -q`, or an echo of fixed words or the exit status (`|| echo "failed: $?"`); an echo of a
 * variable may print anything.
 */
function printsOnItsOwn(c: ShellCommand): boolean {
  if (c.pipe || c.sub) return false
  const w = unwrap(c.words)
  if (!w.length || QUIET_COMMANDS.has(base(w[0]))) return false
  if (sentAway(w.slice(1))) return false
  if (base(w[0]) === 'echo' || base(w[0]) === 'printf') return w.slice(1).some((x) => /\$(?!\?)/.test(x))
  if (base(w[0]) === 'grep' && w.slice(1).some((x) => /^-[a-zA-Z]*q[a-zA-Z]*$|^--quiet$|^--silent$/.test(x))) return false
  return true
}

/** How a failed op call ended, from what the op answered (executor.ts OpOutcome). */
export function failureClass(r: { invalidArgs?: boolean; unreachable?: boolean; lost?: boolean; status?: number; code?: string; result?: unknown }): { cls: 'refused' | 'bad_args' | 'error' | 'timeout' | 'unreachable'; code: string } {
  const code = safeCode(r.code)
  // Words the reply-language send gate held back (ops/reply-language-gate.ts): a refusal of its own, counted apart from bad arguments.
  if (code === 'reply_language') return { cls: 'refused', code }
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

/**
 * The code of a Walnut CLI failure that opens a shell line's output the shell itself did not fail
 * (session-hook.ts): `walnut tools call ... | head` exits with head's status, so its failure JSON
 * reaches the agent as a success (2026-11-24: the bad_args alarm on usage_watch named calls the
 * error read could not show). Only output that starts with that JSON counts, never one that holds
 * it further down (a log line, a file the command printed).
 */
export function cliFailureCode(result: string): string | null {
  const m = /^\s*\{\s*"ok"\s*:\s*false\s*,\s*"error"\s*:\s*\{\s*"code"\s*:\s*"([a-z][a-z0-9_]{1,40})"/.exec(String(result ?? '').slice(0, 400))
  return safeCode(m?.[1]) ?? null
}

/**
 * The error code of a session's failed Walnut tool call, from the result its agent read
 * (session-hook.ts): the code the CLI's failure JSON names, the `walnut: <code>:` line of the MCP
 * server (with the API's own code in parentheses when it gave one), or what Claude Code itself
 * said before the call reached Walnut (the tool gone, its input refused, the MCP link timed out
 * or closed). A code only, never the text.
 */
export function toolErrorCode(result: string): string {
  const head = String(result ?? '').slice(0, 2_000)
  const word = (m: RegExpExecArray | null): string | undefined => safeCode(m?.[1])
  if (/No such tool available: mcp__/.test(head)) return 'no_such_tool'
  if (/InputValidationError/.test(head)) return 'client_bad_args'
  if (/MCP error -32001|Request timed out/i.test(head)) return 'mcp_timeout'
  if (/MCP error -32000|Connection closed|Not connected|MCP server .{0,60}(?:disconnected|not connected)/i.test(head)) return 'mcp_disconnected'
  if (/Invalid arguments for [a-z_]+:/.test(head)) return 'bad_args'
  const api = word(/Walnut API error \(([a-z][a-z0-9_]{1,40})\)/.exec(head))
  if (api) return api
  const cli = word(/"code"\s*:\s*"([a-z][a-z0-9_]{1,40})"/.exec(head))
  if (cli) return cli
  const mcp = word(/(?:^|\n)\s*walnut: ([a-z][a-z0-9_]{1,40}):/.exec(head))
  if (mcp) return mcp
  // No server answered (2026-11-23 audit: these fell to 'other' and a CLI's 'other' is not counted).
  if (/no answer from the Walnut daemon|agent-gateway\.sock/.test(head)) return 'no_daemon'
  const hub = word(/\b(hub_[a-z_]{3,30})\b/.exec(head))
  if (hub) return hub
  if (/\bserver not running\b/i.test(head)) return 'hub_unreachable'
  if (/command not found|No such file or directory/.test(head)) return 'cli_missing'
  if (/PreToolUse|hook (?:error|blocked)|blocked by (?:a )?hook/i.test(head)) return 'hook_refused'
  if (/doesn't want to proceed|was rejected|Permission .{0,40}denied/i.test(head)) return 'denied'
  return 'other'
}
