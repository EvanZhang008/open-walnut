/**
 * The API root of the Walnut server running in THIS process, once it listens.
 *
 * Why this exists: every Walnut op client (`walnut tools call`, the MCP server,
 * the in-server op executor) resolves its target from OPEN_WALNUT_API_URL and
 * falls back to http://127.0.0.1:3456, the production port. A server on any
 * other port (an ephemeral test server, the Playwright fixture, a vitest server
 * on port 0) therefore sent its own ops, and the `walnut` calls of every session
 * it launched, to the user's real Walnut. Measured 2026-09-23: a task created by
 * a session of a `web --ephemeral` server landed on :3456.
 *
 * The rule this module carries: a server's own ops and every LOCAL session it
 * launches talk to that server. server.ts sets it at listen and clears it at
 * stop; the session spawners read it to inject OPEN_WALNUT_API_URL.
 * No imports on purpose: the executor, the CLI and the providers all use it.
 */

let selfApiRoot: string | null = null
let selfCallAuth = false

/**
 * `credential`: this server's own op calls must prove themselves (a cloud-mode
 * server, which has no loopback waiver). Off, they stay as they always were:
 * loopback-trusted and carrying no Authorization header, which some routes
 * read to tell who the caller is (routes/devices.ts).
 */
export function setSelfApiRoot(root: string | null, opts: { credential?: boolean } = {}): void {
  selfApiRoot = root
  selfCallAuth = root !== null && opts.credential === true
  endSelfApiStarting()
}

/**
 * The server in this process holds its port and will listen on it soon (server.ts, from the
 * port hold to listen). In between, a call to its own API meets the hold, which cuts every
 * connection (port-hold.ts): the call reads as lost. The local daemon connects about a second
 * before listen and hands over the relays its sessions sent while the server restarted, so each
 * deploy answered them `hub_timeout` (2026-11-22: 3 or so per restart, the top of the
 * "gateway relay refused" log spike). Work that arrives from outside in that window waits for
 * the listen first (whenSelfApiListening).
 */
let starting: { done: Promise<void>; end: () => void } | null = null

/** server.ts: the port is held and listen comes next. */
export function markSelfApiStarting(): void {
  if (starting) return
  let end!: () => void
  const done = new Promise<void>((resolve) => { end = resolve })
  starting = { done, end }
}

/** The listen happened (setSelfApiRoot) or the server stopped before it (stopServer). */
export function endSelfApiStarting(): void {
  const s = starting
  starting = null
  s?.end()
}

/** Whether a server in this process holds its port and has not listened yet. */
export function selfApiStarting(): boolean {
  return starting !== null
}

/**
 * Wait until the server in this process listens, at most `maxWaitMs`. At once when no server
 * here is starting (it listens already, or this is the CLI). True: nothing is starting now.
 */
export async function whenSelfApiListening(maxWaitMs: number): Promise<boolean> {
  const s = starting
  if (!s) return true
  if (!(maxWaitMs > 0)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    s.done,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); timer.unref?.() }),
  ]).finally(() => clearTimeout(timer))
  return starting === null
}

/** Null outside a listening server (the CLI, the MCP child, unit tests). */
export function getSelfApiRoot(): string | null {
  return selfApiRoot
}

let selfCallToken: string | null = null

