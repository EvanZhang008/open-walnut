/**
 * Every hello this server sends a daemon names its run and the ops its registry
 * marks read-only (gateway-core.ts helloReadOps), on the main socket and on the
 * bulk one, so a relayed read cut off by this server's restart may go to the
 * next run. 2026-11-03: a `host_list` relayed 0.3 s before a deploy stopped the
 * server was never sent to the next one and ended hub_timeout after 90 s.
 *
 * MACHINE SAFETY: the daemon is a WebSocketServer in this process on a free
 * loopback port; nothing is spawned.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-hello-read-ops'))

const fakeLocal = vi.hoisted(() => ({ wsUrl: '' as string, pid: null as number | null, ensureRunning: async () => {} }))
vi.mock('../../src/providers/local-daemon.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localDaemon: fakeLocal,
}))

import fs from 'node:fs'
import path from 'node:path'
import { disconnectAllDaemons, getDirectDaemonConnection, serverHello } from '../../src/providers/daemon-connection.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { definePluginOp, getOpOwner, opNames } from '../../src/ops/index.js'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        srv.close(() => resolve(p))
      } else srv.close(() => reject(new Error('no port')))
    })
  })
}

const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  disconnectAllDaemons()
  for (const stop of stops.splice(0)) await stop().catch(() => {})
})

describe('a server hello names its read-only ops', () => {
  it('both sockets\' hellos carry the run and the registry\'s read-only ops, and no op that changes something', async () => {
    const port = await freePort()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    const hellos: Array<Record<string, unknown> & { socket: number }> = []
    const sockets: WebSocket[] = []
    wss.on('connection', (ws: WebSocket) => {
      sockets.push(ws)
      const socket = sockets.length
      ws.on('message', (raw) => {
        let cmd: Record<string, unknown>
        try { cmd = JSON.parse(raw.toString()) } catch { return }
        if (typeof cmd.id !== 'number') return
        if (cmd.cmd === 'hello') hellos.push({ ...cmd, socket })
        const body = cmd.cmd === 'hello'
          ? { version: 'fake', capabilities: [...REQUIRED_DAEMON_CAPABILITIES], instanceId: 'd-hello', startedAt: Date.now(), uptimeSec: 0 }
          : { sessions: [] }
        ws.send(JSON.stringify({ id: cmd.id, ok: true, ...body }))
      })
    })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    stops.push(async () => { for (const s of sockets) s.terminate(); await new Promise<void>((r) => wss.close(() => r())) })
    fakeLocal.wsUrl = `ws://127.0.0.1:${port}`

    // A plugin's op that calls itself read-only is not listed: only the core registry's word counts.
    const plugin = definePluginOp('test-plugin', {
      name: 'test_plugin_peek', title: 'Peek', description: 'A plugin read', input: {},
      bind: { method: 'GET', path: '/plugin-peek' }, tags: { readonly: true },
    } as unknown as Parameters<typeof definePluginOp>[1])
    stops.push(async () => { plugin.dispose() })
    await getDirectDaemonConnection('__local__', fakeLocal.wsUrl)
    const until = Date.now() + 10_000
    while (hellos.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    expect(hellos.length).toBeGreaterThanOrEqual(2)

    // The main socket and the bulk one, each once.
    expect(new Set(hellos.map((h) => h.socket)).size).toBe(hellos.length)
    const readOnly = opNames({ readonly: true }).filter((n) => getOpOwner(n) === 'core')
    expect(readOnly).toContain('host_list')
    expect(opNames({ readonly: true })).toContain('test_plugin_peek')
    for (const hello of hellos) {
      expect(typeof hello.run).toBe('string')
      expect(hello.run).toBe(hellos[0].run)
      expect(hello.readOps).toEqual(readOnly)
      for (const changes of ['task_send', 'task_update', 'host_exec', 'note_write', 'test_plugin_peek']) expect(hello.readOps).not.toContain(changes)
    }
    // Small enough to ride every hello.
    expect(JSON.stringify(hellos[0].readOps).length).toBeLessThan(8_000)
  }, 30_000)

  it('a read-only mount of a remote (a test server) names its run and no reads: it answers no relay', () => {
    expect(serverHello(true)).toEqual({ run: expect.any(String) })
    expect(serverHello(false).readOps).toContain('host_list')
    // A server that binds says so; a read-only test server never binds (gateway-identity-core.ts).
    expect(serverHello(false).binds).toBe(true)
    expect(serverHello(true).binds).toBeUndefined()
  })

  it('the real server has its registry before its first hello: it loads the ops at import', () => {
    // This test imports the ops itself, so it cannot see the order; the import chain pins it.
    const root = path.resolve(import.meta.dirname, '../..')
    const server = fs.readFileSync(path.join(root, 'src/web/server.ts'), 'utf-8')
    const api = fs.readFileSync(path.join(root, 'src/core/plugins/server-api.ts'), 'utf-8')
    expect(server).toMatch(/^import \{[^}]*\} from '\.\.\/core\/plugins\/server-api\.js'/m)
    expect(api).toMatch(/^import '\.\.\/\.\.\/ops\/index\.js'/m)
  })
})
