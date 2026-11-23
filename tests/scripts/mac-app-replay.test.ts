/**
 * The Mac app's server handling replayed (scripts/leader-switch/mac-app-replay.ts) is not blind:
 * against a server that reports an ended login session it stops that server, as
 * desktop/main.swift replaceEndedSessionServer does; against one that does not, it attaches and
 * stops nothing; an owned server that exits is restarted and then found again. Real child
 * processes on ephemeral ports.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { MacAppReplay, isWalnutServerCommand } from '../../scripts/leader-switch/mac-app-replay.js'

const children: ChildProcess[] = []
const replays: MacAppReplay[] = []
let dir = ''

afterEach(async () => {
  for (const r of replays.splice(0)) await r.stop()
  for (const ch of children.splice(0)) try { ch.kill('SIGKILL') } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** A server like Walnut's for the app: `/` 200, /api/config with the given login session problems; it says the line the app waits for. */
function serverScript(problems: string[], exitAfterMs = 0): string {
  return `
const http = require('node:http')
const port = Number(process.argv[2])
http.createServer((req, res) => {
  res.setHeader('content-type', req.url.startsWith('/api/config') ? 'application/json' : 'text/html')
  res.end(req.url.startsWith('/api/config') ? JSON.stringify({ loginSession: { ok: false, problems: ${JSON.stringify(problems)} } }) : '<html></html>')
}).listen(port, '127.0.0.1', () => console.log('Walnut listening on http://localhost:' + port))
${exitAfterMs ? `setTimeout(() => process.exit(0), ${exitAfterMs})` : ''}
`
}

function runServer(file: string, port: number): ChildProcess {
  const ch = spawn(process.execPath, [file, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(ch)
  return ch
}

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)) }
  return fn()
}

describe('the Mac app replay', () => {
  it('stops a server that reports an ended login session (the control: it is not blind)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'server.cjs')
    fs.writeFileSync(file, serverScript(['user_lookup']))
    const server = runServer(file, port)
    await until(() => false, 600)
    const r = new MacAppReplay({ home: dir, ports: [port], command: () => ({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], env: {} }), isWalnutServer: () => true, listener: () => server.pid ?? null })
    replays.push(r)
    r.start()
    expect(await until(() => r.kills().length > 0, 15_000)).toBe(true)
    expect(r.kills()[0]).toMatchObject({ kind: 'kill:ended_session_replaced', pid: server.pid, detail: 'user_lookup' })
  })

  it('attaches to a healthy server and stops nothing', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'server.cjs')
    fs.writeFileSync(file, serverScript([]))
    const server = runServer(file, port)
    await until(() => false, 600)
    const r = new MacAppReplay({ home: dir, ports: [port], command: () => ({ cmd: process.execPath, args: ['-e', ''], env: {} }), isWalnutServer: () => true, listener: () => server.pid ?? null })
    replays.push(r)
    r.start()
    expect(await until(() => r.attachedPort() === port, 15_000)).toBe(true)
    expect(r.kills()).toEqual([])
    expect(r.spawns()).toEqual([])
  })

  it('spawns its own server where none answers, restarts it when it exits, and finds the next one', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'server.cjs')
    fs.writeFileSync(file, serverScript([], 1_500))
    const r = new MacAppReplay({ home: dir, ports: [port], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null, clocks: { restartDelays: [1, 1, 1, 1, 1] } })
    replays.push(r)
    r.start()
    expect(await until(() => r.events.some((e) => e.kind === 'loaded'), 15_000)).toBe(true)
    expect(await until(() => r.events.some((e) => e.kind === 'restart_scheduled'), 15_000)).toBe(true)
    expect(await until(() => r.spawns().length >= 2, 15_000)).toBe(true)
    expect(r.kills()).toEqual([])
  })

  it('reads a Walnut server command line as the app does', () => {
    expect(isWalnutServerCommand('/usr/bin/bun /x/dist/cli.js web --replica')).toBe(true)
    expect(isWalnutServerCommand('/opt/walnut-darwin-arm64 web --port 3456')).toBe(true)
    expect(isWalnutServerCommand('/usr/bin/bun /x/src/cli.ts web --port 3456')).toBe(true)
    expect(isWalnutServerCommand('/usr/bin/python3 web')).toBe(false)
    expect(isWalnutServerCommand('walnut daemon')).toBe(false)
  })
})
