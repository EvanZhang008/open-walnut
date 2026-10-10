/**
 * Fixture for tests/e2e/browser/host-alone.spec.ts: a host server that answers
 * alone (tests/helpers/host-alone-harness.ts: a real daemon, the real host
 * server, a mock CLI session, a stand-in Mac). It starts with the Mac linked,
 * takes the Mac's device list, then lets the Mac go, so the page is alone.
 *
 * A small control port beside it (PW_TEST_PORT + 1) lets the spec bring the Mac
 * back or send it away again, and read what the CLI received.
 *
 * Never :3456 and never the developer's data: the server's data dir and the
 * daemon dir sit under temp dirs, removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/host-alone-server.ts
 * Reads PW_TEST_PORT (default 3468).
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_TEST_PORT ?? 3468)
if (port === 3456) throw new Error('Production port is forbidden')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-hostalone-pw-'))
Object.assign(process.env, { OPEN_WALNUT_HOME: home, WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1' })

const { startHostAloneHarness, tokenHash, waitFor, TOKEN, DEVICE } = await import('../../helpers/host-alone-harness.js')
const h = await startHostAloneHarness({ twin: process.env.HOST_ALONE_TWIN === 'standalone' ? 'standalone' : 'source', publicPort: port })
const pushed = await h.pushDevices([{ name: DEVICE, tokenHash: tokenHash(TOKEN) }])
if (pushed.status !== 200) throw new Error('device list refused: ' + JSON.stringify(pushed))
h.unlinkMac()
await waitFor(() => h.route() === 'alone', 15_000, 'alone')

const control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://control')
    if (req.method === 'GET' && url.pathname === '/control/ready') return reply(200, { route: h.route() })
    if (req.method === 'POST' && url.pathname === '/control/link') {
      if (!h.macLinked()) await h.linkMac()
      await waitFor(() => h.route() === 'leader', 15_000, 'the leader route')
      return reply(200, { route: h.route() })
    }
    if (req.method === 'POST' && url.pathname === '/control/unlink') {
      h.unlinkMac()
      await waitFor(() => h.route() === 'alone', 15_000, 'alone')
      return reply(200, { route: h.route() })
    }
    const m = /^\/control\/(inbox|responses)\/([\w-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && m) return reply(200, m[1] === 'inbox' ? h.inbox(m[2]!) : h.responses(m[2]!))
    if (req.method === 'POST' && url.pathname === '/control/drain') return reply(200, await h.macCmd({ cmd: 'offline.drain', home: (await import('../../helpers/host-alone-harness.js')).HOME }))
    reply(404, { error: 'not_found' })
  })().catch((err) => reply(500, { error: err instanceof Error ? err.message : String(err) }))
})
await new Promise<void>((r) => control.listen(port + 1, '127.0.0.1', () => r()))
process.stdout.write(`HOST_ALONE_READY ${JSON.stringify({ port, control: port + 1, base: h.base })}\n`)

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  control.close()
  await h.stop().catch(() => undefined)
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
