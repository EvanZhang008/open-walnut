/**
 * The address the web server listens on. A host replica listens on loopback only (its
 * tunnel is the one way in). Otherwise the caller's choice, else WALNUT_BIND_ADDRESS: the
 * cloud companion's unit sets 127.0.0.1, because Caddy on the same box is its only front
 * (scripts/cloud/setup.sh). Unset = every interface, as before.
 */
import net from 'node:net'
import { log } from '../logging/index.js'

export function serverBindAddress(opts: { replica: boolean; requested?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  if (opts.replica) return '127.0.0.1'
  if (opts.requested) return opts.requested
  const raw = (opts.env ?? process.env).WALNUT_BIND_ADDRESS?.trim()
  if (!raw) return undefined
  // An IP literal only: a name could resolve to an outside interface, and a typo must not
  // quietly open the server wider than asked.
  if (net.isIP(raw) === 0) {
    log.web.error('WALNUT_BIND_ADDRESS is not an IP address; listening on loopback only', { value: raw })
    return '127.0.0.1'
  }
  return raw
}
