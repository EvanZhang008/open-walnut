/**
 * `walnut tools call` inside a session when the Walnut server cannot be reached.
 *
 * On the Mac, a session's `walnut` is this installed CLI, which talks to the
 * server over HTTP; the daemon's own `walnut` (the gateway shim) is first on PATH
 * for every other session (daemon-session-shell.ts walnutThroughGateway). So while
 * the server restarts, a Mac session got "server not running" even though its host daemon answers offline
 * (docs/plan/daemon-first-hosts.md). The daemon injects WALNUT_AGENT_SOCKET and
 * WALNUT_SESSION_ID into every session it spawns: when both are there, the same
 * call goes through that socket, exactly as the shim would send it.
 *
 * Only on an unreachable server: a server that answered (even with an error) is
 * the authority, and a call from outside a session has no daemon to ask. And
 * first, before any HTTP try, in a session its Walnut named no address for
 * (sessionWithoutAddress): the default port may be another Walnut's.
 *
 * The same socket is also how a Mac session reaches a PLUGIN op at all: this
 * process loads core ops only, and a plugin declares its ops inside the server.
 */

import { walnutApiTarget } from '../lib/self-api-root.js'
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
 * A trigger check's call to a task-only host op (lib/task-host-ops.ts), handed to the daemon that
 * runs the check (WALNUT_CHECK_TOKEN and WALNUT_CHECK_SOCKET, trigger-check-core.ts checkCallers):
 * it says which trigger the call came from, so the call acts for that trigger's task. Null outside
 * a check (a session's own id always wins), or when that daemon's socket is gone.
 */
export async function callThroughCheckDaemon(
  name: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts: { json?: boolean } = {},
): Promise<number | null> {
  if (!hasCheckDaemon(env)) return null
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', name, JSON.stringify(args ?? {}), ...(opts.json ? ['--json'] : [])])
}

/** Inside a trigger check whose daemon is listening (never inside a session: its own id always wins). */
function hasCheckDaemon(env: NodeJS.ProcessEnv): boolean {
  if ((env.WALNUT_SESSION_ID ?? '').trim() || !(env.WALNUT_CHECK_TOKEN ?? '').trim()) return false
  const socket = (env.WALNUT_CHECK_SOCKET ?? '').trim()
  try {
    return !!socket && fs.statSync(socket).isSocket()
  } catch {
    return false
  }
}

/**
 * `walnut tools call <op> ...` from a trigger check for an op this process does not know (a plugin
 * declared it, so only the server has it): the check's daemon relays it as the check's call, as a
 * session's host daemon does for a session (callServerOpThroughHostDaemon). A name no op has is
 * then refused by the server, which tells the check's task (core/routines/check-call-refused.ts);
 * before 2026-11-27 a check on the Mac could not call a plugin op at all. Null outside a check.
 */
export async function callServerOpThroughCheckDaemon(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  if (!hasCheckDaemon(env)) return null
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', ...argv])
}

/**
 * A session whose Walnut named no address for it (no OPEN_WALNUT_API_URL: a session on a host
 * other than its server's, or one spawned before its server listened). Its host daemon is then
 * the one way to ITS Walnut, as the gateway shim is first on such a session's PATH
 * (daemon-standalone.ts walnutThroughGateway): over HTTP the default address reaches whatever
 * Walnut listens on :3456 there, or none (2026-11-20, a VP of a Walnut on another port).
 */
export function sessionWithoutAddress(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasHostDaemon(env) && walnutApiTarget({ env, ownServer: false }).source === 'default'
}

/**
 * Hand the call to this session's host daemon. Returns the exit code, or null
 * when there is no daemon to ask (then the caller reports its own error).
 * `first`: asked before any HTTP try (sessionWithoutAddress), so no "not reachable" notice.
 */
export async function callThroughHostDaemon(
  name: string,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts: { json?: boolean; first?: boolean } = {},
): Promise<number | null> {
  if (!hasHostDaemon(env)) return null
  // A notice for a person at a terminal only: a caller reading stderr as JSON
  // (`2>&1`, tool-call-output.ts) would read this line into the answer.
  if (!opts.json && !opts.first && process.stderr.isTTY === true) {
    process.stderr.write('walnut: the Walnut server is not reachable; asking this host\'s daemon instead.\n')
  }
  const { runWalnutCli } = await import('../providers/wn-cli.js')
  return runWalnutCli(['tools', 'call', name, JSON.stringify(args ?? {}), ...(opts.json ? ['--json'] : [])])
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

/**
 * Inside a trigger check (WALNUT_CHECK_TOKEN, WALNUT_CHECK_SOCKET), what a call this CLI made over
 * HTTP met is told to the daemon running the check, which saw none of it (trigger-check-core.ts
 * CHECK_FAULT_OP): a fault of the machine (opOutcomeFault: a 507, no server, a host's link down),
 * or a real answer, which clears one an earlier call met. A check that then fails on a fault counts
 * against no one (2026-11-16, a full Mac disk failed nine checks at once). Read from the answer's
 * status and code, never its words. Never throws, never waits long; outside a check it does nothing.
 * A call refused as written is told apart (providers/check-call-report.ts).
 */
export async function reportCheckOutcome(
  r: { ok: boolean; status?: number; code?: string; unreachable?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { CHECK_FAULT_OP, opOutcomeFault } = await import('../providers/trigger-check-core.js')
  const kind = opOutcomeFault(r)
  // A refusal that is the script's own (a 404, bad arguments) leaves the run's fault as it is: it is
  // neither the machine nor proof the machine is back. Only a real answer clears.
  if (!kind && !r.ok) return
  // No wait: the daemon answers this one itself, at once (it is never relayed).
  const { tellCheckDaemon } = await import('../providers/check-call-report.js')
  await tellCheckDaemon(CHECK_FAULT_OP, { kind }, env)
}
