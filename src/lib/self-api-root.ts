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

export function setSelfApiRoot(root: string | null): void {
  selfApiRoot = root
}

/** Null outside a listening server (the CLI, the MCP child, unit tests). */
export function getSelfApiRoot(): string | null {
  return selfApiRoot
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
