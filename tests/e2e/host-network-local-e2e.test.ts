/**
 * The host network with no cloud companion, end to end (docs/reference/host-network.md,
 * "Without a companion"), every part real but the agent CLI, relay pick "No relay":
 *
 *   this primary (startServer, "the Mac", no companion) ── its daemon ── walnut-net ─┐
 *                                                                                   │ iroh, direct
 *   a new machine: `sh scripts/join.sh <ticket>` ── walnut net join ── its daemon ── walnut-net ─┘
 *
 * What it proves:
 *  1. with no companion the relay is public relays until the user picks; "No relay" is kept,
 *     and "Your relay" cannot be picked;
 *  2. the invite is a ticket (this Mac's id, the code, where it listens), and a wrong code
 *     changes nothing on the machine;
 *  3. the ticket joins the machine: the approved screen, the Mac lists it as a
 *     `transport: net` host with where it listens, and reaches its daemon with no relay;
 *     the page hears it connected (its live frame goes out);
 *  4. the same command again says the link is spent and leaves the machine's network as it
 *     was (the Mac still reaches it);
 *  5. a restart of the machine keeps the port it listens on, so with no relay the Mac
 *     reaches it again;
 *  6. Remove turns the machine's network off and drops it from this Mac's list, and its
 *     connection with it;
 *  7. the machine joins again under its name, nothing reads as dialling it, and the Mac
 *     reaches it;
 *  8. a hub forward the machine's own CLI adds reaches a port on the Mac's loopback over that
 *     link once, and only while, the Mac's config lists it for that machine.
 *
 * Needs walnut-net (WALNUT_NET_TEST_BIN, else dist/daemon-binaries/walnut-net-<platform>-<arch>)
 * and bun; skipped without them. WALNUT_NET_E2E_RELAY=public runs it live on iroh's public
 * relays instead (internet needed): the ticket then carries no address, so the join goes
 * through the Mac's public relay.
 *
 * MACHINE SAFETY: every dir is under one temp base (each machine's HOME, the daemon dirs);
 * the join CLI is pointed at the test machine's daemon (WALNUT_JOIN_DAEMON_DIR, which also
 * forbids it to install a service); no download (WALNUT_NET_NO_DOWNLOAD); real ssh is
 * refused (isolateFromRealSsh). Processes this test started are stopped through their own handles.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'
import { testBun } from '../helpers/bun-runtime.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-net-local'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { decodeTicket, encodeTicket, ticketCommand } from '../../src/core/net/join-ticket.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { peekDaemonConnection } from '../../src/providers/daemon-connection.js'
import { CONNECT_IN_FLIGHT_PHASES } from '../../src/core/sessions/host-connect-hint.js'

const REPO = path.resolve(__dirname, '../..')
const NET_BIN = (() => {
  const env = process.env.WALNUT_NET_TEST_BIN
  if (env && fs.existsSync(env)) return env
  const built = path.join(REPO, `dist/daemon-binaries/walnut-net-${process.platform}-${process.arch}`)
  return fs.existsSync(built) ? built : null
})()
const BUN = testBun()
const suite = NET_BIN && BUN ? describe : describe.skip
const RELAY: 'public' | 'none' = process.env.WALNUT_NET_E2E_RELAY === 'public' ? 'public' : 'none'

let base = ''
let isolation: SshIsolation | null = null
let hostDaemon: ChildProcess | null = null
let hostEnv: NodeJS.ProcessEnv = {}
let primaryPort = 0
const host = { home: '', daemonDir: '' }
// The live frames every surface draws a host's status from (host:status).
const frames: Array<{ host?: string; connected?: boolean }> = []

const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${primaryPort}${p}`, {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
})

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

/** One command to the test machine's daemon. */
async function hostRpc(cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const port = Number(fs.readFileSync(path.join(host.daemonDir, 'daemon.port'), 'utf8').trim())
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => { ws.terminate(); reject(new Error(`host rpc ${cmd} timed out`)) }, 30_000)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd, ...params })))
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>
      if (m.id === 1) { clearTimeout(t); ws.close(); resolve(m) }
    })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function stopChild(p: ChildProcess | null): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } resolve() }, 10_000)
    p.once('exit', () => { clearTimeout(t); resolve() })
    p.kill('SIGTERM')
  })
}

