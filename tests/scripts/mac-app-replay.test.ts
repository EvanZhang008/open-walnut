/**
 * The Mac app's server handling replayed (scripts/leader-switch/mac-app-replay.ts) is not blind:
 * against a server that reports an ended login session it stops that server, as
 * desktop/main.swift replaceEndedSessionServer does; against one that does not, it attaches and
 * stops nothing; an owned server that exits is restarted and then found again. And the moments
 * of a leader switch's console (core/leader/switch/handed-over.ts): a start that prints its line
 * and exits at once loses the line as Swift's reader does (the control), one that stays is shown;
 * a standby that gives its port up and stays, with the console appearing after a gap; a first
 * port held by another program; the console replica dying while the app's own child stays. Real
 * child processes on ephemeral ports.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { MacAppReplay, isWalnutServerCommand } from '../../scripts/leader-switch/mac-app-replay.js'

const children: ChildProcess[] = []
const replays: MacAppReplay[] = []
const servers: Array<http.Server | net.Server> = []
let dir = ''

afterEach(async () => {
  for (const r of replays.splice(0)) await r.stop()
  for (const ch of children.splice(0)) try { ch.kill('SIGKILL') } catch { /* gone */ }
  for (const sv of servers.splice(0)) await new Promise<void>((r) => { (sv as http.Server).closeAllConnections?.(); sv.close(() => r()) })
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
}).on('error', (e) => { console.error('Port ' + port + ' is in use by another program (EADDRINUSE): ' + e.message); process.exit(1) })
  .listen(port, '127.0.0.1', () => console.log('Walnut listening on http://localhost:' + port))
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

  /** This machine's console replica, as the app sees it: `/` 200, /api/config with a session it leaves alone. */
  async function consoleAt(port: number, page = 'console'): Promise<http.Server> {
    const sv = http.createServer((req, res) => {
      res.setHeader('content-type', req.url?.startsWith('/api/config') ? 'application/json' : 'text/html')
      res.end(req.url?.startsWith('/api/config') ? JSON.stringify({ loginSession: { ok: true, problems: [], checkedAt: null } }) : `<html>${page}</html>`)
    })
    await new Promise<void>((resolve, reject) => { sv.once('error', reject); sv.listen(port, '127.0.0.1', () => resolve()) })
    servers.push(sv)
    return sv
  }
  const closeServer = (sv: http.Server) => new Promise<void>((r) => { sv.closeAllConnections?.(); sv.close(() => r()) })
  const kinds = (r: MacAppReplay, k: string) => r.events.filter((e) => e.kind === k)

  it('a start that prints the console line and exits at once loses the line, as Swift\'s reader does: the error screen (the control)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'exits.cjs')
    fs.writeFileSync(file, `console.log('Walnut console listening on http://localhost:' + process.argv[2] + ': served by this machine\\'s replica of machine-b'); process.exit(0)`)
    const r = new MacAppReplay({ home: dir, ports: [port], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null, clocks: { readerLag: 0.3 } })
    replays.push(r)
    r.start()
    expect(await until(() => kinds(r, 'error_screen').length > 0, 15_000)).toBe(true)
    expect(kinds(r, 'port_confirmed')).toEqual([])
  })

  it('a start that prints the console line and stays (the standby beside the console) is shown, and nothing restarts', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'stays.cjs')
    fs.writeFileSync(file, `console.log('Walnut console listening on http://localhost:' + process.argv[2] + ': served by this machine\\'s replica of machine-b'); setInterval(() => {}, 1000)`)
    const r = new MacAppReplay({ home: dir, ports: [port], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null, clocks: { readerLag: 0.3 } })
    replays.push(r)
    // The console replica's door comes up just after the app looked and found nothing.
    r.start()
    expect(await until(() => r.spawns().length === 1, 10_000)).toBe(true)
    await consoleAt(port)
    expect(await until(() => kinds(r, 'loaded').length > 0, 15_000)).toBe(true)
    await new Promise((x) => setTimeout(x, 1_500))
    expect(kinds(r, 'restart_scheduled')).toEqual([])
    expect(kinds(r, 'error_screen')).toEqual([])
    expect(kinds(r, 'server_exited')).toEqual([])
  })

  it('a standby that gives its port up and stays, with the console coming up after a gap: no stop, no restart, it loads again', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const file = path.join(dir, 'standby.cjs')
    fs.writeFileSync(file, `
const http = require('node:http')
const port = Number(process.argv[2])
const s = http.createServer((req, res) => { res.setHeader('content-type', req.url.startsWith('/api/config') ? 'application/json' : 'text/html'); res.end(req.url.startsWith('/api/config') ? JSON.stringify({ standby: true }) : '<html>standby</html>') })
s.listen(port, '127.0.0.1', () => console.log('Walnut standby listening on http://localhost:' + port))
setTimeout(() => { s.closeAllConnections(); s.close(); console.log('gave the port up') }, 1500)
setInterval(() => {}, 1000)
`)
    const r = new MacAppReplay({ home: dir, ports: [port], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null })
    replays.push(r)
    r.start()
    expect(await until(() => kinds(r, 'loaded').length > 0, 15_000)).toBe(true)
    await new Promise((x) => setTimeout(x, 2_500))
    await consoleAt(port)
    const page = await fetch(`http://127.0.0.1:${port}/`).then((x) => x.text())
    expect(page).toContain('console')
    await new Promise((x) => setTimeout(x, 1_000))
    expect(r.kills()).toEqual([])
    expect(kinds(r, 'restart_scheduled')).toEqual([])
    expect(kinds(r, 'server_exited')).toEqual([])
    expect(kinds(r, 'error_screen')).toEqual([])
  })

  it('a first port held by a program that never answers: the app moves on and runs its own server on the next one', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const first = await freePort()
    const second = await freePort()
    const held = new Set<net.Socket>()
    const mute = net.createServer((sock) => { held.add(sock) /* accepts, never answers */ })
    await new Promise<void>((resolve) => mute.listen(first, '127.0.0.1', () => resolve()))
    try {
      const file = path.join(dir, 'server.cjs')
      fs.writeFileSync(file, serverScript([]))
      const r = new MacAppReplay({ home: dir, ports: [first, second], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null })
      replays.push(r)
      r.start()
      expect(await until(() => kinds(r, 'loaded').some((e) => e.port === second), 30_000)).toBe(true)
      expect(r.kills()).toEqual([])
      expect(kinds(r, 'error_screen')).toEqual([])
    } finally {
      for (const sock of held) sock.destroy()
      await new Promise<void>((r) => mute.close(() => r()))
    }
  })

  it('the console replica dies while the app shows it: a standby already beside it takes the port back, nothing restarts', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-replay-'))
    const port = await freePort()
    const flag = path.join(dir, 'console-gone')
    const file = path.join(dir, 'seat.cjs')
    fs.writeFileSync(file, `
const fs = require('node:fs')
const http = require('node:http')
const port = Number(process.argv[2])
console.log('Walnut console listening on http://localhost:' + port + ': served by this machine\\'s replica of machine-b')
const t = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(flag)})) return
  clearInterval(t)
  http.createServer((req, res) => { res.setHeader('content-type', req.url.startsWith('/api/config') ? 'application/json' : 'text/html'); res.end(req.url.startsWith('/api/config') ? JSON.stringify({ standby: true }) : '<html>standby</html>') })
    .listen(port, '127.0.0.1', () => console.log('Walnut standby listening on http://localhost:' + port + ': the console replica no longer serves it'))
}, 100)
setInterval(() => {}, 1000)
`)
    const replica = await consoleAt(port)
    const r = new MacAppReplay({ home: dir, ports: [port], command: (p) => ({ cmd: process.execPath, args: [file, String(p)], env: {} }), isWalnutServer: () => true, listener: () => null })
    replays.push(r)
    r.start()
    // Something answers at the port already: the app attaches to it without a child.
    expect(await until(() => r.attachedPort() === port, 15_000)).toBe(true)
    // A standby of the home already stands by beside the console. The app attached without a
    // child here, so it is NOT the app's: started by hand, as one the app started before the
    // replica took the port would be. An app that launched beside a running console has none,
    // and a dead page until its Retry (docs/reference/leader-switch-console.md, limits).
    const seat = spawn(process.execPath, [file, String(port)], { stdio: 'ignore' })
    children.push(seat)
    await closeServer(replica)
    fs.writeFileSync(flag, '')
    expect(await until(() => false, 1_000)).toBe(false)
    const page = await fetch(`http://127.0.0.1:${port}/`).then((x) => x.text()).catch(() => '')
    expect(page).toContain('standby')
    expect(r.kills()).toEqual([])
    expect(kinds(r, 'restart_scheduled')).toEqual([])
    expect(kinds(r, 'error_screen')).toEqual([])
    expect(seat.exitCode).toBeNull()
  })

  it('reads a Walnut server command line as the app does', () => {
    expect(isWalnutServerCommand('/usr/bin/bun /x/dist/cli.js web --replica')).toBe(true)
    expect(isWalnutServerCommand('/opt/walnut-darwin-arm64 web --port 3456')).toBe(true)
    expect(isWalnutServerCommand('/usr/bin/bun /x/src/cli.ts web --port 3456')).toBe(true)
    expect(isWalnutServerCommand('/usr/bin/python3 web')).toBe(false)
    expect(isWalnutServerCommand('walnut daemon')).toBe(false)
  })
})
