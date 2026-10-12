/**
 * The server half of SendOnceUITests (ios-native/WalnutUITests/SendOnceUITests.swift).
 *
 * A real Walnut server in a throwaway home, with the mock session daemon and the mock
 * Claude CLI, behind a small proxy that can refuse, hold or swallow one message POST.
 * That is what lets the real app on a simulator meet the lost answers the send-once
 * rules exist for (a POST that reached the server while its answer did not reach the
 * phone, a retry cut short by going to the background), and lets the test read back
 * what the server really got.
 *
 * Run it through ios-native/tests/ui/run-send-once-ui.sh, which starts it, hands the
 * proxy's address to the UI test runner, and stops it:
 *
 *   ./node_modules/.bin/tsx ios-native/tests/ui/send-once-server.ts <proxyPort> <outDir>
 *
 * Nothing here reaches a real Walnut: HOME, the data dir and the daemon dir are temp
 * dirs, every session runs the mock CLI through the mock daemon, the port 3456 is
 * refused, and the process ends when its parent goes away or after
 * SEND_ONCE_UI_MAX_MIN minutes (default 40).
 *
 * The proxy's control plane, under /__uitest/:
 *   GET  config  {token, sessions: {a: {sessionId, taskId}, b: ...}}
 *   POST reset   forget every recorded POST and every armed rule
 *   POST arm     {marker, plan}: the nth message POST whose text contains `marker`
 *                takes plan[n-1] ("pass" past the end). Steps:
 *                  "pass"        forwarded, answered as the server answers;
 *                  "refuse503"   never forwarded, answered 503 bridge_offline;
 *                  "hold:<ms>"   forwarded at once, its answer held <ms>, and
 *                                dropped when the client left meanwhile;
 *                  "stall:<ms>"  never forwarded; answered 504 after <ms>, unless
 *                                the client left first (then nothing at all).
 *   GET  state   {posts: [...]} every message POST seen since the reset
 *   GET  rows    ?kind=session|chat&id=<id>&text=<words>: how many user and
 *                assistant rows of the server's own record hold those words
 *   POST shot    ?name=<n>: the PNG body is saved to <outDir>/shots/<n>.png
 *   POST log     the body is appended to <outDir>/uitest.log
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const [portArg, outArg] = process.argv.slice(2)
const PROXY_PORT = Number(portArg)
if (!Number.isInteger(PROXY_PORT) || PROXY_PORT < 1024 || PROXY_PORT > 65535 || PROXY_PORT === 3456) {
  console.error('usage: send-once-server.ts <proxyPort: 1024-65535, never 3456> <outDir>')
  process.exit(2)
}
if (!outArg) {
  console.error('usage: send-once-server.ts <proxyPort> <outDir>')
  process.exit(2)
}
const OUT = path.resolve(outArg)
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })

// The throwaway home, set BEFORE any server module is imported (constants read it at
// import time). Same isolation as the browser fixture (tests/e2e/browser/test-server.ts).
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-send-once-ui-'))
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_SPAWN_JOURNAL = path.join(tmpBase, 'spawn-journal.jsonl')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.WALNUT_LOCAL_CLAUDE_PROBE = '0'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
const projects = path.join(tmpBase, '.claude', 'projects')
fs.mkdirSync(projects, { recursive: true })
process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = projects
process.env.MOCK_CLAUDE_TURN_TRANSCRIPT_DIR = projects
process.env.MOCK_SNAPSHOT_TURN_DELAY_MS = '400'
// SendOnceUITests' long chat turn (snapshot-write-turn) runs this long, filed in
// the transcript like a real one, so the app can come back while it still runs.
process.env.MOCK_SNAPSHOT_WRITE_DELAY_MS = '12000'
process.argv.push('--_ephemeral-child')

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../..')
const MOCK_CLI = path.join(repo, 'tests/providers/mock-claude.mjs')

const { createMockDaemon } = await import('../../../tests/helpers/mock-daemon.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const { createDevice } = await import('../../../src/core/device-auth.js')

const daemon = await createMockDaemon()
sessionRunner.setCliCommand(MOCK_CLI)
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
const api = await startServer({ port: 0, dev: true })
const address = api.address()
const API_PORT = typeof address === 'object' && address ? address.port : 0
if (!API_PORT) throw new Error('the server did not report its port')

const proxyLog = path.join(OUT, 'proxy.jsonl')
const note = (o: Record<string, unknown>): void => {
  fs.appendFileSync(proxyLog, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')
}

const token = (await createDevice('send-once-ui-phone')).token

async function apiCall(method: string, p: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed: unknown = null
  try { parsed = await res.json() } catch { /* keep null */ }
  return { status: res.status, body: parsed }
}