async function startHostDaemon(): Promise<void> {
  try { fs.rmSync(path.join(host.daemonDir, 'daemon.port'), { force: true }) } catch { /* none */ }
  hostDaemon = spawn(BUN!, [path.join(REPO, 'src/providers/daemon-standalone.ts'), '--start'], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  await waitFor(async () => fs.existsSync(path.join(host.daemonDir, 'daemon.port')) && (await hostRpc('hello')).ok === true, 60_000, 'the machine\'s daemon')
}

/** What the user pastes on the machine, with the ticket in it. */
function runJoin(ticket: string): Promise<{ code: number; out: string }> {
  const run = spawn('sh', [path.join(REPO, 'scripts/join.sh'), ticket], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  run.stdout!.on('data', (b: Buffer) => { out += b.toString() })
  run.stderr!.on('data', (b: Buffer) => { out += b.toString() })
  return new Promise((r) => run.once('exit', (c) => r({ code: c ?? -1, out })))
}

async function connected(machine: string): Promise<{ steps?: Array<{ phase: string }> }> {
  await api(`/api/hosts/${machine}/connect`, { method: 'POST', body: '{}' })
  return waitFor(async () => {
    const s = await (await api('/api/hosts/status')).json() as { hosts?: Array<{ host: string; connected: boolean; steps?: Array<{ phase: string }> }> }
    const h = s.hosts?.find((x) => x.host === machine)
    return h?.connected ? h : null
  }, 90_000, `${machine} to connect`)
}

async function filesOnMachine(machine: string): Promise<string> {
  const r = await api(`/api/v1/files/list?host=${encodeURIComponent(machine)}&path=${encodeURIComponent(host.home)}`)
  return JSON.stringify(await r.json())
}

function config(): string {
  return fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')
}

suite(`host network with no companion: a ticket joins a machine (relay: ${RELAY})`, () => {
  let machine = ''
  let machineId = ''
  let ticket = ''

  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-host-net-local-e2e-'))
    process.env.WALNUT_NET_BIN = NET_BIN!
    process.env.WALNUT_NET_NO_DOWNLOAD = '1'
    // A test server never runs the network on its own (net-mac.ts netActive): this one does.
    process.env.WALNUT_NET_ACTIVE = '1'
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
    await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
    await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\n')
    isolation = isolateFromRealSsh(base)
    const server = await startServer({ port: 0, dev: true })
    primaryPort = (server.address() as net.AddressInfo).port
    await (await import('../../src/core/net/net-mac.js')).startNet()
    bus.subscribe('host-net-local-e2e-frames', (e) => { frames.push(e.data as { host?: string; connected?: boolean }) }, { global: true, interest: [EventNames.HOST_STATUS] })

    // The new machine: its own HOME and daemon (the bun twin), nothing shared with this one.
    host.home = path.join(base, 'host', 'home')
    host.daemonDir = path.join(base, 'host', 'daemon')
    await fsp.mkdir(host.home, { recursive: true })
    const bin = path.join(base, 'host', 'bin')
    await fsp.mkdir(bin, { recursive: true })
    await fsp.writeFile(path.join(bin, 'walnut'), `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(path.join(REPO, 'src/cli.ts'))} "$@"\n`, { mode: 0o755 })
    // The join ends by naming the coding agents here (`claude --version`): this one, not the real CLI.
    await fsp.writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.999 (Claude Code)"\n', { mode: 0o755 })
    hostEnv = {
      ...process.env, HOME: host.home, WALNUT_HOME_OVERRIDE: host.home, SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: host.daemonDir, WALNUT_STREAMS_DIR: path.join(base, 'host', 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'host', 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(base, 'host', 'spawn-journal.jsonl'),
      WALNUT_TASK_DIR_ROOT: path.join(base, 'host', 'tasks'), OPEN_WALNUT_HOME: path.join(host.home, '.open-walnut'),
      PATH: `${bin}:${process.env.PATH}`, WALNUT_JOIN_WALNUT: path.join(bin, 'walnut'), WALNUT_JOIN_DAEMON_DIR: host.daemonDir,
    }
    for (const k of ['XDG_STATE_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete hostEnv[k]
    await startHostDaemon()
  }, 600_000)

  afterAll(async () => {
    bus.unsubscribe('host-net-local-e2e-frames')
    try { await stopServer() } catch { /* best-effort */ }
    await stopChild(hostDaemon)
    isolation?.restore()
    for (const k of ['WALNUT_NET_BIN', 'WALNUT_NET_NO_DOWNLOAD', 'WALNUT_NET_ACTIVE']) delete process.env[k]
    if (base.includes('walnut-host-net-local-e2e-')) await fsp.rm(base, { recursive: true, force: true })
  }, 120_000)

  it('with no companion the relay is public relays until picked; a pick is kept; Your relay cannot be picked', async () => {
    const before = await (await api('/api/hosts/net')).json() as { companion: boolean; relay: string }
    expect(before).toMatchObject({ companion: false, relay: 'public' })
    const own = await api('/api/hosts/net/relay', { method: 'PUT', body: JSON.stringify({ relay: 'own' }) })
    expect(own.status).toBe(400)
    expect(((await own.json()) as { code: string }).code).toBe('no_companion')
    const pick = await api('/api/hosts/net/relay', { method: 'PUT', body: JSON.stringify({ relay: RELAY }) })
    expect(pick.status).toBe(200)
    expect(((await pick.json()) as { relay: string }).relay).toBe(RELAY)
    expect(config()).toMatch(new RegExp(`\\nnet:\\n(?: {2}.*\\n)*? {2}relay: ${RELAY}\\n`))
  })

  it('the invite is a ticket, and a wrong code changes nothing on the machine', async () => {
    const made = await api('/api/hosts/net/invites', { method: 'POST', body: '{}' })
    const invite = await made.json() as { id: string; link: string; command: string; state: string }
    expect(made.status, JSON.stringify(invite)).toBe(201)
    ticket = invite.link
    expect(invite.command).toBe(ticketCommand(ticket))
    const t = decodeTicket(ticket)!
    const ov = await (await api('/api/hosts/net')).json() as { macId: string }
    expect(t).toMatchObject({ mac: ov.macId, relayMode: RELAY })
    expect(t.addrs.length).toBeGreaterThan(0)
    if (RELAY === 'public') {
      // The Mac's home relay is one of n0's; the join goes through it alone.
      expect(t.relay).toMatch(/^https:\/\//)
      ticket = encodeTicket({ ...t, addrs: [] })
    } else {
      expect(t.relay).toBeNull()
    }
    ;(globalThis as { __inviteId?: string }).__inviteId = invite.id

    // The right Mac, a code that is not the invite's: refused, and the machine's network stays off.
    const wrong = encodeTicket({ ...t, code: 'ZZZZ-ZZZZ-ZZZZ' })
    const r = await runJoin(wrong)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('This link is not valid any more (used, or older than 10 minutes). Make a new one on your Mac.')
    const st = await hostRpc('net.status') as { enabled?: boolean; running?: boolean }
    expect(st.enabled).toBe(false)
  }, 180_000)

  it('the ticket joins the machine, and the Mac reaches its daemon with no relay', async () => {
    const r = await runJoin(ticket)
    expect(r.code, r.out).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines[0]).toBe('Walnut: adding this machine to your Walnut machines')
    expect(lines[1]).toMatch(/^ {2}1\/3 {2}Walnut \.{12} installed \(.+\)$/)
    expect(lines[2]).toBe('  2/3  Keep it running ... on (already running)')
    const done = /^ {2}3\/3 {2}Join \.{14} done: this machine is "([A-Za-z0-9._-]+)"$/.exec(lines[3])
    expect(done, r.out).not.toBeNull()
    machine = done![1]

    const id = (globalThis as { __inviteId?: string }).__inviteId!
    await waitFor(async () => (await (await api(`/api/hosts/net/invites/${id}`)).json() as { state: string }).state === 'joined', 30_000, 'the invite to read joined')
    const listed = await waitFor(async () => {
      const o = await (await api('/api/hosts/net')).json() as { machines: Array<{ host: string; endpoint: string }> }
      return o.machines.find((m) => m.host === machine)
    }, 30_000, 'Settings to list the machine')
    machineId = listed.endpoint
    expect((await hostRpc('net.identity')).endpointId).toBe(machineId)
    // Its row, and this Mac's own list with where it listens.
    const cfg = config()
    expect(cfg).toMatch(new RegExp(`\\n  ${machine}:\\n    hostname: ${machine}\\.walnut-net\\.invalid\\n    label: ${machine}\\n    transport: net\\n    endpoint: ${machineId}\\n`))
    expect(cfg).toContain(`${machineId}:`)
    expect(cfg).toMatch(/addrs:\n\s+- \S+:\d+/)
    // The machine runs on the Mac's relay choice, and lets in only this Mac.
    const st = await hostRpc('net.status') as { node?: { relayMode?: string; peers?: Array<{ id: string; accept: boolean }> } }
    expect(st.node?.relayMode).toBe(RELAY)
    const ov = await (await api('/api/hosts/net')).json() as { macId: string }
    expect(st.node?.peers?.map((p) => [p.id, p.accept])).toEqual([[ov.macId, true]])

    const h = await connected(machine)
    expect(h.steps?.map((s) => s.phase)).toEqual(['tunnel', 'handshake'])
    // Its row was written by the host network, not by Settings: its live frame still goes
    // out, so the page says Connected (2026-11-02: it read "Retrying" until a reload).
    await waitFor(async () => frames.some((f) => f.host === machine && f.connected === true), 10_000, 'the machine\'s connected frame')
    expect(isolation!.calls().join('\n')).not.toContain(machine)
    await fsp.writeFile(path.join(host.home, 'on-the-machine.txt'), 'hello\n')
    expect(await filesOnMachine(machine)).toContain('on-the-machine.txt')
    // On each connect the Mac notes where the machine listens now.
    const own = ((await hostRpc('net.status')) as { node?: { addrs?: string[] } }).node?.addrs ?? []
    await waitFor(async () => own.every((a) => !/^[\d.]+:\d+$/.test(a) || config().includes(a)), 30_000, 'the Mac to note where the machine listens')
  }, 300_000)

  it('service preview uses the real network link while every SSH login is refused', async () => {
    const { importSessionRecord } = await import('../../src/core/session-tracker.js')
    const sid = 'host-network-preview'
    await importSessionRecord({ claudeSessionId: sid, taskId: '', project: 'Fixture', cwd: host.home, host: machine })
    const service = http.createServer((req, res) => res.end(`network preview ${req.url}`))
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    const port = (service.address() as net.AddressInfo).port
    const sshBefore = isolation!.calls().length
    try {
      for (const page of ['/first?q=1', '/again']) {
        const response = await api(`/api/sessions/${sid}/service-preview`, {
          method: 'POST', body: JSON.stringify({ url: `http://localhost:${port}${page}` }),
        })
        const preview = await response.json() as { url: string; host: string; via: string; reachability: string }
        expect(response.status, JSON.stringify(preview)).toBe(200)
        expect(preview).toMatchObject({ host: machine, via: 'tunnel', reachability: 'ok' })
        expect(await (await fetch(preview.url)).text()).toBe(`network preview ${page}`)
      }
      const empty = net.createServer()
      await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve))
      const emptyPort = (empty.address() as net.AddressInfo).port
      await new Promise<void>((resolve) => empty.close(() => resolve()))
      const unavailable = await api(`/api/sessions/${sid}/service-preview`, {
        method: 'POST', body: JSON.stringify({ url: `http://localhost:${emptyPort}/` }),
      })
      expect(unavailable.status).toBe(502)
      expect(await unavailable.json()).toMatchObject({ code: 'unreachable' })
      // Budget GET follows the same current host target, even when its former SSH login fails.
      // This new fixture session has no budget: absent=null is the older-client contract.
      const budget = await api(`/api/usage/sessions/${sid}?absent=null`)
      expect(budget.status, await budget.clone().text()).toBe(200)
      expect(await budget.json()).toBeNull()
      expect(isolation!.calls().length).toBe(sshBefore)
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()))
    }
  }, 120_000)

  it('a hub forward on the machine reaches a listed port on the Mac\'s loopback over the network link, and nothing else', async () => {
    // "The Mac's coderelay": a service on this machine's 127.0.0.1 only.
    let macConns = 0
    const body = Buffer.alloc(1024 * 1024 + 5)
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff
    const service = http.createServer((req, res) => res.end(req.url === '/bin' ? body : `mac coderelay ${req.url}`))
    service.on('connection', () => { macConns++ })
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    const svc = (service.address() as net.AddressInfo).port
    const free = async () => {
      const s = net.createServer()
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
      const p = (s.address() as net.AddressInfo).port
      await new Promise<void>((r) => s.close(() => r()))
      return p
    }
    const local = await free()
    const get = (p: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: local, path: p, agent: false }, (res) => {
        const parts: Buffer[] = []
        res.on('data', (b: Buffer) => parts.push(b))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      })
      req.on('error', reject)
    })
    const walnut = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
      const run = spawn(path.join(base, 'host', 'bin', 'walnut'), args, { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      run.stdout!.on('data', (b: Buffer) => { out += b.toString() })
      run.stderr!.on('data', (b: Buffer) => { out += b.toString() })
      run.once('exit', (c) => resolve({ code: c ?? -1, out }))
    })
    const { migrateStoredConfig } = await import('../../src/core/config-manager.js')
    const { listPluginHosts } = await import('../../src/core/plugins/plugin-hosts.js')
    try {
      // On the machine: its own file, written by its own CLI; it listens on 127.0.0.1.
      const added = await walnut(['net', 'hub-forward', 'add', String(local), String(svc)])
      expect(added.code, added.out).toBe(0)
      expect(added.out).toContain(`127.0.0.1:${local} -> the primary's 127.0.0.1:${svc}: listening`)
      expect(fs.existsSync(path.join(host.daemonDir, 'net', 'hub-forwards.json'))).toBe(true)

      // The Mac lists nothing yet: the machine's connection is refused, nothing reaches the service.
      await expect(get('/before')).rejects.toThrow()
      expect(macConns).toBe(0)
      const refusedThere = ((await hostRpc('hub.status')).forwards as Array<Record<string, unknown>>)[0]
      expect(refusedThere).toMatchObject({ refused: 1, opened: 0, lastRefusal: `port ${svc} on this Walnut is not open to hub forwards (net.hub_ports)` })
      expect((await listPluginHosts()).find((h) => h.alias === machine)?.hub).toBeUndefined()

      // The Mac lists the port for this machine: the bytes go over the host network link.
      await migrateStoredConfig((doc) => { (doc.net as Record<string, unknown>).hub_ports = [{ port: svc, hosts: [machine] }]; return true })
      expect((await get('/v1/messages')).body.toString()).toBe('mac coderelay /v1/messages')
      expect((await get('/bin')).body.equals(body)).toBe(true)
      expect(macConns).toBe(2)
      const row = (await listPluginHosts()).find((h) => h.alias === machine)
      expect(row?.hub).toEqual([expect.objectContaining({ port: svc, linked: true, up: true, needsUpdate: false, forward: { localPort: local, listening: true, error: null, waiting: null }, opened: 2 })])
      expect(row!.hub![0].lastConnectedAt).toBeGreaterThan(Date.now() - 60_000)
      // Listed for another machine only: refused again.
      await migrateStoredConfig((doc) => { (doc.net as Record<string, unknown>).hub_ports = [{ port: svc, hosts: ['some-other-machine'] }]; return true })
      await expect(get('/other')).rejects.toThrow()
      expect(macConns).toBe(2)
      expect(isolation!.calls().join('\n')).not.toContain(machine)

      const removed = await walnut(['net', 'hub-forward', 'remove', String(local)])
      expect(removed.code, removed.out).toBe(0)
      expect(removed.out).toContain('No hub forwards on this machine.')
    } finally {
      await migrateStoredConfig((doc) => { delete (doc.net as Record<string, unknown>).hub_ports; return true })
      await new Promise<void>((resolve) => service.close(() => resolve()))
    }
  }, 180_000)

  it('the same command again says the link is spent, and the machine keeps its network', async () => {
    const r = await runJoin(ticket)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain('This link is not valid any more')
    const st = await hostRpc('net.status') as { enabled?: boolean; running?: boolean; node?: { relayMode?: string; peers?: Array<{ accept: boolean }> } }
    expect(st).toMatchObject({ enabled: true, running: true })
    expect(st.node?.relayMode).toBe(RELAY)
    expect(st.node?.peers?.map((p) => p.accept)).toEqual([true])
    await fsp.writeFile(path.join(host.home, 'still-here.txt'), 'yes\n')
    expect(await waitFor(async () => (await filesOnMachine(machine)).includes('still-here.txt'), 60_000, 'the machine to answer')).toBe(true)
  }, 240_000)

  it('a restart of the machine keeps its port, so even with no relay the Mac reaches it again', async () => {
    const port = (s: Record<string, unknown>) => ((s.node as { addrs?: string[] } | null)?.addrs ?? []).map((a) => a.split(':').pop()).find(Boolean)
    const before = port(await hostRpc('net.status'))
    expect(before).toBeTruthy()
    await stopChild(hostDaemon)
    await startHostDaemon()
    const after = await waitFor(async () => port(await hostRpc('net.status')), 30_000, 'walnut-net to come back')
    expect(after).toBe(before)
    await fsp.writeFile(path.join(host.home, 'after-restart.txt'), 'yes\n')
    await connected(machine)
    expect(await waitFor(async () => (await filesOnMachine(machine)).includes('after-restart.txt'), 90_000, 'the machine to answer after its restart')).toBe(true)
  }, 300_000)

  it('Remove turns the machine\'s network off and drops it from this Mac\'s list', async () => {
    const r = await api(`/api/hosts/net/machines/${encodeURIComponent(machine)}`, { method: 'DELETE' })
    expect(r.status, await r.clone().text()).toBe(200)
    await waitFor(async () => ((await hostRpc('net.status')) as { enabled?: boolean }).enabled === false, 30_000, 'the machine to turn its network off')
    const cfg = config()
    expect(cfg).not.toContain(machineId)
    const o = await (await api('/api/hosts/net')).json() as { machines: Array<{ host: string }> }
    expect(o.machines.map((m) => m.host)).not.toContain(machine)
    // No reconnect loop is left dialling a machine that is out (2026-11-03: it ran on,
    // read as a dial in flight, and the machine that joined again was never dialled).
    expect(peekDaemonConnection(machine)).toBeNull()
  }, 120_000)

  it('the machine joins again under its name, nothing reads as dialling it, and the Mac reaches it', async () => {
    const made = await api('/api/hosts/net/invites', { method: 'POST', body: '{}' })
    const invite = await made.json() as { id: string; link: string }
    expect(made.status, JSON.stringify(invite)).toBe(201)
    const again = RELAY === 'public' ? encodeTicket({ ...decodeTicket(invite.link)!, addrs: [] }) : invite.link
    const r = await runJoin(again)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`done: this machine is "${machine}"`)
    const row = await waitFor(async () => {
      const s = await (await api('/api/hosts/status')).json() as { hosts?: Array<{ host: string; phase?: string; connected: boolean }> }
      return s.hosts?.find((x) => x.host === machine)
    }, 30_000, 'the machine listed again')
    // What the warmup asks before it dials: no dial of the old machine stands in the way.
    expect(row.connected).toBe(false)
    expect(CONNECT_IN_FLIGHT_PHASES.has((row.phase ?? 'idle') as never), JSON.stringify(row)).toBe(false)
    await connected(machine)
    expect(await filesOnMachine(machine)).toContain('on-the-machine.txt')
  }, 300_000)

  // 2026-11-04: an offline PC read "WebSocket connection failed: ECONNRESET (url=ws://127.0.0.1:…)",
  // filed as "The session daemon did not start" (core/hosts/net-link.ts).
  it('a machine that goes off reads as not online on the host network, and comes back on its own', async () => {
    await stopChild(hostDaemon)
    hostDaemon = null
    let seen: unknown = null
    const row = await waitFor(async () => {
      const s = await (await api('/api/hosts/status')).json() as { hosts?: Array<{ host: string; connected: boolean; error?: string; kind?: string; lastError?: string; lastKind?: string; hint?: string; lastHint?: string }> }
      const h = s.hosts?.find((x) => x.host === machine)
      seen = h
      return h && !h.connected && /is not online on the host network/.test(`${h.error ?? ''} ${h.lastError ?? ''}`) ? h : null
    }, 120_000, 'the machine to read as offline').catch((err: Error) => { throw new Error(`${err.message}; last status: ${JSON.stringify(seen)}`) })
    const text = JSON.stringify(row)
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toMatch(/ECONNRESET|session daemon/i)
    expect(row.kind ?? row.lastKind).toBe('unreachable')
    expect(row.hint ?? row.lastHint).toContain('walnut net status')
    await startHostDaemon()
    await connected(machine)
    expect(await filesOnMachine(machine)).toContain('on-the-machine.txt')
  }, 300_000)
})
