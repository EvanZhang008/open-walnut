/**
 * The host network on BOTH daemon twins booted for real (net-v1, src/providers/net-core.ts,
 * native/walnut-net): each daemon runs its own walnut-net once configured; one daemon
 * ("the Mac") reaches the other ("the host") through a forward, and the socket it gets is
 * the host DAEMON's own (its hello names the host's instance); a member the host no longer
 * lets in is cut and gets no new stream; a walnut-net that dies comes back; `enabled:false`
 * stops it; a daemon that dies takes its walnut-net with it.
 *
 * Needs the walnut-net binary (scripts/build-walnut-net.sh): WALNUT_NET_TEST_BIN, else
 * dist/daemon-binaries/walnut-net-<platform>-<arch>. Without it the suite is skipped.
 * No relay: the Mac is given the host's direct addresses, so nothing leaves this machine.
 *
 * MACHINE SAFETY: HOME, the daemon dirs and the net state are temp paths; every daemon is
 * SIGKILLed after each case (its walnut-net exits on its closed pipe); the only process
 * signalled by pid is a walnut-net this test's daemon reported.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const NET_BIN = (() => {
  const env = process.env.WALNUT_NET_TEST_BIN
  if (env && fs.existsSync(env)) return env
  const built = path.resolve(__dirname, `../../dist/daemon-binaries/walnut-net-${process.platform}-${process.arch}`)
  return fs.existsSync(built) ? built : null
})()

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-twins-')))
afterAll(() => { if (root.includes('wn-net-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
if (BUN && NET_BIN) {
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, 'net-core.cjs'),
    path.resolve(__dirname, '../../src/providers/net-core.ts')], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

interface Daemon { proc: ChildProcess; ws: WebSocket; port: number; rpc: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>> }
const live: Daemon[] = []
afterEach(async () => {
  for (const d of live.splice(0)) {
    try { d.ws.close() } catch { /* closed */ }
    if (d.proc.exitCode === null && d.proc.signalCode === null) {
      const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); d.proc.once('exit', () => { clearTimeout(t); r() }) })
      d.proc.kill('SIGKILL')
      await exited
    }
  }
})

function rpcOn(sock: WebSocket) {
  let rpcId = 1
  return (cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> => {
    const id = rpcId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
      const onMessage = (data: Buffer) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
      }
      sock.on('message', onMessage)
      sock.send(JSON.stringify({ id, ...cmd }))
    })
  }
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url)
    const t = setTimeout(() => { s.terminate(); reject(new Error('ws open timeout')) }, 20_000)
    s.on('open', () => { clearTimeout(t); resolve(s) })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<Daemon> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'd'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'), WALNUT_NET_BIN: NET_BIN!,
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'XDG_STATE_HOME']) delete env[k]
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await openWs(`ws://127.0.0.1:${port}`)
  const d = { proc, ws, port, rpc: rpcOn(ws) }
  live.push(d)
  return d
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until<T>(f: () => Promise<T | null | undefined | false>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe.skipIf(!NET_BIN).each(TWINS)('$name', (twin) => {
  it('runs walnut-net, carries the Mac to the host daemon, cuts a removed member, restarts a dead one', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-').slice(0, 12))
    const host = await boot(twin, path.join(dir, 'h'))
    const mac = await boot(twin, path.join(dir, 'm'))
    const helloHost = await host.rpc({ cmd: 'hello' })
    expect(helloHost.capabilities as string[]).toContain('net-v1')

    // Off until configured; the executable is found.
    expect(await host.rpc({ cmd: 'net.status' })).toMatchObject({ ok: true, available: true, enabled: false, running: false })
    expect(await host.rpc({ cmd: 'net.forward', to: 'nothex' })).toMatchObject({ ok: false })
    expect(await host.rpc({ cmd: 'net.configure', members: [{ id: 'zz' }] })).toMatchObject({ ok: false, error: expect.stringContaining('bad member id') })

    const h0 = await host.rpc({ cmd: 'net.configure', relays: [], members: [] })
    expect(h0).toMatchObject({ ok: true, running: true, endpointId: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const m0 = await mac.rpc({ cmd: 'net.configure', relays: [], members: [] })
    const hostId = String(h0.endpointId)
    const macId = String(m0.endpointId)
    // The key stays put across configures; it is 0600 and outside any synced dir.
    const keyFile = path.join(dir, 'h', 'd', 'net', 'net.key')
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    expect((await host.rpc({ cmd: 'net.configure', relays: [], members: [] })).endpointId).toBe(hostId)

    const st = await host.rpc({ cmd: 'net.status' })
    const addrs = ((st.node as { addrs?: string[] })?.addrs ?? []).filter((a) => !a.startsWith('['))
    expect(addrs.length).toBeGreaterThan(0)
    await host.rpc({ cmd: 'net.configure', relays: [], members: [{ id: macId, name: 'mac', accept: true }] })
    await mac.rpc({ cmd: 'net.configure', relays: [], members: [{ id: hostId, name: 'host', addrs }] })

    // Through the Mac's forward, the socket is the host daemon's own.
    const fwd = await mac.rpc({ cmd: 'net.forward', to: hostId })
    expect(fwd).toMatchObject({ ok: true, port: expect.any(Number) })
    const through = await openWs(`ws://127.0.0.1:${fwd.port}`)
    const hello = await rpcOn(through)({ cmd: 'hello' })
    expect(hello.instanceId).toBe(helloHost.instanceId)
    expect(await mac.rpc({ cmd: 'net.forward', to: hostId })).toMatchObject({ port: fwd.port })
    const probe = await mac.rpc({ cmd: 'net.probe', to: hostId })
    expect(probe).toMatchObject({ ok: true, path: 'direct' })

    // The host no longer lets the Mac in: the live socket is cut, a new one gets nothing.
    const closed = new Promise<void>((r) => through.once('close', () => r()))
    await host.rpc({ cmd: 'net.configure', relays: [], members: [{ id: macId, name: 'mac', accept: false }] })
    await closed
    await expect(openWs(`ws://127.0.0.1:${fwd.port}`)).rejects.toThrow()

    // A walnut-net that dies is started again.
    const pid = Number((await host.rpc({ cmd: 'net.status' })).pid)
    expect(pid).toBeGreaterThan(1)
    process.kill(pid, 'SIGKILL')
    const back = await until(async () => {
      const s = await host.rpc({ cmd: 'net.status' })
      return s.running && s.pid !== pid ? s : null
    }, 'walnut-net to come back')
    expect(back).toMatchObject({ running: true, endpointId: hostId })
    expect(Number(back.restarts)).toBeGreaterThanOrEqual(1)

    // enabled:false stops it and forgets the config; the key stays.
    const hostPid = Number(back.pid)
    expect(await host.rpc({ cmd: 'net.configure', enabled: false })).toMatchObject({ ok: true, running: false, endpointId: hostId })
    expect(await host.rpc({ cmd: 'net.status' })).toMatchObject({ enabled: false, running: false })
    await until(async () => !alive(hostPid), 'the stopped walnut-net to exit', 10_000)
    expect(fs.existsSync(keyFile)).toBe(true)

    // A daemon that dies takes its walnut-net with it (its pipe closes).
    const macPid = Number((await mac.rpc({ cmd: 'net.status' })).pid)
    expect(alive(macPid)).toBe(true)
    mac.proc.kill('SIGKILL')
    await until(async () => !alive(macPid), "the dead daemon's walnut-net to exit", 10_000)
  }, 120_000)
})
