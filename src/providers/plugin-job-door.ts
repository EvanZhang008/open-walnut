/**
 * A plugin job's door: the plugin's HTTP routes a job serves (`"serves": true` in
 * its manifest), reached through the daemon of the machine it runs on.
 *
 *   browser ─► leader /api/plugins/<id>/<path>  (no route of the server half answers it)
 *           ─► daemon `jobs.http` ─► the run's unix socket ─► walnut.http.route handler in the job
 *
 * The wire, one request per connection: the daemon writes one line
 * `{v:1, method, path, headers, size, data}` (path with its query, data = the body in
 * base64, size = its bytes) and the job answers one line `{v:1, status, headers, size, data}`.
 * Both ends are here: `forward` (the daemon) and `serve` (the job's harness), so the
 * limits are the same on both: a request body at most 256 KB (it is an upload to the
 * job's machine, and a fragile SSH relay drops the whole link after a few MB up), an
 * answer body at most 2 MB, headers 64 KB (src/core/plugins/plugin-http-rules.ts), a
 * forward at most 9 s, 8 at once to one run.
 * The deadlines nest: the job's 9 s, inside the leader's 10 s wait for the daemon
 * (core/plugin-jobs/serve.ts), inside the 12 s the Mac gives a plugin request the
 * companion relayed (plugins/plugin-control-relay.ts), inside the companion's 15 s.
 * A request's `signal` aborts when its forward ends (the 9 s, or the daemon going away),
 * not when the browser does: nothing tells the daemon that.
 *
 * The socket files are this module's too: `placeSocket` makes a run's (the first path
 * that fits the 100 bytes a unix socket path takes, its dir 0700), `dropSocket` removes
 * one whose run is over, `sweepSockets` the ones a dead daemon left.
 *
 * Route paths match as the server half's do (an Express mount of `router.get('/')`):
 * literal segments case-insensitively, `:name` one segment, a last `*name` the rest,
 * a trailing slash optional, HEAD answered by a GET route without its body.
 *
 * daemon-standalone.ts and wn-cli.ts import createPluginJobDoor. The factory body
 * references NOTHING at module scope; every side effect arrives through deps.
 */

export interface PluginJobDoorDeps {
  fs: typeof import('node:fs')
  net: typeof import('node:net')
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}

/** What a job's route handler is given (packages/plugin-api/src/server.ts PluginRequest). */
export interface DoorRouteRequest {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  signal: AbortSignal
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
}

/** What it answers (PluginReply). */
export interface DoorRouteReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
  body?: Uint8Array | AsyncIterable<Uint8Array>
  timeoutMs?: number
}

export type DoorRouteHandler = (request: DoorRouteRequest) => DoorRouteReply | Promise<DoorRouteReply>

/** One request or answer on the wire. */
export interface DoorMessage { status?: number; method?: string; path?: string; headers: Record<string, string>; size: number; data: string }

