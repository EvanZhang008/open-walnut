/**
 * `walnut serve` under a launcher writes the launcher's marks itself (serve-launcher-beat.ts):
 * ready only once sessions answer (the in-process daemon, when wanted), the port listens and one
 * real request answers right; the launcher's variable leaves the env; leaving before a planned stop.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serveReadyCheck, serveLauncherLeaving, startServeLauncherBeat } from '../../src/web/serve-launcher-beat.js'
import { _resetLauncherEnvForTesting, launcherServicePid, takeLauncherEnv } from '../../src/web/launcher-env.js'

const okConfig = async () => new Response(JSON.stringify({ x: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
const noInProcess = { wanted: async () => false, check: async () => 'never asked' }

describe('serveReadyCheck', () => {
  it('holds once GET /api/config answers a JSON object, asking the port it was given', async () => {
    const asked: string[] = []
    const fetch = (async (url: string) => { asked.push(String(url)); return okConfig() }) as unknown as typeof globalThis.fetch
    expect(await serveReadyCheck({ port: 4321, fetch, inProcess: noInProcess })).toBeNull()
    expect(asked).toEqual(['http://127.0.0.1:4321/api/config'])
  })

  it('says why not for a wrong status or a body that is no object', async () => {
    const status = (async () => new Response('no', { status: 503 })) as unknown as typeof globalThis.fetch
    expect(await serveReadyCheck({ port: 1, fetch: status, inProcess: noInProcess })).toBe('GET /api/config answered 503')
    const list = (async () => new Response('[1]', { status: 200 })) as unknown as typeof globalThis.fetch
    expect(await serveReadyCheck({ port: 1, fetch: list, inProcess: noInProcess })).toBe('GET /api/config answered no JSON object')
  })

  it('with the daemon in process, its sessions answer first', async () => {
    let fetched = 0
    const fetch = (async () => { fetched++; return okConfig() }) as unknown as typeof globalThis.fetch
    const down = { wanted: async () => true, check: async () => 'the in-process daemon is not running' }
    expect(await serveReadyCheck({ port: 1, fetch, inProcess: down })).toBe('sessions: the in-process daemon is not running')
    expect(fetched).toBe(0)
    const up = { wanted: async () => true, check: async () => null }
    expect(await serveReadyCheck({ port: 1, fetch, inProcess: up })).toBeNull()
    expect(fetched).toBe(1)
  })
})

describe('startServeLauncherBeat', () => {
  const roots: string[] = []
  let server: http.Server | null = null
  const before = process.env.WALNUT_LAUNCHER_DIR
  const beforeInProcess = process.env.WALNUT_IN_PROCESS_DAEMON
  afterEach(async () => {
    serveLauncherLeaving('test end')
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
    if (before === undefined) delete process.env.WALNUT_LAUNCHER_DIR; else process.env.WALNUT_LAUNCHER_DIR = before
    delete process.env.WALNUT_LAUNCHER_SERVICE_PID
    _resetLauncherEnvForTesting()
    if (beforeInProcess === undefined) delete process.env.WALNUT_IN_PROCESS_DAEMON; else process.env.WALNUT_IN_PROCESS_DAEMON = beforeInProcess
  })

  it('without a launcher, writes nothing', () => {
    delete process.env.WALNUT_LAUNCHER_DIR
    startServeLauncherBeat(1)
    serveLauncherLeaving('x')
  })

  it('beats, writes ready once the port answers, takes the variable out of the env, and marks leaving', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-launcher-'))
    roots.push(root)
    const dir = path.join(root, 'launcher')
    fs.mkdirSync(dir)
    // The daemon is not run in this process here: readiness is the port's answer alone.
    process.env.WALNUT_IN_PROCESS_DAEMON = '0'
    server = http.createServer((req, res) => {
      if (req.url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') } else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    process.env.WALNUT_LAUNCHER_DIR = dir
    startServeLauncherBeat(port)
    expect(process.env.WALNUT_LAUNCHER_DIR).toBeUndefined()

    const deadline = Date.now() + 10_000
    while (!fs.existsSync(path.join(dir, 'ready')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    const ready = fs.readFileSync(path.join(dir, 'ready'), 'utf8')
    expect(ready).toContain(`pid=${process.pid}\n`)
    const [at, , pid] = fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8').trim().split(' ')
    expect(Number(at)).toBeGreaterThan(0)
    expect(Number(pid)).toBe(process.pid)

    serveLauncherLeaving('planned stop')
    expect(fs.existsSync(path.join(dir, 'leaving'))).toBe(true)
  })

  it('under the Mac\'s run script, every mark names the launcher\'s child, not this process (the session host is between them)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-launcher-'))
    roots.push(root)
    const dir = path.join(root, 'launcher')
    fs.mkdirSync(dir)
    process.env.WALNUT_IN_PROCESS_DAEMON = '0'
    server = http.createServer((req, res) => {
      if (req.url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') } else { res.writeHead(404); res.end() }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const child = process.pid + 7
    process.env.WALNUT_LAUNCHER_DIR = dir
    process.env.WALNUT_LAUNCHER_SERVICE_PID = String(child)
    // Taken at the server's start, before anything copies the env into a child.
    expect(takeLauncherEnv()).toEqual({ dir, servicePid: child })
    expect(process.env.WALNUT_LAUNCHER_DIR).toBeUndefined()
    expect(process.env.WALNUT_LAUNCHER_SERVICE_PID).toBeUndefined()
    startServeLauncherBeat(port)
    const deadline = Date.now() + 10_000
    while (!fs.existsSync(path.join(dir, 'ready')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(fs.readFileSync(path.join(dir, 'ready'), 'utf8')).toContain(`pid=${child}\n`)
    expect(Number(fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8').trim().split(' ')[2])).toBe(child)
    serveLauncherLeaving('planned stop')
    expect(fs.readFileSync(path.join(dir, 'leaving'), 'utf8')).toContain(`pid=${child}\n`)
  })

  it('takes only a whole pid above 1 from the run script', () => {
    expect(launcherServicePid('4242')).toBe(4242)
    for (const bad of [undefined, '', '1', '0', '-5', '12a', ' 42', '99999999999']) expect(launcherServicePid(bad)).toBeNull()
  })
})
