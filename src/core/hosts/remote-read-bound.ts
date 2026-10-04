/**
 * Request-path deadline for reads that need a remote host's daemon (session
 * history, Changes): house rule, every route touching a daemon answers within
 * a deadline, degraded if it must, and never pins a browser connection.
 *
 * Why here and not in the dial: joining a dial waits for its whole handshake,
 * and a host that accepts TCP but never answers (a hung companion, a half-open
 * SSH path) holds that handshake until its own timeout, 40s and more. The read
 * was measured at 44.5s (history) and 60.4s (Changes) behind such a host. So:
 *  - connected, or a failure the pool already knows: run the read as is (the
 *    pool answers at once either way);
 *  - a connect or reconnect already running: answer degraded AT ONCE (the
 *    route serves its cache, or says the host is reconnecting). This request
 *    would only wait on a dial it did not start;
 *  - cold (idle, or a reconnect waiting out its backoff): this request starts
 *    or expedites the dial, and waits for it at most HOST_READ_DIAL_CAP_MS.
 *    The dial goes on in the background; the next request finds it running.
 *
 * Local sessions never come here (their daemon is this machine's).
 */

import { SessionControlError } from '../sessions/session-controls.js'
import { log } from '../../logging/index.js'

/** How long a request waits on a dial it started itself. */
export const HOST_READ_DIAL_CAP_MS = 5_000

/** The error code the routes answer with (503), in both the web and the v1 shape. */
export const HOST_RECONNECTING = 'host_reconnecting'

/** The host is still connecting: the read did not run, or did not finish in time. */
export class HostReconnectingError extends SessionControlError {
  constructor(public host: string, label: string) {
    super(`Reconnecting to ${label}`, 503, { code: HOST_RECONNECTING, host })
    this.name = 'HostReconnectingError'
  }
}

type WouldWait = 'connected' | 'fails-fast' | 'dialing' | 'cold'

export interface BoundDeps {
  wouldWait: (host: string) => WouldWait
  label: (host: string) => Promise<string>
  capMs: number
}

async function defaultWouldWait(): Promise<(host: string) => WouldWait> {
  const { daemonConnectWouldWait } = await import('../../providers/daemon-connection.js')
  return daemonConnectWouldWait
}

async function defaultLabel(host: string): Promise<string> {
  try {
    const { getConfig } = await import('../config-manager.js')
    const def = (await getConfig()).hosts?.[host] as { label?: unknown } | undefined
    return typeof def?.label === 'string' && def.label.trim() ? def.label : host
  } catch {
    return host
  }
}

/** A remote host alias (not the local machine). */
export function isRemoteHost(host: string | null | undefined): host is string {
  return typeof host === 'string' && host !== '' && host !== '__local__'
}

/**
 * Run `read`, which needs `host`'s daemon, within the rules above. Throws
 * HostReconnectingError when the host is still connecting.
 */
export async function boundHostRead<T>(
  host: string | null | undefined,
  read: () => Promise<T>,
  deps: Partial<BoundDeps> = {},
): Promise<T> {
  if (!isRemoteHost(host)) return read()
  const wouldWait = (deps.wouldWait ?? await defaultWouldWait())(host)
  if (wouldWait === 'connected' || wouldWait === 'fails-fast') return read()
  const label = deps.label ?? defaultLabel
  if (wouldWait === 'dialing') throw new HostReconnectingError(host, await label(host))

  const work = read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deps.capMs ?? HOST_READ_DIAL_CAP_MS) })
  try {
    const first = await Promise.race([work.then((value) => ({ value })), late])
    if (first !== 'late') return first.value
  } finally {
    clearTimeout(timer)
  }
  // The dial goes on; its outcome reaches the pool, not this request.
  work.catch(() => { /* the pool caches the failure; the next request sees it */ })
  log.web.info('host read answered degraded: the host is still connecting', { host })
  throw new HostReconnectingError(host, await label(host))
}
