/**
 * The old leader's side of its machine's console (docs/reference/leader-switch.md, "The old
 * leader's console"): the handover mints the console device and writes the console file
 * (console-credential.ts); the standby of the handed-over home shares its port with the replica
 * that holds that console, staying while it does and taking the port back when it ends
 * (handed-over.ts); a switch's start waits for that replica to let the port go (console-port.ts). auth.json in the mocked WALNUT_HOME, everything else in a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../../src/constants.js'
import { setMachineIdHomeForTest } from '../../../../src/core/machine-id.js'
import { consoleDir, readConsoleFile, writeConsoleFile, writeHolder, clearHolder } from '../../../../src/core/handed-over-console.js'
import { consoleDeviceName, prepareConsoleForHandover, withdrawConsole } from '../../../../src/core/leader/switch/console-credential.js'
import { beforeHandover } from '../../../../src/core/leader/switch/before-handover.js'
import { handedOverAtBoot, serveHandedOver, type StandbyListener } from '../../../../src/core/leader/switch/handed-over.js'
import { waitForConsolePort } from '../../../../src/core/leader/switch/console-port.js'
import { getInstanceId } from '../../../../src/core/device-store.js'
import { writeMarker } from '../../../../src/core/leader/switch/records.js'
import { removeSwitchClaim, writeSwitchClaim } from '../../../../src/core/leader/switch/ticket.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

let root: string
let standby: StandbyListener | null = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-handover-'))
  setMachineIdHomeForTest(root)
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await standby?.close()
  standby = null
  setMachineIdHomeForTest(null)
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function devices(): Array<{ name: string; tokenHash: string }> {
  return (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')) as { devices: Array<{ name: string; tokenHash: string }> }).devices
}

describe('the console minted at the handover', () => {
  it('needs a switch under way to that machine (the marker)', async () => {
    const r = await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '127.0.0.1' } })
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/no switch to machine-b/) })
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-c', state: 'switching', at: 'x' })
    expect((await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '127.0.0.1' } })).ok).toBe(false)
    expect(fs.existsSync(consoleDir())).toBe(false)
  })

  it('writes the device into auth.json and its token only into the console file; a second handover replaces both', async () => {
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    const r = await beforeHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    expect(r).toEqual({ ok: true })
    const id = await getInstanceId()
    const c = readConsoleFile(id)!
    expect(c).toMatchObject({ walnutId: id, home: path.resolve(WALNUT_HOME), port: 4802, host: '::', switchId: 'sw-1', to: 'machine-b', device: 'console-machine-a' })
    const first = devices().filter((d) => d.name === 'console-machine-a')
    expect(first).toHaveLength(1)
    expect(first[0]!.tokenHash).toBe(sha(c.token))
    // The plain token is nowhere in the home.
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')).not.toContain(c.token)
    expect(c.home.startsWith(consoleDir())).toBe(false)

    await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    const again = readConsoleFile(id)!
    expect(again.token).not.toBe(c.token)
    const now = devices().filter((d) => d.name === 'console-machine-a')
    expect(now).toHaveLength(1)
    expect(now[0]!.tokenHash).toBe(sha(again.token))
    const revoked = (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')) as { revokedHashes?: string[] }).revokedHashes ?? []
    expect(revoked).toContain(sha(c.token))
  })

  it('a console that will never stand is withdrawn: its record leaves auth.json (tombstoned), its file goes; nothing to do is no error', async () => {
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    await beforeHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    const id = await getInstanceId()
    const c = readConsoleFile(id)!
    expect(await withdrawConsole({ home: WALNUT_HOME, machine: 'machine-a' })).toEqual({ device: true, files: [id] })
    expect(devices().some((d) => d.name === 'console-machine-a')).toBe(false)
    expect(readConsoleFile(id)).toBeNull()
    const revoked = (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')) as { revokedHashes?: string[] }).revokedHashes ?? []
    expect(revoked).toContain(sha(c.token))
    expect(await withdrawConsole({ home: WALNUT_HOME, machine: 'machine-a' })).toEqual({ device: false, files: [] })
  })

  it('a switch back keeps the console device of the machine it goes to until that machine leads: a cancelled one leaves the console standing', async () => {
    // machine-a handed over to machine-b before: its console device came to machine-b with the data.
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    expect(devices().map((d) => d.name)).toContain('console-machine-a')
    // Now machine-b starts a switch back to machine-a: its own console is minted, machine-a's stays.
    writeMarker(WALNUT_HOME, { switchId: 'sw-2', to: 'machine-a', state: 'switching', at: 'x' })
    await prepareConsoleForHandover({ to: 'machine-a', machine: 'machine-b', home: WALNUT_HOME, address: { port: 4803, host: '::' } })
    expect(devices().map((d) => d.name)).toEqual(expect.arrayContaining(['console-machine-a', 'console-machine-b']))
    // The switch back is cancelled: machine-b withdraws only its own.
    await withdrawConsole({ home: WALNUT_HOME, machine: 'machine-b' })
    const names = devices().map((d) => d.name)
    expect(names).toContain('console-machine-a')
    expect(names).not.toContain('console-machine-b')
  })

  it('refuses the handover when it cannot say where this server listens', async () => {
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    expect(await beforeHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: null })).toMatchObject({ ok: false })
  })

  it('names the device after the machine, as a valid device name', () => {
    expect(consoleDeviceName('machine-a')).toBe('console-machine-a')
    expect(consoleDeviceName('0123456789abcdef0123456789abcdef')).toBe('console-0123456789abcdef0123456789abcdef')
    expect(consoleDeviceName('a b/c')).toMatch(/^console-[A-Za-z0-9_.-]+$/)
    expect(consoleDeviceName('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})

describe('the standby gives its port up to the console replica', () => {
  const WALNUT = 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedf'
  let home: string
  let port: number

  beforeEach(async () => {
    home = path.join(root, 'home')
    fs.mkdirSync(home)
    writeMarker(home, { switchId: 'sw-1', to: 'machine-b', state: 'handed-over', at: 'x' })
    port = await freePort()
    writeConsoleFile({ v: 1, walnutId: WALNUT, home, port, host: '127.0.0.1', switchId: 'sw-1', to: 'machine-b', device: 'console-machine-a', token: 'e'.repeat(32), at: 'x' })
  })

  afterEach(() => { clearHolder(WALNUT, process.pid) })

  const ID_ENV = () => ({ WALNUT_MACHINE_ID_FILE: path.join(root, 'id') })
  const lines: string[] = []
  const seat = async (over: { answerWaitMs?: number } = {}) => {
    fs.writeFileSync(path.join(root, 'id'), 'machine-a\n')
    const s = handedOverAtBoot({ home, env: ID_ENV() })!
    standby = await serveHandedOver(s, { port, host: '127.0.0.1', env: ID_ENV(), say: (l) => lines.push(l), lookMs: 100, answerWaitMs: 1_500, ...over })
    return standby
  }
  const portFree = async () => {
    const s2 = net.createServer()
    const ok = await new Promise<boolean>((resolve) => { s2.once('error', () => resolve(false)); s2.listen(port, '127.0.0.1', () => resolve(true)) })
    if (ok) await new Promise<void>((r) => s2.close(() => r()))
    return ok
  }
  const until = async (fn: () => Promise<boolean> | boolean, ms = 5_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) }
    return false
  }
  const health = () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json() as Promise<{ standby?: boolean }>).catch(() => null)
  /** This Walnut's replica at the console's address: GET /api/v1/instance names the Walnut. */
  const fakeReplica = async (instance = WALNUT) => {
    const r = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instance, mode: 'REPLICA' })) })
    await new Promise<void>((resolve, reject) => { r.once('error', reject); r.listen(port, '127.0.0.1', () => resolve()) })
    return { close: () => new Promise<void>((resolve) => { r.closeAllConnections?.(); r.close(() => resolve()) }) }
  }
  let ended: string | null = null
  beforeEach(() => { lines.length = 0; ended = null })
  const watchEnd = (l: StandbyListener) => { void l.ended.then((x) => { ended = x }) }

  it('a running standby gives its listener up once a live replica holds the console on its port, and stays', async () => {
    const l = await seat()
    watchEnd(l)
    expect(l.line).toMatch(new RegExp(`^Walnut standby listening on http://localhost:${port}$`))
    expect((await health())?.standby).toBe(true)
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'now' })
    expect(await until(portFree)).toBe(true)
    expect(lines.at(-1)).toMatch(new RegExp(`listening on http://localhost:${port}: served by this machine's replica of machine-b.*gave the port up`))
    // It stays: the process the Mac app started does not end.
    await new Promise((r) => setTimeout(r, 400))
    expect(ended).toBeNull()
  })

  it('a holder of another port is not its to give way to: it keeps the port', async () => {
    const l = await seat()
    watchEnd(l)
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port: port + 1, host: '127.0.0.1', since: 'now' })
    await new Promise((r) => setTimeout(r, 600))
    expect((await health())?.standby).toBe(true)
    expect(ended).toBeNull()
  })

  it('a start finds the console served already: it stands by without the port, and takes the port back when the console ends', async () => {
    const replica = await fakeReplica()
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
    const l = await seat()
    watchEnd(l)
    expect(l.line).toMatch(new RegExp(`^Walnut console listening on http://localhost:${port}: served by this machine's replica of machine-b`))
    expect(l.server.listening).toBe(false)
    // The replica stops (its daemon did not start it again): the standby serves the port.
    clearHolder(WALNUT, process.pid)
    await replica.close()
    expect(await until(async () => (await health())?.standby === true)).toBe(true)
    expect(lines.at(-1)).toMatch(/^Walnut standby listening on .*no longer serves it/)
    // And gives it up again when a replica comes back.
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'again' })
    expect(await until(portFree)).toBe(true)
    expect(ended).toBeNull()
  })

  it('a holder that says it serves but never answers as this Walnut (a pid used again, nothing at the port): it takes the port after the wait and does not give way to it again', async () => {
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'stale' })
    const l = await seat({ answerWaitMs: 600 })
    expect(l.line).toMatch(/^Walnut standby listening on/)
    await new Promise((r) => setTimeout(r, 500))
    expect((await health())?.standby).toBe(true)
  })

  it('a start beside a replica that only waits for the port: it listens after a short wait and gives the port up as usual', async () => {
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'now' })
    const started = Date.now()
    const l = await seat({ answerWaitMs: 60_000 })
    watchEnd(l)
    // Not the whole answer wait: at most the few seconds a waiting replica gets.
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(l.line).toMatch(/^Walnut standby listening on/)
    // The line comes once the listener is closed, so the port is free a moment before it.
    expect(await until(() => lines.some((x) => /gave the port up/.test(x)))).toBe(true)
    expect(await portFree()).toBe(true)
    expect(ended).toBeNull()
  }, 15_000)

  it('its page loads again by itself once the port answers as the console, and only then; any page a browser opens is that page', async () => {
    await seat()
    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())
    // No meta refresh outside <noscript>: one that fails to load never fires again.
    expect(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')).not.toMatch(/http-equiv="refresh"/)
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(script).toContain('/api/health')
    // Run the page's own script with its timer, fetch and location stood in.
    const run = async (answer: () => Promise<{ status: number; json: () => Promise<unknown> }>) => {
      let tick: (() => void) | null = null
      let reloads = 0
      new Function('setInterval', 'fetch', 'location', script)((f: () => void) => { tick = f }, () => answer(), { reload: () => { reloads++ } })
      tick!()
      // Every stand-in answers at once: its promise chain is done before the next macrotask.
      await new Promise((r) => setImmediate(r))
      return reloads
    }
    expect(await run(async () => ({ status: 200, json: async () => ({ standby: true }) }))).toBe(0)
    expect(await run(async () => { throw new Error('connection refused') })).toBe(0)
    expect(await run(async () => ({ status: 502, json: async () => ({}) }))).toBe(0)
    expect(await run(async () => ({ status: 200, json: async () => ({ status: 'ok' }) }))).toBe(1)
    expect(await run(async () => ({ status: 401, json: async () => ({ error: 'device' }) }))).toBe(1)
    // A reload of a console page (any path a browser opens) is the standby page; the API stays JSON.
    const page = await fetch(`http://127.0.0.1:${port}/tasks/abc`, { headers: { accept: 'text/html,application/xhtml+xml' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('This Walnut is on standby')
    const api = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { accept: 'text/html' } })
    expect(api.status).toBe(409)
    expect(((await api.json()) as { code?: string }).code).toBe('handed_over')
  })

  it('another program on the port answering as something else: the start does not count it as the console, and fails on the taken port', async () => {
    const other = await fakeReplica('another-program')
    try {
      writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'now' })
      const err = await seat({ answerWaitMs: 600 }).catch((e: unknown) => e)
      expect(String(err)).toMatch(/in use by another program \(EADDRINUSE\)/)
      standby = null
    } finally {
      await other.close()
    }
  })

  it('ends when its home no longer stands handed over (a switch back moved it aside)', async () => {
    const replica = await fakeReplica()
    try {
      writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
      const l = await seat()
      watchEnd(l)
      fs.renameSync(home, `${home}.before-sw-2`)
      fs.mkdirSync(home)
      expect(await until(() => ended !== null)).toBe(true)
      expect(ended).toMatch(/no longer stands handed over by switch sw-1; this standby ends/)
      expect(l.server.listening).toBe(false)
    } finally {
      await replica.close()
    }
  })

  it('ends while it serves when a switch claims its home (the switch back is making it the new leader\'s), or the marker names another switch', async () => {
    const l = await seat()
    watchEnd(l)
    expect((await health())?.standby).toBe(true)
    writeSwitchClaim(home, 'sw-2', ID_ENV())
    expect(await until(() => ended !== null)).toBe(true)
    expect(ended).toMatch(/switch sw-2 is making .* the new leader's home; this standby ends/)
    expect(await until(portFree)).toBe(true)
    removeSwitchClaim(home, 'sw-2', ID_ENV())
    ended = null
    const again = await seat()
    watchEnd(again)
    writeMarker(home, { switchId: 'sw-3', to: 'machine-b', state: 'handed-over', at: 'y' })
    expect(await until(() => ended !== null)).toBe(true)
    expect(ended).toMatch(/no longer stands handed over by switch sw-1/)
  })

  it('names where the leader is reached (the marker\'s leaderDoors) in its status, its refusal and its page, only for the machine the marker names', async () => {
    writeMarker(home, { switchId: 'sw-1', to: 'machine-b', state: 'handed-over', leaderDoors: ['https://machine-b.example.test/w'], at: 'x' })
    await seat()
    const status = await fetch(`http://127.0.0.1:${port}/api/leader/status`).then((r) => r.json() as Promise<{ leaderDoors?: string[] }>)
    expect(status.leaderDoors).toEqual(['https://machine-b.example.test/w'])
    const refused = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { leaderDoors?: string[] }).leaderDoors).toEqual(['https://machine-b.example.test/w'])
    expect(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())).toContain('It is reached at <code>https://machine-b.example.test/w</code>')
    // The standby opened nothing in the home for it.
    expect(fs.readdirSync(home).sort()).toEqual(['local'])
  })

  it('a switch start waits for the console replica to let the port go, bounded', async () => {
    expect(await waitForConsolePort(home, port, 500)).toEqual({ ok: true })
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
    const slow = await waitForConsolePort(home, port, 400)
    expect(slow).toMatchObject({ ok: false, why: expect.stringMatching(/still holds port/) })
    setTimeout(() => clearHolder(WALNUT, process.pid), 300)
    expect(await waitForConsolePort(home, port, 5_000)).toEqual({ ok: true })
    // Another port of the same machine is not this console's.
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
    expect(await waitForConsolePort(home, port + 1, 300)).toEqual({ ok: true })
  })
})
