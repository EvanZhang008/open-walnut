/**
 * Which trusted client a daemon relay goes to (pickTrustedClient, both twins).
 *
 * The field state this pins (2026-10-01): the walnut server's SSH port forward
 * to a host died on the far side, the host's sshd kept the forwarded socket to
 * the daemon open, and nothing ever came back on it. The daemon relayed every
 * phone send to that socket (the FIRST trusted client), each relay timed out,
 * and even after the Mac reconnected its fresh socket sat behind the dead one.
 *
 * Real daemon processes: the source twin under node (no `ws` package next to
 * it, so its hand-rolled WebSocket server runs, as on a remote host), and the
 * standalone twin under bun when bun is installed. A "dead" client is a real
 * socket whose reader is paused: it stays open and sends nothing, exactly a
 * forward with no one behind it. A fake cloud plays the bridge, which is where
 * phone sends come from. The beat is shortened to 500ms through the test-only
 * env knob, so "fresh" is 667ms and "quiet" is 1.5s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BEAT_MS = 500
const FRESH_MS = Math.round(BEAT_MS * 4 / 3)
const QUIET_MS = BEAT_MS * 3
const HOST_ALIAS = 'liveness-host'

const bunPath = (() => {
  const candidates = [process.env.WALNUT_TEST_BUN, path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  for (const p of candidates) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

async function spawnDaemon(twin: 'source' | 'standalone'): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-liveness-${twin}-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT_MS),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ${b.toString()}`))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

async function stopDaemon(d: Daemon): Promise<void> {
  const exited = new Promise((r) => d.proc.once('exit', r))
  // Only the pid the isolated daemon wrote into its own temp dir.
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([exited, sleep(3_000)])
  fs.rmSync(d.dir, { recursive: true, force: true })
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

let nextId = 1
function rpc(ws: WebSocket, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`rpc timeout: ${cmd}`)) }, 15_000)
    const on = (d: Buffer) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>
      if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

interface Client {
  ws: WebSocket
  /** message-requests this client was handed (it answers each one). */
  seen: () => number
  /** Stop pinging and stop reading: the forward died with the socket left open. */
  goSilent: () => void
}

describe.each(bunPath ? (['source', 'standalone'] as const) : (['source'] as const))('relay target liveness (%s twin)', (twin) => {
  let daemon: Daemon
  let cloud: WebSocketServer
  let bridgeSide: WebSocket | null = null
  let clients: Client[] = []

  /** A trusted client, alive: it pings on a sub-beat cadence the way a walnut server does. */
  async function trusted(): Promise<Client> {
    const ws = await connect(daemon.port)
    let seen = 0
    ws.on('message', (d: Buffer) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(d.toString()) } catch { return }
      if (m.ev !== 'message-request') return
      seen++
      ws.send(JSON.stringify({ id: 50_000 + Number(m.relayId), cmd: 'message-result', relayId: m.relayId, result: { messageId: m.messageId } }))
    })
    const pinger = setInterval(() => { try { ws.ping() } catch { /* closed */ } }, 150)
    const client: Client = {
      ws,
      seen: () => seen,
      goSilent: () => {
        clearInterval(pinger)
        ;(ws as unknown as { _socket: { pause: () => void } })._socket.pause()
      },
    }
    ws.once('close', () => clearInterval(pinger))
    clients.push(client)
    return client
  }

  const phoneSend = (messageId: string) =>
    rpc(bridgeSide!, 'session.message', { sessionId: 'sid-1', message: 'hello', messageId })

  beforeAll(async () => {
    cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => cloud.on('listening', () => r()))
    cloud.on('connection', (ws) => {
      ws.on('message', (d) => {
        try { if ((JSON.parse(d.toString()) as { ev?: string }).ev === 'hello') bridgeSide = ws as unknown as WebSocket } catch { /* frame */ }
      })
    })
    daemon = await spawnDaemon(twin)
    // The configuring socket is a trusted client too: it closes once the bridge is up.
    const setup = await connect(daemon.port)
    const port = (cloud.address() as { port: number }).port
    const conf = await rpc(setup, 'bridge.configure', { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: 't', hostAlias: HOST_ALIAS })
    expect(conf.ok).toBe(true)
    await waitFor(() => bridgeSide !== null, 15_000, 'the bridge hello')
    setup.close()
    await sleep(300)
  }, 60_000)

  afterEach(async () => {
    for (const c of clients) { c.goSilent(); try { c.ws.terminate() } catch { /* gone */ } }
    clients = []
    // Let the daemon see every close before the next case counts clients.
    await sleep(300)
  })

  afterAll(async () => {
    await stopDaemon(daemon)
    await new Promise<void>((r) => cloud.close(() => r()))
  })

  // First, while no case has connected a client yet: a client a case closed
  // leaves the list only when the daemon sees its close, which on a half-closed
  // socket is the JS twin's own FIN handling, not the pick this case pins.
  it('no trusted client at all keeps the plain contract text', async () => {
    const res = await phoneSend('qm-mobile-empty-1')
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toBe('session.message: no primary server connected')
  }, 30_000)

  it('two live servers: the relay keeps going to the one that connected first', async () => {
    const first = await trusted()
    const second = await trusted()
    await sleep(FRESH_MS + 200)
    for (const id of ['qm-mobile-two-1', 'qm-mobile-two-2', 'qm-mobile-two-3']) {
      const res = await phoneSend(id)
      expect(res.ok, JSON.stringify(res)).toBe(true)
    }
    expect(first.seen()).toBe(3)
    expect(second.seen()).toBe(0)
  }, 30_000)

  it('a socket that went quiet is never a target; the live one behind it is', async () => {
    const dead = await trusted()
    dead.goSilent()
    const live = await trusted()
    await sleep(QUIET_MS + 500)
    const res = await phoneSend('qm-mobile-quiet-1')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(live.seen()).toBe(1)
    expect(dead.seen()).toBe(0)
  }, 30_000)

  it('a redial beats the socket it replaces as soon as that one misses a beat', async () => {
    const old = await trusted()
    await sleep(300)
    old.goSilent()
    const redial = await trusted()
    // Old: silent past one beat, not yet quiet. Redial: fresh.
    await sleep(FRESH_MS + 300)
    expect(FRESH_MS + 300 + 150).toBeLessThan(QUIET_MS)
    const res = await phoneSend('qm-mobile-redial-1')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(redial.seen()).toBe(1)
    expect(old.seen()).toBe(0)
  }, 30_000)

  it('with every trusted client quiet, the relay says so at once and hands nothing over', async () => {
    const only = await trusted()
    only.goSilent()
    await sleep(QUIET_MS + 500)
    const t0 = Date.now()
    const res = await phoneSend('qm-mobile-none-1')
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(res.ok).not.toBe(true)
    // The prefix is the contract companions key on (provably unsent).
    expect(String(res.error)).toMatch(/^session\.message: no primary server connected \(the last one went quiet \d+s ago\)$/)
    expect(only.seen()).toBe(0)
    // Once it speaks again (here: a fresh server) relays flow again.
    const back = await trusted()
    const again = await phoneSend('qm-mobile-none-2')
    expect(again.ok, JSON.stringify(again)).toBe(true)
    expect(back.seen()).toBe(1)
  }, 30_000)
})
