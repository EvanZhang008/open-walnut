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
 *  4. the same command again says the link is spent and leaves the machine's network as it
 *     was (the Mac still reaches it);
 *  5. a restart of the machine keeps the port it listens on, so with no relay the Mac
 *     reaches it again;
 *  6. Remove turns the machine's network off and drops it from this Mac's list.
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

    // The new machine: its own HOME and daemon (the bun twin), nothing shared with this one.
    host.home = path.join(base, 'host', 'home')
    host.daemonDir = path.join(base, 'host', 'daemon')
    await fsp.mkdir(host.home, { recursive: true })
    const bin = path.join(base, 'host', 'bin')
    await fsp.mkdir(bin, { recursive: true })
    await fsp.writeFile(path.join(bin, 'walnut'), `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(path.join(REPO, 'src/cli.ts'))} "$@"\n`, { mode: 0o755 })
    hostEnv = {
      ...process.env, HOME: host.home, WALNUT_HOME_OVERRIDE: host.home, SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: host.daemonDir, WALNUT_STREAMS_DIR: path.join(base, 'host', 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'host', 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(base, 'host', 'spawn-journal.jsonl'),
      WALNUT_TASK_DIR_ROOT: path.join(base, 'host', 'tasks'), OPEN_WALNUT_HOME: path.join(host.home, '.open-walnut'),
      PATH: `${bin}:${process.env.PATH}`, WALNUT_JOIN_DAEMON_DIR: host.daemonDir,
    }
    for (const k of ['XDG_STATE_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete hostEnv[k]
    await startHostDaemon()
  }, 600_000)

  afterAll(async () => {
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
    expect(isolation!.calls().join('\n')).not.toContain(machine)
    await fsp.writeFile(path.join(host.home, 'on-the-machine.txt'), 'hello\n')
    expect(await filesOnMachine(machine)).toContain('on-the-machine.txt')
    // On each connect the Mac notes where the machine listens now.
    const own = ((await hostRpc('net.status')) as { node?: { addrs?: string[] } }).node?.addrs ?? []
    await waitFor(async () => own.every((a) => !/^[\d.]+:\d+$/.test(a) || config().includes(a)), 30_000, 'the Mac to note where the machine listens')
  }, 300_000)

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
  }, 120_000)
})
