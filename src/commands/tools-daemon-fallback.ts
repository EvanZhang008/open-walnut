/**
 * `walnut tools call` inside a session when the Walnut server cannot be reached.
 *
 * On the Mac, a session's `walnut` is this installed CLI, which talks to the
 * server over HTTP; the daemon's own `walnut` (the gateway shim) is only first on
 * PATH on hosts without an install. So while the server restarts, a Mac session
 * got "server not running" even though its host daemon answers offline
 * (docs/plan/daemon-first-hosts.md). The daemon injects WALNUT_AGENT_SOCKET and
 * WALNUT_SESSION_ID into every session it spawns: when both are there, the same
 * call goes through that socket, exactly as the shim would send it.
 *
 * Only on an unreachable server: a server that answered (even with an error) is
 * the authority, and a call from outside a session has no daemon to ask.
 *
 * The same socket is also how a Mac session reaches a PLUGIN op at all: this
 * process loads core ops only, and a plugin declares its ops inside the server.
 */

import fs from 'node:fs'

/** True when this process runs inside a managed session whose host daemon is listening. */
function hasHostDaemon(env: NodeJS.ProcessEnv): boolean {
  const socket = (env.WALNUT_AGENT_SOCKET ?? '').trim()
  const sid = (env.WALNUT_SESSION_ID ?? '').trim()
  if (!socket || !sid) return false
  try {
    return fs.statSync(socket).isSocket()
  } catch {
    return false
  }
}

/**
 * Hand the call to this session's host daemon. Returns the exit code, or null
 * when there is no daemon to ask (then the caller reports its own error).
 */
export async function callThroughHostDaemon(
  name: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  if (!hasHostDaemon(env)) return null
  process.stderr.write('walnut: the Walnut server is not reachable; asking this host\'s daemon instead.\n')
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', name, JSON.stringify(args ?? {})])
}

/**
 * `walnut tools call <op> ...` for an op this process does not know: a plugin
 * declared it, so it exists only in the server process. The host daemon's
 * gateway runs it there under this session's id, the same path a remote host
 * takes. `argv` is everything after `call`, untouched, so @file and stdin
 * payloads work as they do for the daemon's own shim. Null outside a session.
 */
export async function callServerOpThroughHostDaemon(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  if (!hasHostDaemon(env)) return null
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', ...argv])
}
