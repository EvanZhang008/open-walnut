/**
 * A host server from nothing, end to end, with the real compiled walnut file
 * (docs/plan/walnut-servers-everywhere.md, "Runtime"). The "host" is this
 * machine with a temp root and a temp HOME; everything that runs there is real:
 *
 *   the Mac's host-server manager (src/core/host-server/manager.ts)
 *     | the target probe, the install script, the launch and the state polls run in `sh -s` here
 *     |   (on a real host: the same scripts over the Mac's SSH master)
 *     | the file: this checkout's commit built for this machine's target in a clone
 *     |   (host-file.ts + host-file-build.ts, real bun), gzipped, cached
 *     | the upload: written into <root>/incoming here (on a real host: DaemonConnection.uploadFile)
 *     v
 *   a real session daemon (the source twin, a process), linked as the Mac links
 *     | server.configure: `<root>/app/<id>/walnut host-server`
 *     v
 *   the compiled walnut file as the host server: it finds its port with itself
 *   (BUN_BE_BUN=1 <file> -e), links to the daemon, reports, and answers a
 *   browser on its public port by a stream through the daemon to the Mac's door.
 *
 * What a real Linux host adds (its SSH, an old glibc, musl) is not here: the
 * probe and the script are tested against those systems' answers in
 * host-server-target.test.ts and host-server-install.test.ts.
 *
 * Needs bun of the pinned version (the build; WALNUT_BUN points at one). WALNUT_HOST_FILE_E2E_CACHE keeps the built file across
 * runs (default: a dir in the temp dir, one per commit).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createStreamEndpoint, spliceStream, type StreamEndpoint } from '../../src/lib/link-stream.js'
import { createHostServerManager, type HostServerHost, type HostServerManager } from '../../src/core/host-server/manager.js'
import { createHostFileSource } from '../../src/core/host-server/host-file.js'
import { findBun, pinnedBun } from '../../src/core/host-server/host-file-build.js'
import { gitChildEnv } from '../../src/lib/git-env.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/mac-home'
const WALNUT = 'wmachostfile1'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(200)
  }
}

const bunPick = await findBun(process.env, pinnedBun(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')))
if ('why' in bunPick) console.warn(`host-server-file-e2e: skipped: ${bunPick.why}`)
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, env: gitChildEnv(), encoding: 'utf8' }).trim()
const id = `${version}-${commit}`

let base = ''
let hostHome = ''
let hostRoot = ''
let daemon: ChildProcess | null = null
let daemonPort = 0
let macDoor: http.Server
let macDoorPort = 0
let link: { ws: WebSocket; streams: StreamEndpoint; cmd: (b: Record<string, unknown>) => Promise<Record<string, any>>; beat: ReturnType<typeof setInterval> } | null = null
let manager: HostServerManager | null = null
const uploads: Array<{ path: string; bytes: number }> = []
/** The host server's pid, as the daemon reports it. */
let serverPid = 0

async function linkAsMac() {
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const pending = new Map<number, (m: Record<string, any>) => void>()
  // A browser's request to the host server reaches this Mac's tunnel port as a stream through the daemon.
  const streams = createStreamEndpoint({
    send: (frame) => ws.send(JSON.stringify(frame)),
    accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(macDoorPort, '127.0.0.1')) : null),
  })
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (streams.handle(m)) return
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
    if (p) { pending.delete(m.id); p(m) }
  })
  let next = 1
  const cmd = (body: Record<string, unknown>) => new Promise<Record<string, any>>((resolve, reject) => {
    const n = next++
    const t = setTimeout(() => { pending.delete(n); reject(new Error(`${String(body.cmd)} timed out`)) }, 20_000)
    pending.set(n, (m) => { clearTimeout(t); resolve(m) })
    ws.send(JSON.stringify({ id: n, ...body }))
  })
  const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
  expect((await cmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
  return { ws, streams, cmd, beat }
}

/** The host as the manager sees it: its daemon over the link, its shell and its disk here. */
function host(): HostServerHost {
  return {
    hostKey: 'devbox',
    connected: true,
    hasCapability: (cap) => ['host-server-v1', 'follower-v1', 'stream-relay-v1'].includes(cap),
    async send(cmd, params) { return link!.cmd({ cmd, ...(params ?? {}) }) },
    runRemoteScript: (script, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      const child = spawn('sh', ['-s'], { env: { HOME: hostHome, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: os.tmpdir() }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(out); else reject(new Error(`sh exited ${code}: ${err.trim().slice(-300)}`)) })
      child.stdin.end(script)
    }),
    async uploadFile(remotePath, data) {
      uploads.push({ path: remotePath, bytes: data.length })
      fs.mkdirSync(path.dirname(remotePath), { recursive: true })
      fs.writeFileSync(`${remotePath}.part`, data)
      fs.renameSync(`${remotePath}.part`, remotePath)
    },
    async openStream() { throw new Error('this test opens no stream to the host server') },
  }
}

const cacheDir = process.env.WALNUT_HOST_FILE_E2E_CACHE || path.join(os.tmpdir(), 'walnut-host-file-e2e-cache')

