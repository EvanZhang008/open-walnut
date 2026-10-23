/**
 * Which machine answers at a tunnel's address (docs/plan/walnut-servers-everywhere.md).
 *
 * A tunnel service gives a name to whoever connected last; an older connection keeps
 * saying "connected" while it gets nothing, and the address may then answer with the
 * service's own error page. "Any HTTP answer" cannot tell that apart from a working
 * tunnel, so every listener a tunnel points at answers one path with its own token
 * (the supervisor's, per process): a probe through the address learns whether this
 * run, another Walnut, or nobody behind it answers.
 *
 * A provider that puts a sign-in page in front of the address (a redirect, 401 or 403
 * before anything reaches the listener) can only be told to answer at all: `unverified`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const TUNNEL_PROBE_PATH = '/__walnut/tunnel-probe'
export const TUNNEL_PROBE_HEADER = 'x-walnut-tunnel'

/**
 * - `mine`: this run's listener answered;
 * - `other`: another Walnut listener answered (another machine holds the name);
 * - `unverified`: something answered without a token, as a sign-in page in front does;
 * - `down`: no answer, a timeout, or an error page (404, 5xx) without a token.
 */
export type ProbeAnswer = 'mine' | 'other' | 'unverified' | 'down'

/** Answer the probe path with `token`; true when it was the probe (the request is done). */
export function answerTunnelProbe(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if ((req.url ?? '').split('?')[0] !== TUNNEL_PROBE_PATH) return false
  res.writeHead(200, { [TUNNEL_PROBE_HEADER]: token, 'cache-control': 'no-store', 'content-type': 'text/plain', 'content-length': '2' })
  res.end(req.method === 'HEAD' ? undefined : 'ok')
  return true
}

/** Statuses a sign-in page in front of the address answers with. */
function signInFront(status: number): boolean {
  return status < 400 || status === 401 || status === 403 || status === 407
}

/** Ask the address which listener answers (`token`: this run's). */
export async function httpProbe(url: string, timeoutMs: number, token: string): Promise<ProbeAnswer> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return 'down'
  }
  target.pathname = target.pathname.replace(/\/+$/, '') + TUNNEL_PROBE_PATH
  target.search = ''
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    const answered = res.headers.get(TUNNEL_PROBE_HEADER)
    await res.body?.cancel().catch(() => {})
    if (answered) return answered === token ? 'mine' : 'other'
    return signInFront(res.status) ? 'unverified' : 'down'
  } catch {
    return 'down'
  }
}

/** A probe dependency's answer; `true`/`false` from an older fake reads as `unverified`/`down`. */
export function probeAnswer(value: ProbeAnswer | boolean): ProbeAnswer {
  if (value === true) return 'unverified'
  if (value === false) return 'down'
  return value
}
