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
export function walnutApiEnvForSession(host: string | null | undefined): Record<string, string> {
  if (host && host !== '__local__') return {}
  return selfApiRoot ? { OPEN_WALNUT_API_URL: selfApiRoot } : {}
}
