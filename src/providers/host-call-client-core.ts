/**
 * The client half of a host's local call entry ('host-call-entry-v1'): a session or plugin job
 * whose daemon gave it WALNUT_CALL_URL and WALNUT_CALL_TOKEN posts its gateway request line to its
 * own Walnut server there (replica/host-call-entry.ts), which hands it to the daemon, which runs
 * it exactly as a line on the gateway socket. The socket stays the way when the entry is not there.
 *
 *   answer      the entry's answer (its header says so): the call's answer, as the socket's
 *   not_taken   nothing ran: no entry listening, a server that is not the entry (an older one,
 *               or another program on that port), the token refused, the entry unavailable.
 *               The caller sends the same line (same call id) on the socket.
 *   lost        the line was sent and no answer came: it may have run. Never sent again blindly;
 *               the caller answers as for a socket call whose answer was lost (lostCallLines).
 *
 * Used by wn-cli.ts (the host's `walnut`, its MCP server) and plugin-job-harness.ts; the source
 * daemon twin inlines it by `toString()` for its plugin job runs: self-contained, no imports at
 * runtime, nothing at module scope that the factory references.
 */

/** The entry's path on a host's Walnut server. */
export const HOST_CALL_PATH = '/api/host/call'
/** Every answer of the entry carries it: an answer without it is not the entry's. */
export const HOST_CALL_ANSWER_HEADER = 'x-walnut-host-call'

export interface HostCallClientDeps {
  http: typeof import('node:http')
  env: Record<string, string | undefined>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export type HostCallOutcome =
  | { kind: 'answer'; resp: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; [k: string]: unknown } } }
  | { kind: 'not_taken'; why: string }
  | { kind: 'lost'; timeout: boolean; message: string }

export function createHostCallClient(deps: HostCallClientDeps) {
  // Same value as HOST_CALL_ANSWER_HEADER (tests pin it): the factory may not read module scope.
  const ANSWER_HEADER = 'x-walnut-host-call'
  /** A connect that takes longer than this is no entry: the socket is asked instead, nothing sent. */
  const CONNECT_MS = 3_000
  const NOT_SENT = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN']
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))

  /** The entry this process was given, or null: an http URL on this machine's loopback and a token. */
  function entry(): { url: URL; token: string } | null {
    const raw = (deps.env.WALNUT_CALL_URL ?? '').trim()
    const token = (deps.env.WALNUT_CALL_TOKEN ?? '').trim()
    if (!raw || !/^[0-9a-f]{64}$/.test(token)) return null
    let url: URL
    try { url = new URL(raw) } catch { return null }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (url.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')) return null
    return { url, token }
  }

  /** Post one request line to the entry. Never throws. */
  function post(req: Record<string, unknown>, timeoutMs: number): Promise<HostCallOutcome> {
    const e = entry()
    if (!e) return Promise.resolve({ kind: 'not_taken', why: 'no entry given' })
    let body: string
    try { body = JSON.stringify(req) } catch { return Promise.resolve({ kind: 'not_taken', why: 'request not serializable' }) }
    return new Promise((resolve) => {
      let done = false
      let connected = false
      let connectTimer: unknown = null
      const finish = (o: HostCallOutcome) => {
        if (done) return
        done = true
        clearTimer(timer)
        if (connectTimer) clearTimer(connectTimer)
        try { r.destroy() } catch { /* gone */ }
        resolve(o)
      }
      const r = deps.http.request({
        hostname: e.url.hostname.replace(/^\[|\]$/g, ''), port: e.url.port || 80, path: e.url.pathname + e.url.search, method: 'POST',
        // A socket of its own: whether the line left is told by this connection's connect.
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + e.token },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => { chunks.push(c) })
        res.on('error', () => finish({ kind: 'lost', timeout: false, message: 'the answer of this host\'s Walnut server broke off' }))
        res.on('end', () => {
          if (!res.headers[ANSWER_HEADER]) {
            // Not the entry (an older server, or another program on the port): nothing of the call ran there.
            finish({ kind: 'not_taken', why: 'no entry at ' + e.url.origin + ' (HTTP ' + res.statusCode + ')' })
            return
          }
          let parsed: { ok?: unknown; error?: { code?: unknown } | string; code?: unknown } | null = null
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { parsed = null }
          const status = res.statusCode ?? 0
          if (status === 200 && parsed && typeof parsed.ok === 'boolean') {
            finish({ kind: 'answer', resp: parsed as Extract<HostCallOutcome, { kind: 'answer' }>['resp'] })
            return
          }
          // The entry refused before anything ran: a token it did not take, or no daemon to hand it to.
          if (status === 401 || status === 429 || (parsed && parsed.code === 'entry_unavailable')) {
            finish({ kind: 'not_taken', why: 'the entry did not take it (HTTP ' + status + ')' })
            return
          }
          finish({ kind: 'lost', timeout: false, message: 'this host\'s Walnut server answered HTTP ' + status + ' without the call\'s answer' })
        })
      })
      r.on('socket', (s: import('node:net').Socket) => {
        if (!s.connecting) { connected = true; return }
        s.once('connect', () => { connected = true; if (connectTimer) { clearTimer(connectTimer); connectTimer = null } })
      })
      r.on('error', (err: Error & { code?: string }) => {
        if (!connected || NOT_SENT.indexOf(err.code ?? '') !== -1) finish({ kind: 'not_taken', why: 'no entry listening (' + (err.code || err.message) + ')' })
        else finish({ kind: 'lost', timeout: false, message: 'the link to this host\'s Walnut server broke: ' + (err.code || err.message) })
      })
      connectTimer = setTimer(() => { if (!connected) finish({ kind: 'not_taken', why: 'the entry did not accept the connection in time' }) }, Math.min(CONNECT_MS, timeoutMs))
      const timer = setTimer(() => finish(connected
        ? { kind: 'lost', timeout: true, message: 'no answer from this host\'s Walnut server within ' + Math.round(timeoutMs / 1000) + 's' }
        : { kind: 'not_taken', why: 'the entry did not accept the connection in time' }), timeoutMs)
      r.end(body)
    })
  }

  return { entry, post }
}

export type HostCallClient = ReturnType<typeof createHostCallClient>