/** 32 random bytes, hex: the shape of every credential this process mints for itself. */
function mintToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time equality of a presented token with one this process holds. */
function sameToken(mine: string | null, token: string): boolean {
  if (!mine || token.length !== mine.length) return false
  let diff = 0
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

/**
 * The credential this server's own op calls carry to its own root. A cloud-mode
 * server has no loopback waiver, so before this every op it ran on itself (the
 * backup leader's gateway, an action card) was refused with 401 (2026-10-06).
 * It lives in this process's memory only: never in env, never given to a session.
 * Null outside a listening server, and in one that did not ask for it.
 */
export function getSelfCallToken(): string | null {
  if (!selfApiRoot || !selfCallAuth) return null
  selfCallToken ??= mintToken()
  return selfCallToken
}

/** Whether `token` is this server's own self-call credential (constant time). */
export function isSelfCallToken(token: string): boolean {
  return sameToken(selfApiRoot && selfCallAuth ? selfCallToken : null, token)
}

/**
 * The credential of a model helper this server spawns with a shell (the AI search child,
 * core/task-search-agent.ts): its prompt tells it to curl this server's own API, and a host
 * replica or the companion trusts no loopback caller, so a curl with none was refused 401 and
 * AI search found nothing there while the Mac was away (2026-11-24).
 *
 * Not the self-call token: a helper is a model with a shell, so what it is given may be read
 * back by it. This one only READS the paths in HELPER_CALL_PATHS (auth.ts refuses it anywhere
 * else), it lives in this process's memory and in the env of the helpers it spawns
 * (walnutHelperEnv), never on a command line or in a prompt (the prompt names the variable),
 * and it is the same in every role, so a helper reaches its own Walnut on the leader as on
 * a replica. Null outside a listening server.
 */
let helperCallToken: string | null = null

/** The env variable a helper's shell reads the credential from. */
export const HELPER_CALL_TOKEN_ENV = 'WALNUT_HELPER_TOKEN'

/** The curl arguments a helper's prompt adds to every call of its own Walnut. */
export const HELPER_CALL_CURL_AUTH = `-H "Authorization: Bearer $${HELPER_CALL_TOKEN_ENV}"`

/** Every route a helper reads (GET and HEAD only), the whole path. Add one only with the helper that needs it. */
export const HELPER_CALL_PATHS: readonly string[] = ['/api/search']

/** The CLI tools that give a model a shell, and so the need to reach Walnut by HTTP. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export function getHelperCallToken(): string | null {
  if (!selfApiRoot) return null
  helperCallToken ??= mintToken()
  return helperCallToken
}

/** Whether `token` is this server's helper credential (constant time). */
export function isHelperCallToken(token: string): boolean {
  return sameToken(selfApiRoot ? helperCallToken : null, token)
}

/** Whether a request with the helper credential may be answered: a read of a helper's path. */
export function helperCallAllowed(method: string | undefined, fullPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const p = fullPath.length > 1 ? fullPath.replace(/\/+$/, '') : fullPath
  return HELPER_CALL_PATHS.includes(p)
}

/** The one answer to a helper credential outside HELPER_CALL_PATHS (403): auth.ts and a replica's dispatcher. */
export const HELPER_SCOPE_REFUSAL = Object.freeze({ error: 'A helper credential reads search only', code: 'helper_scope' })

/**
 * The ONE place a model helper this server spawns gets its Walnut (inline-subagent.ts and
 * micro-claude-warm.ts build every such child's env through it): this server's own root, and,
 * for a child with a shell tool, the helper credential. A child with no shell gets none, not
 * even one its env inherited.
 */
export function applyWalnutHelperEnv(env: NodeJS.ProcessEnv, tools: readonly string[] = []): void {
  Object.assign(env, walnutApiEnvForSession('__local__'))
  delete env[HELPER_CALL_TOKEN_ENV]
  const token = tools.some((t) => SHELL_TOOLS.has(t)) ? getHelperCallToken() : null
  if (token) env[HELPER_CALL_TOKEN_ENV] = token
}

/**
 * Env a session needs so its in-session `walnut` / MCP calls reach the server
 * that launched it. Local sessions only: 127.0.0.1 on a remote host is that
 * host, not this server, and remote sessions reach Walnut through the daemon
 * gateway instead. Empty when no server is listening in this process.
 */
export function demoApiHeaders(url: string | URL): Record<string, string> {
  const generation = process.env.WALNUT_DEMO_GENERATION
  if (!generation) return {}
  try {
    return new URL(url).origin === 'http://127.0.0.1:3458' ? { 'x-walnut-demo-generation': generation } : {}
  } catch { return {} }
}

export function walnutApiEnvForSession(host: string | null | undefined): Record<string, string> {
  if (host && host !== '__local__') return {}
  return selfApiRoot ? { OPEN_WALNUT_API_URL: selfApiRoot } : {}
}

/** Where an op client sends its calls when nothing names a server: production's port. */
export const DEFAULT_WALNUT_API_ROOT = 'http://127.0.0.1:3456'

/** How the address was found: this server's own, the caller's, the env's, or the default. */
export type WalnutApiSource = 'self' | 'given' | 'env' | 'default'

/**
 * The ONE answer to "which Walnut does this process talk to" (the CLI's HTTP client, the op
 * executor, the MCP tools, a trigger check). In order: an address the caller names, a listening
 * server's own root (`ownServer: false` skips it: a check reads only the env it was given),
 * OPEN_WALNUT_API_URL (then `alsoEnv`, e.g. WALNUT_SERVER_URL for a trigger check), and only
 * then the default. The root carries no trailing slash and no `/api/v1` (OPEN_WALNUT_API_URL
 * may name either form).
 */
export function walnutApiTarget(opts: { given?: string; env?: NodeJS.ProcessEnv; alsoEnv?: readonly string[]; ownServer?: boolean } = {}): { root: string; source: WalnutApiSource } {
  const env = opts.env ?? process.env
  const clean = (raw: string) => raw.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  if (opts.given?.trim()) return { root: clean(opts.given), source: 'given' }
  if (selfApiRoot && opts.ownServer !== false) return { root: clean(selfApiRoot), source: 'self' }
  for (const key of ['OPEN_WALNUT_API_URL', ...(opts.alsoEnv ?? [])]) {
    const v = env[key]?.trim()
    if (v) return { root: clean(v), source: 'env' }
  }
  return { root: DEFAULT_WALNUT_API_ROOT, source: 'default' }
}

/**
 * The words an "unreachable" error adds when the address it tried is only the default, so a
 * caller never mistakes it for its own server's (a session of a Walnut on another port that
 * was told no address read "server not running at :3456" and nothing more, 2026-11-20).
 */
export function defaultAddressNote(base: string, env: NodeJS.ProcessEnv = process.env): string {
  if (selfApiRoot || env.OPEN_WALNUT_API_URL?.trim()) return ''
  if (base.replace(/\/+$/, '').replace(/\/api\/v1$/, '') !== DEFAULT_WALNUT_API_ROOT) return ''
  return ' (no OPEN_WALNUT_API_URL in this process, so this is only the default address; a Walnut on another port must be named with OPEN_WALNUT_API_URL)'
}
