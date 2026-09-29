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
 */

import fs from 'node:fs'

/**
 * Hand the call to this session's host daemon. Returns the exit code, or null
 * when there is no daemon to ask (then the caller reports its own error).
 */
export async function callThroughHostDaemon(
  name: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  const socket = (env.WALNUT_AGENT_SOCKET ?? '').trim()
  const sid = (env.WALNUT_SESSION_ID ?? '').trim()
  if (!socket || !sid) return null
  try {
    if (!fs.statSync(socket).isSocket()) return null
  } catch {
    return null
  }
  process.stderr.write('walnut: the Walnut server is not reachable; asking this host\'s daemon instead.\n')
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', name, JSON.stringify(args ?? {})])
}