interface Row { role?: string; text?: string }
function rowsOf(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[]
  const messages = (body as { messages?: unknown } | null)?.messages
  return Array.isArray(messages) ? messages as Row[] : []
}

// Two live sessions, each through one clean first turn, so a test opens a page that
// already has an answer on it.
const sessions: Record<string, { sessionId: string; taskId: string }> = {}
for (const name of ['a', 'b']) {
  const work = path.join(tmpBase, `work-${name}`)
  fs.mkdirSync(work, { recursive: true })
  const made = await apiCall('POST', '/api/v1/sessions', {
    cwd: fs.realpathSync(work), message: 'snapshot-clean-turn:Ready.', overrideReadiness: true,
  })
  const b = made.body as { sessionId?: string; taskId?: string } | null
  if (made.status >= 300 || !b?.sessionId || !b.taskId) {
    throw new Error(`could not seed session ${name}: ${made.status} ${JSON.stringify(made.body)}`)
  }
  sessions[name] = { sessionId: b.sessionId, taskId: b.taskId }
}
for (const [name, s] of Object.entries(sessions)) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const t = await apiCall('GET', `/api/v1/sessions/${s.sessionId}/transcript?fresh=1`)
    if (rowsOf(t.body).some((r) => r.role === 'assistant' && r.text === 'Ready.')) break
    if (Date.now() > deadline) throw new Error(`session ${name} never answered its first turn`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

// ── The proxy ─────────────────────────────────────────────────────────────────

interface Post {
  n: number
  kind: 'session' | 'chat'
  url: string
  conversationId: string
  text: string
  messageId: string | null
  step: string
  status: number | null
  forwarded: boolean
  clientGone: boolean
  at: string
}
let posts: Post[] = []
let rules: Array<{ marker: string; plan: string[]; seen: number }> = []

const MESSAGE_POST = /^\/api\/v1\/(sessions|conversations)\/([^/?]+)\/messages(?:\?|$)/

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function control(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const body = await readBody(req)
  switch (url.pathname) {
    case '/__uitest/config':
      return json(res, 200, { token, sessions })
    case '/__uitest/reset':
      posts = []
      rules = []
      note({ reset: true })
      return json(res, 200, { ok: true })
    case '/__uitest/arm': {
      const parsed = JSON.parse(body.toString('utf8') || '{}') as { marker?: unknown; plan?: unknown }
      if (typeof parsed.marker !== 'string' || !Array.isArray(parsed.plan)) return json(res, 400, { error: 'marker and plan' })
      rules.push({ marker: parsed.marker, plan: parsed.plan.map(String), seen: 0 })
      note({ arm: parsed })
      return json(res, 200, { ok: true })
    }
    case '/__uitest/state':
      return json(res, 200, { posts })
    case '/__uitest/rows': {
      const kind = url.searchParams.get('kind')
      const id = url.searchParams.get('id') ?? ''
      const text = url.searchParams.get('text') ?? ''
      const read = kind === 'session'
        ? await apiCall('GET', `/api/v1/sessions/${encodeURIComponent(id)}/transcript?fresh=1`)
        : await apiCall('GET', `/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=200`)
      const rows = rowsOf(read.body).filter((r) => typeof r.text === 'string' && r.text.includes(text))
      return json(res, 200, {
        status: read.status,
        user: rows.filter((r) => r.role === 'user').length,
        assistant: rows.filter((r) => r.role === 'assistant').length,
      })
    }
    case '/__uitest/shot': {
      const name = (url.searchParams.get('name') ?? 'shot').replace(/[^A-Za-z0-9_.-]/g, '_')
      fs.writeFileSync(path.join(OUT, 'shots', `${name}.png`), body)
      return json(res, 200, { ok: true })
    }
    case '/__uitest/log':
      fs.appendFileSync(path.join(OUT, 'uitest.log'), body.toString('utf8') + '\n')
      return json(res, 200, { ok: true })
    default:
      return json(res, 404, { error: 'unknown control' })
  }
}

function forward(
  req: http.IncomingMessage, body: Buffer,
  onAnswer: (status: number, headers: http.IncomingHttpHeaders, buf: Buffer) => void,
  res: http.ServerResponse,
): http.ClientRequest {
  return http.request({
    host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
  }, (upRes) => {
    const chunks: Buffer[] = []
    upRes.on('data', (c: Buffer) => chunks.push(c))
    upRes.on('end', () => onAnswer(upRes.statusCode ?? 502, upRes.headers, Buffer.concat(chunks)))
  }).on('error', (err) => {
    note({ upstreamError: String(err), url: req.url })
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
}

const proxy = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://proxy')
    if (url.pathname.startsWith('/__uitest/')) return control(req, res, url)
    const match = req.method === 'POST' ? MESSAGE_POST.exec(url.pathname) : null
    if (!match) {
      // Everything else, streams included, is passed through as it flows.
      const up = http.request({
        host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      res.on('close', () => up.destroy())
      req.pipe(up)
      return
    }
    const body = await readBody(req)
    let parsed: { text?: unknown; messageId?: unknown } | null = null
    try { parsed = JSON.parse(body.toString('utf8')) } catch { parsed = null }
    const text = typeof parsed?.text === 'string' ? parsed.text : ''
    const rule = rules.find((r) => text.includes(r.marker))
    const step = rule ? (rule.plan[rule.seen++] ?? 'pass') : 'pass'
    const post: Post = {
      n: posts.length + 1,
      kind: match[1] === 'sessions' ? 'session' : 'chat',
      url: url.pathname,
      conversationId: decodeURIComponent(match[2]),
      text,
      messageId: typeof parsed?.messageId === 'string' ? parsed.messageId : null,
      step,
      status: null,
      forwarded: false,
      clientGone: false,
      at: new Date().toISOString(),
    }
    posts.push(post)
    note({ post })
    res.on('close', () => { if (!res.writableEnded) { post.clientGone = true; note({ clientGone: post.n }) } })
    const [kind, msRaw] = step.split(':')
    const ms = Number(msRaw ?? 0)
    if (kind === 'refuse503') {
      post.status = 503
      return json(res, 503, { error: { code: 'bridge_offline', message: 'The host is offline (send-once UI harness)' } })
    }
    if (kind === 'stall') {
      setTimeout(() => {
        if (post.clientGone || res.destroyed) return
        post.status = 504
        res.writeHead(504, { 'content-type': 'text/plain' })
        res.end('Gateway Timeout')
        note({ stalled: post.n, status: 504 })
      }, ms)
      return
    }
    post.forwarded = true
    forward(req, body, (status, headers, buf) => {
      post.status = status
      note({ answer: post.n, status, body: buf.toString('utf8').slice(0, 300) })
      const answer = (): void => {
        if (post.clientGone || res.destroyed) { note({ answerDropped: post.n }); return }
        res.writeHead(status, headers)
        res.end(buf)
      }
      if (kind === 'hold') setTimeout(answer, ms)
      else answer()
    }, res).end(body)
  })().catch((err: unknown) => {
    note({ proxyError: String(err) })
    if (!res.headersSent) json(res, 500, { error: 'proxy' })
  })
})
proxy.on('upgrade', (req, socket, head) => {
  const up = net.connect(API_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
  socket.on('close', () => up.destroy())
})
await new Promise<void>((resolve, reject) => {
  proxy.once('error', reject)
  proxy.listen(PROXY_PORT, '127.0.0.1', () => resolve())
})

// ── Lifetime ──────────────────────────────────────────────────────────────────

let stopping = false
async function shutdown(why: string): Promise<void> {
  if (stopping) return
  stopping = true
  note({ shutdown: why })
  proxy.close()
  const teardown = (async () => {
    sessionRunner.setTestDaemonUrl(undefined)
    await stopServer()
    await daemon.stop().catch(() => {})
    // startServer() warms the real local daemon into this run's own daemon dir.
    const { localDaemon } = await import('../../../src/providers/local-daemon.js')
    await localDaemon.stopIfIsolated()
  })()
  await Promise.race([teardown.catch(() => {}), new Promise((r) => setTimeout(r, 10_000))])
  fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 })
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', () => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
})
const { armGracefulSignalExit } = await import('../../../src/web/server.js')
armGracefulSignalExit()
const parent = process.ppid
const maxMs = Number(process.env.SEND_ONCE_UI_MAX_MIN ?? 40) * 60_000
const startedAt = Date.now()
setInterval(() => {
  let parentAlive = process.ppid === parent
  try { process.kill(parent, 0) } catch { parentAlive = false }
  if (!parentAlive) void shutdown('parent gone')
  else if (Date.now() - startedAt > maxMs) void shutdown('lifetime')
}, 2_000).unref()

fs.writeFileSync(path.join(OUT, 'ready.json'), JSON.stringify({
  server: `http://127.0.0.1:${PROXY_PORT}`, token, sessions,
}))
note({ ready: true, proxyPort: PROXY_PORT, apiPort: API_PORT, home: tmpBase })
console.log(`send-once UI harness ready on http://127.0.0.1:${PROXY_PORT}`)
