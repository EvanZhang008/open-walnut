/**
 * Whether a call that came in from `origin` comes from host `host`: the same alias, or another
 * alias of the same daemon process (daemon-connection.ts oneDaemon), whose link the daemon may relay
 * a session's call over (2026-11-16: clouddev and newdev are one box and one daemon; a clouddev
 * session's calls came in over newdev's link and lost their task). Every check of a host against a
 * call's origin goes through here (tests/core/session-host-origin-ratchet.test.ts): the session's
 * identity (approvals-v1.ts requesterOf) and where a session may arm a check (check-host-policy.ts).
 */
import { LOCAL_ORIGIN, hostOrigin } from '../../lib/caller-origin.js'

const HOST = 'host:'

export async function fromHost(host: string | undefined, origin: string): Promise<boolean> {
  const own = hostOrigin(host || LOCAL_ORIGIN)
  if (own === origin) return true
  if (!origin.startsWith(HOST) || !own.startsWith(HOST)) return false
  const { oneDaemon } = await import('../../providers/daemon-connection.js')
  // The recorded pair (a link down) may resolve ssh names: never longer than this, then no.
  const late = new Promise<false>((r) => { const t = setTimeout(() => r(false), 3000); t.unref?.() })
  return Promise.race([oneDaemon(origin.slice(HOST.length), own.slice(HOST.length)).catch(() => false), late])
}
