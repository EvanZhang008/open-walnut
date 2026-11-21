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
}

/** Null outside a listening server (the CLI, the MCP child, unit tests). */
export function getSelfApiRoot(): string | null {
  return selfApiRoot
}

let selfCallToken: string | null = null

/**
 * The credential this server's own op calls carry to its own root. A cloud-mode
 * server has no loopback waiver, so before this every op it ran on itself (the
 * backup leader's gateway, an action card) was refused with 401 (2026-10-06).
 * It lives in this process's memory only: never in env, never given to a session.
 * Null outside a listening server, and in one that did not ask for it.
 */
export function getSelfCallToken(): string | null {
  if (!selfApiRoot || !selfCallAuth) return null
  if (!selfCallToken) {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    selfCallToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return selfCallToken
}

/** Whether `token` is this server's own self-call credential (constant time). */
export function isSelfCallToken(token: string): boolean {
  const mine = selfApiRoot && selfCallAuth ? selfCallToken : null
  if (!mine || token.length !== mine.length) return false
  let diff = 0
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
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
