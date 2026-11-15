/**
 * Fixture for server-restart-upload.spec.ts: a picture pasted while Walnut's server
 * restarts, the way a deploy restarts the Mac's production (2026-11-15: "1 upload
 * failed: retry or remove it to send ... The connection to Walnut dropped").
 *
 * The server is a REAL production-mode server in its own process
 * (server-restart-upload-child.ts) on PW_TEST_PORT, serving the built web app
 * directly, as the Mac's server does. POST /restart on the control port stops it
 * (SIGTERM, as a deploy does), keeps the port closed for RESTART_MS (a deploy's
 * gap measured on the Mac on 2026-11-15: 8 to 12 s), and starts it again on the
 * same port with the same home. The sessions' daemon (compiled once from this
 * checkout) stays up across the restart, as on the Mac.
 *
 * Never :3456 and never the developer's data: one throwaway directory, removed on exit.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { fixtureHome, fixtureRealHome } from './fixture-home'

const port = Number(process.env.PW_TEST_PORT ?? 3542)
if (port === 3456) throw new Error('Production port is forbidden')
const manifest = process.env.RESTART_FIXTURE_MANIFEST
if (!manifest) throw new Error('RESTART_FIXTURE_MANIFEST is required')
const RESTART_MS = Number(process.env.RESTART_FIXTURE_GAP_MS ?? 10_000)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const staticDir = path.join(repoRoot, 'dist/web/static')
if (!fs.existsSync(path.join(staticDir, 'index.html'))) throw new Error(`Build the web app first (bun run build): ${staticDir} has no index.html`)
fs.rmSync(manifest, { force: true })
const root = await fixtureHome(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-restart-upload-'))))
const realHome = fixtureRealHome()
const daemonDir = path.join(root, 'daemon')
const readDaemonFile = (name: string) => { try { return fs.readFileSync(path.join(daemonDir, name), 'utf8').trim() } catch { return '' } }

const cliBin = path.join(root, 'cli-bin')
const nodeBin = path.join(root, 'node-bin')
const shellBin = path.join(root, 'shell-bin')
for (const d of [cliBin, nodeBin, shellBin]) fs.mkdirSync(d, { recursive: true })
fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'))
const PATH = [cliBin, nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
fs.writeFileSync(path.join(shellBin, 'sh'), [
  '#!/bin/sh',
  `PATH=${JSON.stringify(PATH)}; export PATH`,
  'if [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi',
  'exec /bin/sh "$@"',
  '',
].join('\n'), { mode: 0o755 })
const mock = path.join(repoRoot, 'tests/providers/mock-claude.mjs')
fs.writeFileSync(path.join(cliBin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 })

// The sessions' daemon, compiled once from this checkout.
const target = `${process.platform}-${process.arch}`
const bun = process.env.BUN_BIN ?? process.execPath
const daemonBin = path.join(root, `daemon-bin/daemon-${target}`)
fs.mkdirSync(path.dirname(daemonBin), { recursive: true })
const version = `walnut-restart-upload-${Date.now().toString(36)}`
execFileSync(bun, ['build', '--compile', `--target=bun-${target}`, '--define', `process.env.DAEMON_VERSION='${version}'`,
  path.join(repoRoot, 'src/providers/daemon-standalone.ts'), '--outfile', daemonBin], { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, HOME: realHome } })
fs.writeFileSync(`${daemonBin}.version`, version)

fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { triage: { debounce_minutes: 0 } },
}, null, 2))
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true })
fs.writeFileSync(path.join(root, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))
fs.mkdirSync(path.join(root, 'bundled-store'), { recursive: true })
fs.mkdirSync(path.join(root, 'project'), { recursive: true })

const childEnv: NodeJS.ProcessEnv = { ...process.env }
for (const k of Object.keys(childEnv)) if (k.startsWith('GIT_')) delete childEnv[k]
Object.assign(childEnv, {
  PATH,
  SHELL: path.join(shellBin, 'sh'),
  HOME: root,
  USERPROFILE: root,
  OPEN_WALNUT_HOME: root,
  WALNUT_DAEMON_DIR: daemonDir,
  WALNUT_STREAMS_DIR: path.join(root, 'streams'),
  WALNUT_DISABLE_SEARCH: '1',
  WALNUT_DISABLE_BACKGROUND_AI: '1',
  WALNUT_BUNDLED_STORE_DIR: path.join(root, 'bundled-store'),
  WALNUT_WEB_STATIC_DIR: staticDir,
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(root, '.claude/projects'),
  MOCK_CLAUDE_PLAIN_ECHO: '1',
  RESTART_FIXTURE_DAEMON_BIN: daemonBin,
  PW_TEST_PORT: String(port),
})

let child: ChildProcess | null = null
let starts = 0
const restarts: Array<{ stoppedAt: number; startedAt: number }> = []

/** Start the server and answer once it serves. */
async function startChild(): Promise<void> {
  starts++
  const c = spawn(bun, [path.join(repoRoot, 'tests/e2e/browser/server-restart-upload-child.ts')], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child = c
  c.stdout?.on('data', (d) => process.stdout.write(`[server ${starts}] ${d}`))
  c.stderr?.on('data', (d) => process.stderr.write(`[server ${starts}] ${d}`))
  const until = Date.now() + 180_000
  while (Date.now() < until) {
    if (c.exitCode !== null) throw new Error(`the server exited with ${c.exitCode} before it served`)
    try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) return } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('the server never served')
}

/** Stop the server as a deploy does (SIGTERM) and answer once its port is closed. */
async function stopChild(): Promise<void> {
  const c = child
  if (!c || c.exitCode !== null) return
  const gone = new Promise<void>((resolve) => c.once('exit', () => resolve()))
  c.kill('SIGTERM')
  const timer = setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL') }, 20_000)
  await gone
  clearTimeout(timer)
}

const control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'POST' && req.url === '/restart') {
    // Answers once the server is down; it comes back RESTART_MS later by itself.
    void stopChild().then(() => {
      const record = { stoppedAt: Date.now(), startedAt: 0 }
      restarts.push(record)
      reply(200, { stoppedAt: record.stoppedAt, gapMs: RESTART_MS })
      setTimeout(() => {
        startChild().then(() => { record.startedAt = Date.now() }, (err: Error) => console.error('restart failed', err))
      }, RESTART_MS)
    }, (err: Error) => reply(500, { error: err.message }))
    return
  }
  if (req.method === 'GET' && req.url === '/state') {
    reply(200, { starts, restarts, daemon: readDaemonFile('daemon.instance') })
    return
  }
  reply(404, { error: 'no such route' })
})
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', () => resolve()))
const controlPort = (control.address() as { port: number }).port

await startChild()
const fixture = { port, controlPort, root, project: path.join(root, 'project'), gapMs: RESTART_MS }
fs.writeFileSync(manifest, JSON.stringify(fixture))
console.log(`RESTART_FIXTURE_READY ${JSON.stringify(fixture)}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  control.close()
  await stopChild()
  const pid = Number(readDaemonFile('daemon.pid'))
  if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  if (root.includes('walnut-restart-upload-')) fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(manifest, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
