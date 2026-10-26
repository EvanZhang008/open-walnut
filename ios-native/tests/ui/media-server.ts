import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TINY_MP4_BASE64 } from '../../../tests/e2e/browser/fixtures/tiny-video.js'

const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/phone-media/')) throw new Error('Use a dedicated phone media evidence directory')
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-media-home-'))
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, OPEN_WALNUT_HOME: home, WALNUT_DAEMON_DIR: path.join(home, 'daemon'),
  WALNUT_STREAMS_DIR: path.join(home, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(home, 'spawn.jsonl'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), WALNUT_LEGACY_STREAMS_DIR: path.join(home, 'legacy-streams'),
  WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0',
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(home, '.claude/projects'), MOCK_CLAUDE_TURN_TRANSCRIPT_DIR: path.join(home, '.claude/projects'),
})
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
process.argv.push('--_ephemeral-child')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const { createMockDaemon } = await import('../../../tests/helpers/mock-daemon.js')
const { createDevice } = await import('../../../src/core/device-auth.js')
const { updateTask } = await import('../../../src/core/task-manager.js')
const root = path.join(home, 'media')
await fs.mkdir(root)
const clip = path.join(root, 'walkthrough.mp4')
const large = path.join(root, 'large walkthrough.MP4')
if (process.env.WALNUT_MEDIA_FIXTURE) await fs.copyFile(process.env.WALNUT_MEDIA_FIXTURE, clip)
else await fs.writeFile(clip, Buffer.from(TINY_MP4_BASE64, 'base64'))
if (process.env.WALNUT_LARGE_MEDIA_FIXTURE) await fs.copyFile(process.env.WALNUT_LARGE_MEDIA_FIXTURE, large)
else {
  await fs.copyFile(clip, large)
  const free = Buffer.alloc(3 * 1024 * 1024)
  free.writeUInt32BE(free.length, 0)
  free.write('free', 4, 'ascii')
  await fs.appendFile(large, free)
}
await fs.writeFile(path.join(root, 'readme.txt'), 'File preview regression: line one.\nFile preview regression: line two.\n')
await fs.writeFile(path.join(root, 'report.html'), '<!doctype html><html><body><h1>File preview regression</h1></body></html>')
const missing = path.join(root, 'restored.mp4')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
const server = await startServer({ port: 0, dev: true })
const apiPort = (server.address() as { port: number }).port
const token = (await createDevice('media-fixture-phone')).token
const transcript = `Media fixture ready.\n\n${clip}\n\n${large}\n\n${missing}`
const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/sessions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ cwd: root, message: 'snapshot-clean-turn:' + transcript, overrideReadiness: true }),
})
const seeded = await response.json() as { sessionId: string; taskId: string }
if (!response.ok || !seeded.sessionId || !seeded.taskId) throw new Error('Could not seed the isolated media session')
await updateTask(seeded.taskId, { title: 'Phone media fixture', pinned: true, focus_tier: 'focus' })
const requests: Array<{ path: string; raw: boolean; status: number; bytes: number; cancelled: boolean }> = []
let fault: 'off' | 'offline' | 'delay' = 'off'
const proxy = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.test')
  if (url.pathname === '/__media/state') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...seeded, root, clip, large, missing, requests, fault })); return
  }
  if (url.pathname === '/__media/shot' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? ''
    if (!/^[a-z0-9-]+$/.test(name)) { res.statusCode = 400; res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    await fs.writeFile(path.join(out, name + '.png'), Buffer.concat(chunks))
    res.end('{}'); return
  }
  if (url.pathname === '/__media/fault' && req.method === 'POST') {
    const next = url.searchParams.get('mode')
    if (next !== 'off' && next !== 'offline' && next !== 'delay') { res.statusCode = 400; res.end(); return }
    fault = next; res.end('{}'); return
  }
  if (url.pathname === '/__media/restore' && req.method === 'POST') {
    await fs.copyFile(clip, missing); res.end('{}'); return
  }
  if (url.pathname === '/__media/remove' && req.method === 'POST') {
    await fs.rm(missing, { force: true }); res.end('{}'); return
  }
  const isFile = url.pathname === '/api/v1/file-content'
  const entry = { path: url.searchParams.get('path') ?? '', raw: url.searchParams.get('raw') === '1', status: 0, bytes: 0, cancelled: false }
  if (isFile) {
    requests.push(entry)
    res.on('close', () => { entry.cancelled = !res.writableFinished })
    if (fault === 'offline') {
      entry.status = 503; res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'bridge_offline', message: 'Fixture host is offline' } })); return
    }
    if (fault === 'delay') {
      await new Promise(resolve => setTimeout(resolve, 15_000))
      if (res.destroyed) return
    }
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, reply => {
    entry.status = reply.statusCode ?? 0
    res.writeHead(reply.statusCode ?? 502, reply.headers)
    reply.on('data', chunk => { entry.bytes += chunk.length })
    reply.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const port = (proxy.address() as { port: number }).port
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token, home, ...seeded, clip, large, missing }))
let closing = false
async function close() {
  if (closing) return
  closing = true
  await fs.writeFile(path.join(out, 'requests.json'), JSON.stringify(requests, null, 2))
  proxy.closeAllConnections(); proxy.close()
  await stopServer(); await daemon.stop(); process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 90 * 60_000).unref()
