/**
 * Two daemon-side halves of the phone send path, both twins, real processes.
 *
 * 1. A relay whose target closes before it answers moves to the next trusted
 *    client at once (rerouteMessageRelays). Matrix L5 (2026-10-03): after a
 *    silent link to the Mac cleared, the daemon still listed the Mac's old
 *    sockets; each relay written to one closed it a millisecond later, and
 *    the relay then waited out its whole 45 s timeout, three times in a row,
 *    while the Mac's fresh links sat idle.
 * 2. markers.find (marker-find-v1): the companion asks which of a session's
 *    phone messages have a delivery marker, over the bridge, and only the ids
 *    found come back (gate r3, N6: a marker hours of output back was never
 *    found in the 2 MB tail the companion used to pull).
 *
 * The harness is the one of daemon-relay-target-liveness.test.ts: the source
 * twin under node (its hand-rolled WebSocket server), the standalone twin under
 * bun when bun is installed, a fake cloud that plays the bridge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOST_ALIAS = 'reroute-host'
const SID = 'sid-reroute-1'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-reroute-${twin}-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
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

/** A walnut server: pings like one; `answers` = it answers each message-request, else it closes on the first. */
async function trusted(port: number, answers: boolean): Promise<{ ws: WebSocket; seen: string[] }> {
  const ws = await connect(port)
  const seen: string[] = []
  ws.on('message', (d: Buffer) => {
    let m: Record<string, unknown>
    try { m = JSON.parse(d.toString()) } catch { return }
    if (m.ev !== 'message-request') return
    seen.push(String(m.messageId))
    if (!answers) { ws.close(); return }
    ws.send(JSON.stringify({ id: 60_000 + Number(m.relayId), cmd: 'message-result', relayId: m.relayId, result: { messageId: m.messageId } }))
  })
  const pinger = setInterval(() => { try { ws.ping() } catch { /* closed */ } }, 150)
  ws.once('close', () => clearInterval(pinger))
  return { ws, seen }
}

