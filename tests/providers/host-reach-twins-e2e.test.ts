/**
 * mcp.list / mcp.tools / mcp.call / mcp.result (host-mcp-v1) and http.request
 * (host-http-v1), src/providers/host-mcp-core.ts and host-http-core.ts, on BOTH daemon
 * twins booted for real: the capabilities are advertised, the host's own MCP config is
 * read, a stdio server is started under the login shell and called, a call past its
 * caller's wait is read later, and one HTTP request is made from the host.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the task root are temp paths; the MCP server
 * is a node script fixture; the HTTP server listens on 127.0.0.1; the daemon is
 * SIGKILLed after each twin.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-reach-twins-')))
afterAll(() => { if (root.includes('walnut-host-reach-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds both sidecars next to it, as deployed.
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core', 'host-reach-core']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
afterEach(async () => {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<string> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    // The exec guard's dir leads, so a stray ssh/scp is caught, never the real one.
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return home
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
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

const FAKE = path.resolve(__dirname, '../fixtures/mcp/host-mcp-fake.cjs')

describe.each(TWINS)('$name', (twin) => {
  it('calls this host\'s MCP servers and web services for another host', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    // The host's own Claude Code config, written before the daemon starts.
    const h = path.join(dir, 'home')
    fs.mkdirSync(h, { recursive: true })
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: {
      fake: { command: process.execPath, args: [FAKE], env: { FAKE_TOKEN: 'stays-on-this-host' } },
      old: { type: 'sse', url: 'http://127.0.0.1:1/sse' },
    } }))
    // A server the user offers only to other hosts.
    fs.mkdirSync(path.join(h, '.open-walnut', 'local'), { recursive: true })
    fs.writeFileSync(path.join(h, '.open-walnut', 'local', 'host-mcp.json'), JSON.stringify({ mcpServers: {
      shared: { command: process.execPath, args: [FAKE], capability: 'wiki', description: 'For other hosts' },
    } }))
    await boot(twin, dir)
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toEqual(expect.arrayContaining(['host-mcp-v1', 'host-http-v1']))

    expect(await rpc({ cmd: 'mcp.list' })).toMatchObject({ ok: true, servers: [
      { name: 'shared', scope: 'walnut', type: 'stdio', capability: 'wiki', description: 'For other hosts' },
      { name: 'fake', scope: 'user', type: 'stdio' }, { name: 'old', type: 'sse' },
    ] })
    // The capability card names it too, marked, with its word.
    expect(((await rpc({ cmd: 'host.facts', network: false })).mcp as unknown[])[0]).toEqual({ name: 'shared', offered: true, capability: 'wiki' })
    // An image comes back whole.
    expect(await rpc({ cmd: 'mcp.call', taskId: 'task-img', server: 'shared', tool: 'image', wait: 30_000 })).toMatchObject({
      ok: true, images: [{ mimeType: 'image/png', bytes: 300, data: Buffer.alloc(300, 1).toString('base64') }],
    })
    const taskId = 'task-mcp-1'
    const tools = await rpc({ cmd: 'mcp.tools', callId: 'mc-twin-tools', taskId, server: 'fake', wait: 30_000 })
    expect(tools).toMatchObject({ ok: true, callId: 'mc-twin-tools', running: false })
    expect((tools.tools as unknown[]).length).toBe(9)
    const echo = await rpc({ cmd: 'mcp.call', callId: 'mc-twin-echo', taskId, server: 'fake', tool: 'echo', arguments: { text: 'hi' }, wait: 30_000 })
    expect(echo).toMatchObject({ ok: true, running: false, isError: false })
    expect(String(echo.text)).toContain('echo: hi')
    expect(await rpc({ cmd: 'mcp.call', taskId, server: 'fake', tool: 'env', arguments: { name: 'FAKE_TOKEN' }, wait: 30_000 })).toMatchObject({ text: 'stays-on-this-host' })
    // The daemon's own variables never reach the server.
    expect(await rpc({ cmd: 'mcp.call', taskId, server: 'fake', tool: 'env', arguments: { name: 'WALNUT_DAEMON_DIR' }, wait: 30_000 })).toMatchObject({ text: '(unset)' })
    expect(await rpc({ cmd: 'mcp.call', callId: 'mc-twin-slow', taskId, server: 'fake', tool: 'slow', arguments: { ms: 1_200 }, wait: 100 })).toMatchObject({ ok: true, running: true })
    expect(await rpc({ cmd: 'mcp.result', callId: 'mc-twin-slow', taskId: 'task-other', wait: 100 })).toMatchObject({ ok: false, code: 'unknown_call' })
    expect(await rpc({ cmd: 'mcp.result', callId: 'mc-twin-slow', taskId, wait: 15_000 })).toMatchObject({ ok: true, running: false, text: 'slept 1200' })
    expect(await rpc({ cmd: 'mcp.tools', taskId, server: 'old', wait: 5_000 })).toMatchObject({ ok: false, code: 'unsupported_transport' })
    expect(await rpc({ cmd: 'mcp.call', taskId, server: 'nope', tool: 'x' })).toMatchObject({ ok: false, code: 'unknown_server' })

    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`served ${req.method} ${req.url}`) })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (srv.address() as { port: number }).port
      expect(await rpc({ cmd: 'http.request', url: `http://127.0.0.1:${port}/health?x=1` })).toMatchObject({ ok: true, status: 200, body: 'served GET /health?x=1' })
      expect(await rpc({ cmd: 'http.request', url: 'ftp://x' })).toMatchObject({ ok: false, code: 'bad_request' })
    } finally { srv.close() }
  }, 90_000)
})
