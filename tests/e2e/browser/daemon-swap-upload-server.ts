/**
 * Fixture server for daemon-swap-upload.spec.ts: an upload in the composer while the
 * local daemon is replaced, the way a deploy replaces it.
 *
 * A REAL local daemon, compiled twice from this checkout (two versions, into this
 * fixture's temp dir, never dist/). POST /swap on the control port does what a
 * deploy does on the Mac: the server finds its daemon's version is not the one it
 * expects and restarts it (local-daemon.ts, the version-mismatch path). The old
 * daemon's drain is held open for HOLD_MS by one tracked command still in flight (a
 * write into a FIFO nobody reads yet), as live work held it for 2.6 s on 2026-11-10,
 * so every command that reaches it meanwhile gets the real refusal ("Daemon is
 * shutting down; retry after reconnecting"). /swap answers once a probe saw that
 * refusal; GET /state says which daemon serves now.
 *
 * Never :3456 and never the developer's data: one throwaway directory, removed on exit.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { fixtureHome, fixtureRealHome } from './fixture-home'

const port = Number(process.env.PW_TEST_PORT ?? 3541)
if (port === 3456) throw new Error('Production port is forbidden')
const manifest = process.env.DAEMON_SWAP_MANIFEST
if (!manifest) throw new Error('DAEMON_SWAP_MANIFEST is required')
const HOLD_MS = Number(process.env.DAEMON_SWAP_HOLD_MS ?? 4_000)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
fs.rmSync(manifest, { force: true })
const root = await fixtureHome(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-swap-ui-'))))
const realHome = fixtureRealHome()
const daemonDir = path.join(root, 'daemon')
const readDaemonFile = (name: string) => { try { return fs.readFileSync(path.join(daemonDir, name), 'utf8').trim() } catch { return '' } }
process.on('exit', () => {
  const pid = Number(readDaemonFile('daemon.pid'))
  if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  if (root.includes('walnut-daemon-swap-ui-')) fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(manifest, { force: true })
})

const cliBin = path.join(root, 'cli-bin')
const nodeBin = path.join(root, 'node-bin')
for (const d of [cliBin, nodeBin]) fs.mkdirSync(d, { recursive: true })
fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'))
const PATH = [cliBin, nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
const mock = path.join(repoRoot, 'tests/providers/mock-claude.mjs')
fs.writeFileSync(path.join(cliBin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 })
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
Object.assign(process.env, {
  PATH,
  SHELL: '/bin/sh',
  HOME: root,
  USERPROFILE: root,
  OPEN_WALNUT_HOME: root,
  WALNUT_DAEMON_DIR: daemonDir,
  WALNUT_STREAMS_DIR: path.join(root, 'streams'),
  WALNUT_DISABLE_SEARCH: '1',
  WALNUT_DISABLE_BACKGROUND_AI: '1',
  WALNUT_BUNDLED_STORE_DIR: path.join(root, 'bundled-store'),
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(root, '.claude/projects'),
  MOCK_CLAUDE_PLAIN_ECHO: '1',
})
process.argv.push('--_ephemeral-child')
fs.mkdirSync(path.join(root, 'bundled-store'), { recursive: true })
fs.mkdirSync(path.join(root, 'project'), { recursive: true })

// The two daemons: the one running now, and the one a deploy brings.
const target = `${process.platform}-${process.arch}`
const bun = process.env.BUN_BIN ?? process.execPath
const stamp = Date.now().toString(36)
function compile(name: string): string {
  const bin = path.join(root, `daemon-bin-${name}/daemon-${target}`)
  const version = `walnut-daemon-swap-${name}-${stamp}`
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  execFileSync(bun, ['build', '--compile', `--target=bun-${target}`, '--define', `process.env.DAEMON_VERSION='${version}'`,
    path.join(repoRoot, 'src/providers/daemon-standalone.ts'), '--outfile', bin], { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, HOME: realHome } })
  fs.writeFileSync(`${bin}.version`, version)
  return bin
}
const binaries = [compile('old'), compile('new')]
let serving = binaries[0]

fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { triage: { debounce_minutes: 0 } },
}, null, 2))
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true })
fs.writeFileSync(path.join(root, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

const { localDaemon } = await import('../../../src/providers/local-daemon.js')
;(localDaemon as unknown as { findDaemonBinary: () => string }).findDaemonBinary = () => serving

const { startServer, stopServer, armGracefulSignalExit } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Daemon swap fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`
const { getConnectedDaemonConnection } = await import('../../../src/providers/daemon-connection.js')

/** One command on its own socket to the daemon on `daemonPort` (hello first, as every client does). */
function probe(daemonPort: number, cmd: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
    const done = (v: Record<string, unknown> | null) => { clearTimeout(timer); try { ws.terminate() } catch { /* gone */ } resolve(v) }
    const timer = setTimeout(() => done(null), 2_000)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m.id === 1) ws.send(JSON.stringify({ id: 2, ...cmd }))
      else if (m.id === 2) done(m)
    })
    ws.on('error', () => done(null))
  })
}

