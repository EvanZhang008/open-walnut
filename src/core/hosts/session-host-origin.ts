/**
 * Whether a call that came in from `origin` comes from host `host`: the same alias, or another
 * alias of the same daemon process (daemon-connection.ts oneDaemon), whose link the daemon may relay
 * a session's call over (2026-11-16: clouddev and newdev are one box and one daemon; a clouddev
 * session's calls came in over newdev's link and lost their task). Every check of a host against a
 * call's origin goes through here (tests/core/session-host-origin-ratchet.test.ts): the session's
 * identity (approvals-v1.ts requesterOf), where a session may arm a check (check-host-policy.ts),
 * and whose check a relayed trigger call is (trigger-caller.ts, through oneHost).
 */
import { LOCAL_ORIGIN, hostOrigin } from '../../lib/caller-origin.js'

const HOST = 'host:'

export async function fromHost(host: string | undefined, origin: string): Promise<boolean> {
  const own = hostOrigin(host || LOCAL_ORIGIN)
  if (own === origin) return true
  if (!origin.startsWith(HOST) || !own.startsWith(HOST)) return false
  return oneHost(origin.slice(HOST.length), own.slice(HOST.length))
}

/**
 * Whether host alias `via` (the link a call came in over) and host alias `host` are one host: the
 * same alias, or two aliases of one daemon process. This Mac is only itself.
 */
export async function oneHost(via: string, host: string): Promise<boolean> {
  if (via === host) return true
  if (!via || !host || via === LOCAL_ORIGIN || host === LOCAL_ORIGIN) return false
  const { oneDaemon } = await import('../../providers/daemon-connection.js')
  // The recorded pair (a link down) may resolve ssh names: never longer than this, then no.
  const late = new Promise<false>((r) => { const t = setTimeout(() => r(false), 3000); t.unref?.() })
  return Promise.race([oneDaemon(via, host).catch(() => false), late])
}