export function createPluginJobDoor(deps: PluginJobDoorDeps) {
  const { fs, net } = deps
  const MAX_BODY_BYTES = 2 * 1024 * 1024
  const MAX_REQUEST_BODY_BYTES = 256 * 1024
  const MAX_HEADERS_BYTES = 64 * 1024
  const MAX_PATH_CHARS = 4_096
  const FORWARD_TIMEOUT_MS = 9_000
  /** A unix socket path must fit sockaddr_un (104 bytes on macOS, 108 on Linux). */
  const SOCKET_PATH_MAX = 100
  /** One wire line carrying a body of at most `bytes`: its base64, its headers, its path. */
  const lineMax = (bytes: number) => Math.ceil(bytes / 3) * 4 + 2 * MAX_HEADERS_BYTES + MAX_PATH_CHARS + 1_024
  const MAX_REQUEST_LINE_CHARS = lineMax(MAX_REQUEST_BODY_BYTES)
  const MAX_ANSWER_LINE_CHARS = lineMax(MAX_BODY_BYTES)
  const MAX_CONNECTIONS = 16
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
  const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
  const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/

  function fail(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code })
  }

  /** Headers of strings with token names, at most 64 KB in all; anything else is refused. */
  function headersOf(raw: unknown, what: string): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_request', `${what} headers must be an object`)
    const out: Record<string, string> = {}
    let bytes = 0
    for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
      const name = rawName.toLowerCase()
      if (!HEADER_NAME.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw fail('bad_request', `${what} has an invalid header`)
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
      if (bytes > MAX_HEADERS_BYTES) throw fail('too_large', `${what} headers are larger than ${MAX_HEADERS_BYTES / 1024} KB`)
      out[name] = value
    }
    return out
  }

  const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`)

  /** The body a message carries: `size` bytes as base64 in `data`, at most `max` (`code` past it). */
  function bodyOf(size: unknown, data: unknown, what: string, max: number, code: string): Buffer {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof data !== 'string') throw fail('bad_request', `${what} has no valid body`)
    if (size > max || data.length > Math.ceil(max / 3) * 4 + 4) throw fail(code, `${what} body is larger than the ${sizeText(max)} a plugin job takes`)
    const body = Buffer.from(data, 'base64')
    if (body.byteLength !== size) throw fail('bad_request', `${what} body is not the size it says`)
    return body
  }

  function checkPath(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > MAX_PATH_CHARS
      || raw.includes('\0') || raw.includes('#') || raw.includes('\\')) throw fail('bad_request', 'the request has an invalid path')
    if (raw.split('?', 1)[0]!.split('/').some((s) => s === '.' || s === '..')) throw fail('bad_request', 'the request has an invalid path')
    return raw
  }

  /** A request as the daemon is asked for it: refused unless every part is in bounds. */
  function checkRequest(raw: unknown): { method: string; path: string; headers: Record<string, string>; body: Buffer } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : ''
    if (!METHODS.includes(method)) throw fail('bad_request', `the method ${JSON.stringify(r.method)} is not one a route takes`)
    const body = bodyOf(r.size, r.data, 'the request', MAX_REQUEST_BODY_BYTES, 'request_too_large')
    if ((method === 'GET' || method === 'HEAD') && body.byteLength > 0) throw fail('bad_request', `a ${method} request has no body`)
    return { method, path: checkPath(r.path), headers: headersOf(r.headers, 'the request'), body }
  }

  /** Read one line (at most `max` characters) from a socket. */
  function readLine(sock: import('node:net').Socket, max: number, onLine: (line: string) => void, onFail: (err: Error & { code: string }) => void): void {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    sock.on('data', (chunk: Buffer) => {
      if (done) return
      const nl = chunk.indexOf(0x0a)
      const part = nl === -1 ? chunk : chunk.subarray(0, nl)
      total += part.byteLength
      if (total > max) { done = true; onFail(fail('too_large', `the message is larger than ${sizeText(Math.ceil(max / 1024) * 1024)}`)); return }
      chunks.push(part)
      if (nl === -1) return
      done = true
      onLine(Buffer.concat(chunks, total).toString('utf8'))
    })
  }

  /** The daemon's end: one request to the run's socket, its answer, or an Error with a `code`. */
  function forward(socketPath: string, raw: unknown, timeoutMs = FORWARD_TIMEOUT_MS): Promise<DoorMessage & { status: number }> {
    let req: ReturnType<typeof checkRequest>
    try { req = checkRequest(raw) } catch (err) { return Promise.reject(err) }
    const line = JSON.stringify({ v: 1, method: req.method, path: req.path, headers: req.headers, size: req.body.byteLength, data: req.body.toString('base64') }) + '\n'
    return new Promise((resolve, reject) => {
      let settled = false
      const sock = net.connect(socketPath)
      const finish = (err: Error | null, answer?: DoorMessage & { status: number }) => {
        if (settled) return
        settled = true
        deps.clearTimer(timer)
        try { sock.destroy() } catch { /* closed */ }
        if (err) reject(err)
        else resolve(answer!)
      }
      const timer = deps.setTimer(() => finish(fail('timeout', `the job did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
      sock.on('connect', () => { sock.write(line) })
      sock.on('error', (err: NodeJS.ErrnoException) => {
        const notListening = err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        finish(notListening
          ? fail('not_ready', 'the job is running but serves no route yet (it has not called walnut.http.route, or is starting)')
          : fail('no_answer', `the job's routes could not be reached: ${err.message}`))
      })
      sock.on('close', () => finish(fail('no_answer', 'the job closed the connection without an answer')))
      readLine(sock, MAX_ANSWER_LINE_CHARS, (text) => {
        try {
          const a = JSON.parse(text) as Record<string, unknown>
          const status = a.status
          if (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599) throw fail('bad_answer', 'the job answered with no valid status')
          const headers = headersOf(a.headers ?? {}, 'the answer')
          const body = bodyOf(a.size, a.data, 'the answer', MAX_BODY_BYTES, 'too_large')
          finish(null, { status, headers, size: body.byteLength, data: a.data as string })
        } catch (err) {
          const e = err as Error & { code?: string }
          finish(e.code ? (e.code === 'bad_request' ? fail('bad_answer', e.message) : e as Error & { code: string }) : fail('bad_answer', 'the job answered with something that is not JSON'))
        }
      }, (err) => finish(err))
    })
  }

  function routeParts(routePath: string): string[] {
    if (typeof routePath !== 'string' || !routePath.startsWith('/') || routePath.startsWith('//') || routePath.includes('\0')) {
      throw new Error(`Plugin route path must be an absolute in-plugin path: ${JSON.stringify(routePath)}`)
    }
    const parts = routePath.replace(/\\/g, '/').split('/').slice(1)
    if (parts.some((p) => p === '..')) throw new Error(`Plugin route path must not contain "..": ${JSON.stringify(routePath)}`)
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }

  function matches(route: string[], path: string[]): boolean {
    for (let i = 0; i < route.length; i++) {
      const r = route[i]!
      if (r.startsWith('*') && i === route.length - 1) return path.length > i && path.slice(i).some((s) => s !== '')
      const p = path[i]
      if (p === undefined) return false
      if (r.startsWith(':')) { if (!p) return false; continue }
      if (r.toLowerCase() !== p.toLowerCase()) return false
    }
    return route.length === path.length
  }

  function queryOf(search: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {}
    const params = new URLSearchParams(search)
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key)
      out[key] = all.length === 1 ? all[0]! : all
    }
    return out
  }

  /** A reply as the wire's answer: the server half's defaults (status, content type), bounded. */
  async function answerOf(reply: DoorRouteReply): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const r = reply && typeof reply === 'object' ? reply : {}
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v
    const typed = (type: string) => { if (!headers['content-type']) headers['content-type'] = type }
    let body = Buffer.alloc(0)
    if (r.json !== undefined) { body = Buffer.from(JSON.stringify(r.json) ?? '', 'utf8'); typed('application/json; charset=utf-8') }
    else if (r.text !== undefined) { body = Buffer.from(String(r.text), 'utf8'); typed('text/html; charset=utf-8') }
    else if (r.body instanceof Uint8Array) body = Buffer.from(r.body)
    else if (r.body && typeof (r.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
      // No streaming through this door: the chunks are gathered, and sent at once.
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of r.body as AsyncIterable<Uint8Array>) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Plugin response chunks must be bytes')
        total += chunk.byteLength
        if (total > MAX_BODY_BYTES) throw fail('too_large', 'the reply is larger than 2 MB')
        chunks.push(Buffer.from(chunk))
      }
      body = Buffer.concat(chunks, total)
    }
    if (body.byteLength > MAX_BODY_BYTES) throw fail('too_large', 'the reply is larger than 2 MB')
    const fallback = r.json === undefined && r.text === undefined && r.body === undefined ? 204 : 200
    const status = typeof r.status === 'number' && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : fallback
    // A HEAD's body goes too: the leader sends only its length, as Express does for the server half.
    return { status, headers, body }
  }

  /**
   * The job's end: its routes, served on `socketPath` (0600) from the first `route` on.
   * `prefix` is the plugin's mount (`/api/plugins/<id>`): a handler's `path` is the full
   * URL, as the server half's is.
   */
  function serve(socketPath: string, opts: { prefix: string; log: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void }) {
    const routes: Array<{ method: string; parts: string[]; handler: DoorRouteHandler }> = []
    let server: import('node:net').Server | null = null
    let closed = false

    function send(sock: import('node:net').Socket, status: number, headers: Record<string, string>, body: Buffer): void {
      try { sock.end(JSON.stringify({ v: 1, status, headers, size: body.byteLength, data: body.toString('base64') }) + '\n') } catch { /* gone */ }
    }
    function sendJson(sock: import('node:net').Socket, status: number, value: unknown): void {
      send(sock, status, { 'content-type': 'application/json; charset=utf-8' }, Buffer.from(JSON.stringify(value), 'utf8'))
    }

    async function handle(sock: import('node:net').Socket, text: string, controller: AbortController): Promise<void> {
      let req: ReturnType<typeof checkRequest>
      try { req = checkRequest(JSON.parse(text)) } catch (err) {
        sendJson(sock, (err as { code?: string }).code === 'request_too_large' ? 413 : 400, { error: (err as Error).message })
        return
      }
      const [pathname, search = ''] = req.path.split(/\?(.*)/s, 2) as [string, string?]
      const parts = pathname.split('/').slice(1)
      if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const route = routes.find((r) => r.method === method && matches(r.parts, parts))
      if (!route) { sendJson(sock, 404, { error: `No route ${req.method} ${pathname} in this job` }); return }
      const bodyText = req.body.toString('utf8')
      try {
        const reply = await route.handler({
          method: req.method,
          path: opts.prefix + req.path,
          query: queryOf(search),
          headers: req.headers,
          signal: controller.signal,
          async json<T>() { return JSON.parse(bodyText) as T },
          async text() { return bodyText },
        })
        if (controller.signal.aborted) return
        const a = await answerOf(reply)
        send(sock, a.status, a.headers, a.body)
      } catch (err) {
        if (controller.signal.aborted) return
        const e = err as Error & { code?: string }
        opts.log('error', 'route failed', { method: req.method, path: pathname, error: e instanceof Error ? (e.stack ?? e.message) : String(err) })
        if (e.code === 'too_large') sendJson(sock, 502, { error: e.message })
        else sendJson(sock, 500, { error: e instanceof Error ? e.message : String(err) })
      }
    }

    function listen(): void {
      if (server || closed) return
      // A run before this one that ended without closing left its socket file.
      try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath) } catch { /* none */ }
      const s = net.createServer((sock) => {
        const controller = new AbortController()
        sock.on('close', () => controller.abort())
        sock.on('error', () => { /* the daemon went away; close follows */ })
        readLine(sock, MAX_REQUEST_LINE_CHARS, (text) => { void handle(sock, text, controller) }, (err) => sendJson(sock, 413, { error: err.message }))
      })
      s.maxConnections = MAX_CONNECTIONS
      // A socket that did not open is tried again at the next route (the daemon says not_ready meanwhile).
      s.on('error', (err: Error) => {
        opts.log('error', 'the routes socket did not open', { socket: socketPath, error: err.message })
        if (server === s) server = null
      })
      s.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600) } catch { /* the dir is 0700 */ }
        opts.log('info', 'serving routes', { routes: routes.map((r) => `${r.method} /${r.parts.join('/')}`) })
      })
      server = s
    }

    return {
      route(methodInput: string, routePath: string, handler: DoorRouteHandler): { dispose(): void } {
        const method = String(methodInput).toUpperCase()
        if (!ROUTE_METHODS.includes(method)) throw new Error(`Unsupported Plugin route method: ${methodInput}`)
        if (typeof handler !== 'function') throw new Error('http.route needs a handler function')
        const entry = { method, parts: routeParts(routePath), handler }
        routes.push(entry)
        listen()
        return { dispose() { const i = routes.indexOf(entry); if (i !== -1) routes.splice(i, 1) } }
      },
      /** No new request from now on (a stop's grace lets the ones in flight finish). */
      close(): void {
        closed = true
        if (server) { try { server.close() } catch { /* closed */ } }
      },
    }
  }

  /** The first of `candidates` that fits a unix socket path, its dir made 0700; null: none fits or none can be made. */
  function placeSocket(candidates: string[]): string | null {
    const at = candidates.find((p) => Buffer.byteLength(p) <= SOCKET_PATH_MAX)
    if (!at) return null
    const dir = at.slice(0, at.lastIndexOf('/'))
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dir, 0o700)
    } catch { return null }
    return at
  }

  /** A run that is over leaves no socket file behind. */
  function dropSocket(file: string): void {
    try { if (fs.lstatSync(file).isSocket()) fs.unlinkSync(file) } catch { /* none */ }
  }

  /** Socket files named as placeSocket's (`<16 hex>.sock`) in `dirs` that no run holds, once `keepMs` old. */
  function sweepSockets(dirs: string[], held: Set<string>, now: number, keepMs: number): void {
    for (const dir of dirs) {
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names) {
        const file = `${dir}/${name}`
        if (held.has(file) || !/^[0-9a-f]{16}\.sock$/.test(name)) continue
        try {
          const st = fs.lstatSync(file)
          if (st.isSocket() && now - st.mtimeMs >= keepMs) fs.unlinkSync(file)
        } catch { /* gone */ }
      }
    }
  }

  return { forward, serve, checkRequest, placeSocket, dropSocket, sweepSockets, MAX_BODY_BYTES, MAX_REQUEST_BODY_BYTES, MAX_HEADERS_BYTES, FORWARD_TIMEOUT_MS }
}

export type PluginJobDoor = ReturnType<typeof createPluginJobDoor>