const swaps: Array<{ from: string; to: string; drainSeenAt: number; releasedAt: number }> = []

async function swap(): Promise<{ from: string; drainSeenAt: number }> {
  const conn = getConnectedDaemonConnection('__local__')
  if (!conn) throw new Error('the local daemon is not connected')
  const from = readDaemonFile('daemon.instance') || String(conn.daemonInstanceId)
  const oldPort = Number(readDaemonFile('daemon.port'))
  // Work in flight that holds the old daemon's drain open until its FIFO gets a reader.
  const fifo = path.join(root, `hold-${swaps.length}.fifo`)
  execFileSync('mkfifo', [fifo])
  void conn.send('fs.write', { path: fifo, data: Buffer.from('held').toString('base64') }, 60_000).catch(() => {})
  // The deploy: the server expects the new daemon's version and restarts the old one.
  serving = binaries[1 - binaries.indexOf(serving)]
  void localDaemon.ensureRunning().catch((err: unknown) => console.error('swap: ensureRunning failed', err))
  // Answer once the old daemon really refuses (it is draining).
  const until = Date.now() + 30_000
  let drainSeenAt = 0
  while (!drainSeenAt && Date.now() < until) {
    const reply = await probe(oldPort, { cmd: 'fs.stat', path: root })
    if (reply && reply.ok === false && /shutting down/i.test(String(reply.error))) drainSeenAt = Date.now()
    else await new Promise((r) => setTimeout(r, 50))
  }
  if (!drainSeenAt) throw new Error('the old daemon never started draining')
  const record = { from, to: '', drainSeenAt, releasedAt: 0 }
  swaps.push(record)
  setTimeout(() => {
    // The work in flight ends: the old daemon finishes its drain and exits.
    record.releasedAt = Date.now()
    fs.createReadStream(fifo).on('data', () => {}).on('error', () => {})
  }, HOLD_MS)
  return { from, drainSeenAt }
}

const control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'POST' && req.url === '/swap') {
    swap().then((r) => reply(200, r), (err: Error) => reply(500, { error: err.message }))
    return
  }
  if (req.method === 'GET' && req.url === '/state') {
    const conn = getConnectedDaemonConnection('__local__')
    for (const s of swaps) if (!s.to && conn && readDaemonFile('daemon.instance') !== s.from) s.to = readDaemonFile('daemon.instance')
    reply(200, { instance: readDaemonFile('daemon.instance'), connected: !!conn, connectedInstance: conn?.daemonInstanceId ?? null, swaps })
    return
  }
  reply(404, { error: 'no such route' })
})
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', () => resolve()))
const controlPort = (control.address() as { port: number }).port

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const { holdUntilWarm } = await import('./fixture-warm.js')
const warm = holdUntilWarm()
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Every request waits behind the SPA's first compile (fixture-warm.ts).
  plugins: [warm.plugin],
  cacheDir: path.join(root, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
    },
  },
  logLevel: 'warn',
})
const fixture = { port, apiPort: apiAddress.port, controlPort, root, project: path.join(root, 'project'), holdMs: HOLD_MS }
fs.writeFileSync(manifest, JSON.stringify(fixture))
await viteServer.listen()
await warm.warm(viteServer)
console.log(`DAEMON_SWAP_READY ${JSON.stringify(fixture)}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  control.close()
  await viteServer.close().catch(() => {})
  await stopServer()
  try { await localDaemon.stopIfIsolated() } catch { /* best effort */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
armGracefulSignalExit()