describe.skipIf('why' in bunPick)('a host server from nothing: the compiled file built, installed and started by the manager', () => {
  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsfe-')))
    hostHome = path.join(base, 'host-home')
    hostRoot = path.join(base, 'host-root')
    fs.mkdirSync(hostHome)
    macDoor = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`mac door: ${req.method} ${req.url}`) })
    await new Promise<void>((r) => macDoor.listen(0, '127.0.0.1', () => r()))
    macDoorPort = (macDoor.address() as net.AddressInfo).port
    const daemonDir = path.join(base, 'd')
    fs.mkdirSync(daemonDir)
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: hostHome, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
      WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'),
    }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
    const script = path.join(daemonDir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
    else daemon.stderr?.resume()
    await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.port')), 60_000, 'the daemon')
    daemonPort = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8'))
    link = await linkAsMac()
    manager = createHostServerManager({
      settingsOf: async () => ({ enabled: true, program: 'host-server', expose: { enabled: false, provider: null, options: {} } }),
      label: async () => 'Dev box',
      walnutId: async () => WALNUT,
      home: HOME,
      holdTunnelPort: async () => macDoorPort,
      releaseTunnelPort: async () => {},
      // This checkout's HEAD, built for whatever the probe says this machine is.
      hostFile: createHostFileSource({
        cacheDir,
        origin: async () => ({ kind: 'checkout', checkout: ROOT, distDir: path.join(ROOT, 'dist'), id, info: { version, commit, branch: null, builtAt: null, dirty: false } }),
      }),
      stateFile: path.join(base, 'host-servers.json'),
      now: Date.now,
      hostRoot,
      installPollMs: 200,
      firstReportMs: 60_000,
    })
  }, 30 * 60_000)

  afterAll(async () => {
    manager?.stop()
    try { if (link) await link.cmd({ cmd: 'server.configure', home: HOME, spec: null }) } catch { /* gone */ }
    // The host server is the daemon's child in its own group; the daemon's stop takes up to 10 s.
    if (serverPid > 1) await waitFor(() => { try { process.kill(serverPid, 0); return false } catch { return true } }, 15_000, 'the host server to stop').catch(() => undefined)
    if (link) { clearInterval(link.beat); link.ws.close() }
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await new Promise((r) => { daemon!.once('exit', r); setTimeout(r, 10_000) })
    }
    macDoor?.close()
    if (base) fs.rmSync(base, { recursive: true, force: true })
  }, 60_000)

  it('installs the file for this machine under the root and starts it; the host needs no Node', async () => {
    await manager!.connected(host())
    const view = manager!.view('devbox')
    expect(view, view.message).toMatchObject({ phase: 'running', build: id, install: { state: 'ready' }, program: 'host-server' })
    // What went to the host: the gz and the script, nothing else.
    expect(uploads.map((u) => path.basename(u.path))).toEqual([`${id}.gz`, `${id}.install.sh`])
    const file = path.join(hostRoot, 'app', id, 'walnut')
    expect(fs.readdirSync(path.join(hostRoot, 'app', id)).sort()).toEqual(['.ready', 'walnut'])
    expect(fs.existsSync(path.join(hostRoot, 'deps'))).toBe(false)
    expect(fs.existsSync(path.join(hostRoot, 'incoming', `${id}.gz`))).toBe(false)
    // The file's runtime tree is unpacked in the host server's data dir, not this machine's ~/.open-walnut.
    expect(fs.readdirSync(path.join(hostRoot, 'data', 'local', 'runtime')).some((n) => n.startsWith(`${version}-`))).toBe(true)
    // It is the file this checkout's commit builds, for this machine.
    const printed = spawnSync(file, ['--version'], { env: { HOME: hostHome, OPEN_WALNUT_HOME: path.join(hostRoot, 'data'), PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).stdout.trim()
    expect(printed.startsWith(`${version} (${commit}`)).toBe(true)
    // The daemon runs it as the file, not under a Node.
    const status = (await link!.cmd({ cmd: 'server.status', home: HOME })).status as Record<string, any>
    expect(status).toMatchObject({ state: 'running' })
    serverPid = Number(status.pid)
    const cmdline = execFileSync('ps', ['-o', 'command=', '-p', String(status.pid)], { encoding: 'utf8' }).trim()
    expect(cmdline).toBe(`${file} host-server`)
    expect(manager!.programOf('devbox')).toEqual({ command: file, args: ['host-server'] })
    // Its report came back through the daemon, and a browser on its port reaches the Mac's door.
    expect(view.server?.version).toBe(version)
    const res = await fetch(`http://127.0.0.1:${view.port}/api/anything?x=1`)
    expect(await res.text()).toBe('mac door: GET /api/anything?x=1')
  }, 30 * 60_000)

  it('the next connect installs nothing and keeps the same server process', async () => {
    const before = ((await link!.cmd({ cmd: 'server.status', home: HOME })).status as Record<string, any>).pid
    const sent = uploads.length
    await manager!.connected(host())
    expect(manager!.view('devbox').phase).toBe('running')
    expect(uploads.length).toBe(sent)
    expect(((await link!.cmd({ cmd: 'server.status', home: HOME })).status as Record<string, any>).pid).toBe(before)
  }, 120_000)

  it('the cached file is the one installed (sha256 of the file on the host)', () => {
    const gz = path.join(cacheDir, 'files', id)
    const target = fs.readdirSync(gz).find((n) => n.endsWith('.json'))!
    const meta = JSON.parse(fs.readFileSync(path.join(gz, target), 'utf8')) as { sha256: string }
    const onHost = crypto.createHash('sha256').update(fs.readFileSync(path.join(hostRoot, 'app', id, 'walnut'))).digest('hex')
    expect(onHost).toBe(meta.sha256)
  })
})