describe.each(bunPath ? (['source', 'standalone'] as const) : (['source'] as const))('relay re-route and markers.find (%s twin)', (twin) => {
  let daemon: Daemon
  let cloud: WebSocketServer
  let bridgeSide: WebSocket | null = null
  const open: WebSocket[] = []

  beforeAll(async () => {
    cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => cloud.on('listening', () => r()))
    cloud.on('connection', (ws) => {
      ws.on('message', (d) => {
        try { if ((JSON.parse(d.toString()) as { ev?: string }).ev === 'hello') bridgeSide = ws as unknown as WebSocket } catch { /* frame */ }
      })
    })
    daemon = await spawnDaemon(twin)
    const setup = await connect(daemon.port)
    const port = (cloud.address() as { port: number }).port
    const conf = await rpc(setup, 'bridge.configure', { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: 't', hostAlias: HOST_ALIAS })
    expect(conf.ok).toBe(true)
    await waitFor(() => bridgeSide !== null, 15_000, 'the bridge hello')
    setup.close()
    await sleep(300)
  }, 60_000)

  afterAll(async () => {
    for (const ws of open) { try { ws.close() } catch { /* gone */ } }
    await stopDaemon(daemon)
    await new Promise<void>((r) => cloud.close(() => r()))
  })

  const phoneSend = (messageId: string) =>
    rpc(bridgeSide!, 'session.message', { sessionId: SID, message: 'hello', messageId })

  it('a relay whose target closes before answering goes to the next client at once, answered once', async () => {
    const dying = await trusted(daemon.port, false)
    const live = await trusted(daemon.port, true)
    open.push(dying.ws, live.ws)
    await sleep(200)
    const t0 = Date.now()
    const res = await phoneSend('qm-mobile-reroute-1')
    const ms = Date.now() - t0
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(ms, 'not the 45 s relay timeout').toBeLessThan(5_000)
    expect(dying.seen).toEqual(['qm-mobile-reroute-1'])
    expect(live.seen).toEqual(['qm-mobile-reroute-1'])
    live.ws.close()
    await sleep(300)
  }, 30_000)

  it('with no other client, it answers at once as a timeout (it may have arrived), never as "no primary"', async () => {
    const dying = await trusted(daemon.port, false)
    open.push(dying.ws)
    await sleep(200)
    const t0 = Date.now()
    const res = await phoneSend('qm-mobile-reroute-2')
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(res.ok).not.toBe(true)
    // "timed out": the companion holds it and asks the Mac; "no primary" would let it go directly.
    expect(String(res.error)).toMatch(/^session\.message: primary server timed out/)
    expect(String(res.error)).not.toContain('no primary server connected')
    expect(dying.seen).toEqual(['qm-mobile-reroute-2'])
    await sleep(300)
  }, 30_000)

  it('markers.find over the bridge: the ids with a marker, newest bytes first, the whole file searched', async () => {
    const streams = path.join(daemon.dir, 'streams')
    fs.mkdirSync(streams, { recursive: true })
    const marker = JSON.stringify({ type: 'user', subtype: 'walnut-injected', walnutMessageId: 'qm-mobile-mf-old' })
    // The marker sits before 5 MB of later output (past one 4 MB read, and far past the old 2 MB tail).
    const filler = (JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n').repeat(5 * 1024)
    fs.writeFileSync(path.join(streams, `${SID}.jsonl`), marker + '\n' + filler)
    const res = await rpc(bridgeSide!, 'markers.find', { sid: SID, ids: ['qm-mobile-mf-old', 'qm-mobile-mf-never'] })
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true)
    expect(res.found).toEqual(['qm-mobile-mf-old'])
    expect(res.complete).toBe(true)
    expect(res.ordered).toBe(true)
    expect(Number(res.size)).toBeGreaterThan(5 * 1024 * 1024)
  }, 30_000)

  it('markers.find: a session with no stream has nothing to find; bad input is refused', async () => {
    const none = await rpc(bridgeSide!, 'markers.find', { sid: 'sid-never-ran', ids: ['qm-mobile-mf-x'] })
    expect(none).toMatchObject({ ok: true, found: [], complete: true })
    for (const sid of ['../escape', 'a/b', 'a\\b']) {
      const bad = await rpc(bridgeSide!, 'markers.find', { sid, ids: ['qm-mobile-mf-x'] })
      expect(bad.ok, sid).not.toBe(true)
    }
    const many = await rpc(bridgeSide!, 'markers.find', { sid: SID, ids: Array.from({ length: 201 }, (_, i) => `qm-mobile-mf-${i}`) })
    expect(many.ok).not.toBe(true)
    const empty = await rpc(bridgeSide!, 'markers.find', { sid: SID, ids: [''] })
    expect(empty.ok).not.toBe(true)
  }, 30_000)
})

describe('one trusted-client beat per twin, and the send-markers flag', () => {
  const twins = {
    source: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8'),
    standalone: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8'),
  }
  it.each(Object.keys(twins) as Array<keyof typeof twins>)('%s: the beat is parsed once and every trusted-client timer reads it', (twin) => {
    const src = twins[twin]
    // Two parses (or one shadowing the other in a block) would let the
    // keepalive and the relay pick run on different beats.
    expect(src.match(/WALNUT_TRUSTED_CLIENT_BEAT_MS/g) ?? []).toHaveLength(1)
    expect(src.match(/\b(?:var|const|let) TRUSTED_CLIENT_BEAT_MS\s*=/g) ?? []).toHaveLength(1)
    // No second name for the beat: every timer reads TRUSTED_CLIENT_BEAT_MS.
    expect(src).not.toMatch(/(?<!BRIDGE_)\bPING_INTERVAL_MS\b/)
  })
  it.each(Object.keys(twins) as Array<keyof typeof twins>)('%s: the status reply says markers ride inside the send, and markers.find is bridge-allowed', (twin) => {
    const src = twins[twin]
    expect(src).toMatch(/sendMarkers: true/)
    expect(src).toMatch(/'markers\.find',/)
  })
})
