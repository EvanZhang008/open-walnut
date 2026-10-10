/**
 * A host server that answers alone, for real (docs/plan/walnut-servers-everywhere.md,
 * "Host server, leader away"): a real daemon (the source twin as a node process,
 * or the standalone twin under bun), the real host server program in this
 * process, a mock Claude CLI the daemon runs as a session, and a stand-in for
 * the Mac that links to the daemon the way the real one does (leader.configure,
 * host.slice, server.configure, start) and sends the host server its device
 * copy over a stream. No companion: once the Mac unlinks, the host server is alone.
 *
 * Used by tests/e2e/host-server-alone-e2e.test.ts and the Playwright fixture
 * tests/e2e/browser/host-alone-server.ts. Everything lives in one temp dir.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

export const HOME = '/fixture/mac-home'
export const WALNUT = 'whostalone01'
export const LIVE = 'aaaaaaaa-1111-4111-8111-111111111111'
export const STOPPED = 'bbbbbbbb-2222-4222-8222-222222222222'
export const ASIDE = 'cccccccc-3333-4333-8333-333333333333'
export const TASK = 'mfixbld0-0001'
export const TOKEN = 'browser-token-' + 'x'.repeat(40)
export const DEVICE = 'browser-a1b2c3'
const ROOT = path.resolve(import.meta.dirname, '..', '..')

export const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

/** Answers a person's message with "echo: <text>", and asks to run a tool for one with "ASK:". */
const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const dir = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
let asked = 0
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  return ''
}
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'control_response') { fs.appendFileSync(dir + '/' + sid + '.resp.jsonl', JSON.stringify(msg) + '\\n'); continue }
    if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); continue }
    if (msg.type !== 'user') continue
    const text = textOf(msg.message && msg.message.content)
    fs.appendFileSync(dir + '/' + sid + '.inbox.jsonl', JSON.stringify({ text }) + '\\n')
    if (text.includes('ASK:')) {
      out({ type: 'control_request', request_id: 'perm-' + (++asked), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls docs/' }, decision_reason: 'Bash is not allowed yet' } })
      continue
    }
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + text, session_id: sid })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  }
})
setInterval(() => {}, 1 << 30)
`

export interface MacDoor { server: http.Server; seen: string[] }

export interface HostAloneHarness {
  base: string
  daemonDir: string
  twin: 'source' | 'standalone'
  publicPort: number
  /** The Mac links to the daemon (and the host server routes to its door); returns once linked. */
  linkMac(): Promise<void>
  unlinkMac(): void
  /** The Mac falls asleep: its socket stays open, nothing comes from it (no beat, no pong). */
  silenceMac(): void
  wakeMac(): void
  macLinked(): boolean
  /** A command on the Mac's link. */
  macCmd(body: Record<string, unknown>): Promise<Record<string, any>>
  /** The Mac pushes its device list to the host server, as core/replication/device-replica.ts does. */
  pushDevices(devices: Array<{ name: string; tokenHash: string }>): Promise<{ status: number; json: Record<string, any> }>
  route(): string
  /** The token the daemon started its server with (what follower.hello presents). */
  followerToken(): string
  daemonPort(): number
  inbox(sid: string): string[]
  responses(sid: string): Array<Record<string, any>>
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function waitFor<T>(fn: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(100)
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

export const tokenHash = (token: string) => crypto.createHash('sha256').update(token, 'utf-8').digest('hex')

export async function startHostAloneHarness(opts: { twin?: 'source' | 'standalone'; publicPort?: number } = {}): Promise<HostAloneHarness> {
  const twin = opts.twin ?? 'source'
  const [{ getDaemonSource }, { createStreamEndpoint, spliceStream }, { startHostServer }] = await Promise.all([
    import('../../src/providers/daemon-source.js'),
    import('../../src/lib/link-stream.js'),
    import('../../src/host-server/main.js'),
  ])
  // Short: the gateway's unix socket path must fit in 104 bytes on macOS.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hal-'))
  const daemonDir = path.join(base, 'd')
  fs.mkdirSync(daemonDir)
  const procs: ChildProcess[] = []

  // The Mac's door: what a browser sees through the host server while the Mac answers.
  const door: MacDoor = { server: http.createServer(), seen: [] }
  door.server.on('request', (req, res) => {
    door.seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Walnut</title><main data-testid="mac-console">The Mac console</main>')
  })
  const doorPort = await new Promise<number>((r) => door.server.listen(0, '127.0.0.1', () => r((door.server.address() as net.AddressInfo).port)))

  const env: NodeJS.ProcessEnv = {
    ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let daemon: ChildProcess
  if (twin === 'source') {
    const script = path.join(daemonDir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    if (!BUN) throw new Error('the standalone twin needs bun')
    daemon = spawn(BUN, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  procs.push(daemon)
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.port')) && fs.existsSync(path.join(daemonDir, 'daemon.pid')), 60_000, 'daemon')
  const daemonPid = Number(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'))
  const daemonPort = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8'))

  let mac: { ws: WebSocket; beat: ReturnType<typeof setInterval>; streams: ReturnType<typeof createStreamEndpoint>; pending: Map<number, (m: Record<string, any>) => void> } | null = null
  let cmdId = 1
  function macCmd(body: Record<string, unknown>): Promise<Record<string, any>> {
    const m = mac
    if (!m) return Promise.reject(new Error('the Mac is not linked'))
    return new Promise((resolve, reject) => {
      const id = cmdId++
      const t = setTimeout(() => { m.pending.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
      m.pending.set(id, (r) => { clearTimeout(t); resolve(r) })
      m.ws.send(JSON.stringify({ id, ...body }))
    })
  }
  const slice = {
    v: 1, home: HOME, hash: 'h-alone', asOf: Date.now(), host: 'devbox',
    sessions: [
      { sid: LIVE, taskId: TASK, title: 'Fix the build' },
      { sid: STOPPED, title: 'Old report' },
      { sid: ASIDE, title: 'Environment lane', aside: true },
    ],
    tasks: [{ id: TASK, title: 'Release: fix the build', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
  }
  async function linkMac(): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    const pending = new Map<number, (m: Record<string, any>) => void>()
    const streams = createStreamEndpoint({
      send: (frame) => ws.send(JSON.stringify(frame)),
      accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(doorPort, '127.0.0.1')) : null),
    })
    ws.on('message', (data) => {
      let m: Record<string, any>
      try { m = JSON.parse(String(data)) } catch { return }
      if (streams.handle(m)) return
      const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
      if (p) { pending.delete(m.id); p(m) }
    })
    ws.on('close', () => streams.closeAll('closed'))
    const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
    mac = { ws, beat, streams, pending }
    const configured = await macCmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })
    if (!configured.ok) throw new Error('leader.configure: ' + JSON.stringify(configured))
    const sliced = await macCmd({ cmd: 'host.slice', slice: { ...slice, asOf: Date.now() } })
    if (!sliced.ok) throw new Error('host.slice: ' + JSON.stringify(sliced))
  }
  function silenceMac(): void {
    if (!mac) return
    clearInterval(mac.beat)
    ;(mac.ws as unknown as { _socket: { pause(): void } })._socket.pause()
  }
  function wakeMac(): void {
    const m = mac
    if (!m) return
    ;(m.ws as unknown as { _socket: { resume(): void } })._socket.resume()
    m.beat = setInterval(() => { try { m.ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
  }
  function unlinkMac(): void {
    if (!mac) return
    clearInterval(mac.beat)
    mac.ws.close()
    mac = null
  }

  await linkMac()
  const publicPort = opts.publicPort ?? await freePort()
  // The daemon's server is a stand-in that hands this harness the token it was
  // started with; the host server itself runs in this process.
  const tokenFile = path.join(base, 'token')
  const spec = {
    v: 1, home: HOME, walnutId: WALNUT, command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
    cwd: base, env: {}, log: path.join(base, 'placeholder.log'), port: publicPort,
    settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
  }
  const configured = await macCmd({ cmd: 'server.configure', home: HOME, spec })
  if (!configured.ok) throw new Error('server.configure: ' + JSON.stringify(configured))
  const [followerToken, placeholderPid] = (await waitFor(() => { try { return fs.readFileSync(tokenFile, 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')

  // The two sessions the daemon runs: one live, and one that stopped (it stays in the copy).
  const mock = path.join(base, 'mock-cli.cjs')
  fs.writeFileSync(mock, MOCK_CLI)
  for (const sid of [LIVE, STOPPED]) {
    const started = await macCmd({ cmd: 'start', sid, cwd: base, message: 'init', args: [process.execPath, mock, sid, base], origin: { home: HOME, ...(sid === LIVE ? { task: TASK } : {}) } })
    if (!started.ok) throw new Error('start: ' + JSON.stringify(started))
    await waitFor(() => { try { return fs.readFileSync(path.join(daemonDir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
  }
  const stopped = await macCmd({ cmd: 'stop', sid: STOPPED, reason: 'user', home: HOME })
  if (!stopped.ok) throw new Error('stop: ' + JSON.stringify(stopped))

  const hostServer = await startHostServer({
    env: { publicPort, daemonDir, leaderHome: HOME, walnutId: WALNUT, followerToken: followerToken!, label: 'devbox' },
  })
  await waitFor(() => hostServer.route().kind === 'leader', 15_000, 'the leader route')

  async function pushDevices(devices: Array<{ name: string; tokenHash: string }>): Promise<{ status: number; json: Record<string, any> }> {
    if (!mac) throw new Error('the Mac is not linked')
    const { deviceListHash } = await import('../../src/core/replication/device-replica.js')
    const stream = await mac.streams.open('follower', { purpose: 'test' })
    const data = Buffer.from(JSON.stringify({ op: 'put', kind: 'devices', devices, hash: deviceListHash(devices) }))
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST', path: '/bridge/replica', headers: { host: 'host-server', 'content-type': 'application/json', 'content-length': data.length },
        createConnection: () => stream,
      } as http.RequestOptions, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || '{}') }))
      })
      req.on('error', reject)
      req.end(data)
    })
  }

  const lines = (file: string) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  return {
    base, daemonDir, twin, publicPort,
    linkMac, unlinkMac, silenceMac, wakeMac, macLinked: () => mac !== null, macCmd, pushDevices,
    route: () => hostServer.route().kind,
    followerToken: () => followerToken!,
    daemonPort: () => daemonPort,
    inbox: (sid) => lines(path.join(base, `${sid}.inbox.jsonl`)).map((l) => String(JSON.parse(l).text)),
    responses: (sid) => lines(path.join(base, `${sid}.resp.jsonl`)).map((l) => JSON.parse(l) as Record<string, any>),
    async stop() {
      try { if (mac) await macCmd({ cmd: 'server.configure', home: HOME, spec: null }) } catch { /* gone */ }
      await hostServer.stop().catch(() => undefined)
      unlinkMac()
      for (const pid of [Number(placeholderPid), daemonPid]) {
        if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
      }
      for (const p of procs) { try { p.kill('SIGTERM') } catch { /* gone */ } }
      door.server.close()
      await sleep(500)
      if (!process.env.KEEP_HOST_ALONE) fs.rmSync(base, { recursive: true, force: true })
    },
  }
}
