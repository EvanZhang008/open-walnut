/**
 * The host network end to end (docs/reference/host-network.md), every part real but
 * the agent CLI:
 *
 *   this primary (startServer, "the Mac") ── its local daemon ── walnut-net ─┐
 *        │ owner calls (/api/v1/net/*)                                        │ iroh, direct or
 *        ▼                                                                    │ through the relay
 *   the companion (WALNUT_CLOUD_MODE=1, child process) ◀── relay-access ── iroh-relay 1.4.1
 *        ▲ POST /api/v1/net/join                                              │
 *        │                                                                    │
 *   a new machine: `curl <link> | sh` ── walnut net join ── its daemon ── walnut-net ─┘
 *
 * What it proves:
 *  1. a stranger gets nothing: a wrong code (join and link), the relay check without
 *     the relay's token;
 *  2. the invite link joins a machine: the script prints the approved screen, the
 *     companion lists the machine, the Mac makes it a `transport: net` host on its own,
 *     and the relay lets both machines in (the relay asks the companion for each);
 *  3. the Mac reaches that machine's daemon through the host network and runs a command
 *     there (its HOME is the machine's, not this one's), and Settings shows its path;
 *  4. a Settings save of the SSH hosts keeps the machine's row, and a row an older
 *     Walnut saved without its transport and endpoint (a label renamed too) is taken back;
 *  5. a Remove the companion cannot answer changes nothing;
 *  6. Remove takes it out everywhere, also with a sync running: its walnut-net stops (and
 *     stays stopped), the companion and the relay refuse it, the Mac's row is gone;
 *  7. with a companion the relay is always its own (public relays and no relay are refused).
 *
 * Needs walnut-net (WALNUT_NET_TEST_BIN, else dist/daemon-binaries/walnut-net-<platform>-<arch>),
 * the iroh-relay 1.4.1 binary (WALNUT_NET_TEST_RELAY) and bun; skipped without them.
 *
 * MACHINE SAFETY: every dir is under one temp base (each machine's HOME, the daemon dirs,
 * the member list, the relay's config); the join CLI is pointed at the test machine's
 * daemon (WALNUT_JOIN_DAEMON_DIR, which also forbids it to install a service); no
 * download (WALNUT_NET_NO_DOWNLOAD); real ssh is refused (isolateFromRealSsh). Processes
 * this test started are stopped through their own handles.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'
import { testBun } from '../helpers/bun-runtime.js'
import { netKey } from '../helpers/net-keys.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-net'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

const REPO = path.resolve(__dirname, '../..')
const NET_BIN = (() => {
  const env = process.env.WALNUT_NET_TEST_BIN
  if (env && fs.existsSync(env)) return env
  const built = path.join(REPO, `dist/daemon-binaries/walnut-net-${process.platform}-${process.arch}`)
  return fs.existsSync(built) ? built : null
})()
const RELAY_BIN = process.env.WALNUT_NET_TEST_RELAY && fs.existsSync(process.env.WALNUT_NET_TEST_RELAY) ? process.env.WALNUT_NET_TEST_RELAY : null
const BUN = testBun()
const suite = NET_BIN && RELAY_BIN && BUN ? describe : describe.skip

let base = ''
let isolation: SshIsolation | null = null
let replica: CloudBoxReplica | null = null
let relay: ChildProcess | null = null
let hostDaemon: ChildProcess | null = null
let primaryPort = 0
let companion = ''
let relayToken = ''
const host = { home: '', daemonDir: '', bin: '' }

const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${primaryPort}${p}`, {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
})
const box = (p: string, init: RequestInit = {}) => fetch(`http://${companion}${p}`, {
  ...init, headers: { 'content-type': 'application/json', Authorization: `Bearer ${replica!.tokens.mac}`, ...(init.headers ?? {}) },
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
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

/** The relay's own access question, as it asks it (loopback, its token). */
async function relayAllows(id: string, token = relayToken): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://${companion}/api/v1/net/relay-access`, {
    method: 'POST', headers: { 'X-Iroh-Endpoint-Id': id, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  return { status: r.status, body: await r.text() }
}

function stopChild(p: ChildProcess | null): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } resolve() }, 10_000)
    p.once('exit', () => { clearTimeout(t); resolve() })
    p.kill('SIGTERM')
  })
}

suite('host network: one link joins a machine, the Mac reaches it, Remove takes it out', () => {
  let machine = ''
  let machineId = ''
  let macId = ''

  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-host-net-e2e-'))
    const relayPort = await freePort()
    relayToken = crypto.randomBytes(16).toString('hex')
    const tokenFile = path.join(base, 'relay-token')
    await fsp.writeFile(tokenFile, relayToken, { mode: 0o600 })
    replica = await startCloudBoxReplica(base, undefined, {
      machineOwner: 'mac-primary',
      env: {
        WALNUT_NET_RELAYS: `http://127.0.0.1:${relayPort}`,
        WALNUT_NET_RELAY_TOKEN_FILE: tokenFile,
        WALNUT_NET_STORE_FILE: path.join(base, 'box', 'net-members.json'),
      },
    })
    companion = `127.0.0.1:${replica.port}`

    // The relay, asking the companion about each machine (as scripts/cloud/net-relay.sh sets it up).
    const relayToml = path.join(base, 'relay.toml')
    await fsp.writeFile(relayToml, `enable_relay = true\nhttp_bind_addr = "127.0.0.1:${relayPort}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n[access.http]\nurl = "http://${companion}/api/v1/net/relay-access"\n`)
    relay = spawn(RELAY_BIN!, ['-c', relayToml], { env: { ...process.env, IROH_RELAY_HTTP_BEARER_TOKEN: relayToken }, stdio: ['ignore', 'ignore', 'pipe'] })
    await waitFor(async () => (await fetch(`http://127.0.0.1:${relayPort}/ping`).catch(() => null))?.ok, 20_000, 'the relay')

    // This Mac: its daemon runs the walnut-net under test, over a plain-HTTP relay.
    process.env.WALNUT_NET_BIN = NET_BIN!
    process.env.WALNUT_NET_ALLOW_HTTP_RELAY = '1'
    process.env.WALNUT_NET_NO_DOWNLOAD = '1'
    // A test server never runs the network on its own (net-mac.ts netActive): this one does.
    process.env.WALNUT_NET_ACTIVE = '1'
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
    await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
    await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\nhosts:\n  devbox:\n    hostname: devbox.example\n    enabled: false\n')
    await seedPrimaryPairing(WALNUT_HOME, companion, replica.tokens)
    isolation = isolateFromRealSsh(base)
    const server = await startServer({ port: 0, dev: true })
    primaryPort = (server.address() as net.AddressInfo).port
    // A test server does not start it at boot (VITEST): the reach-out on connect is what is under test.
    await (await import('../../src/core/net/net-mac.js')).startNet()

    // The new machine: its own HOME and daemon (the bun twin), nothing shared with this one.
    host.home = path.join(base, 'host', 'home')
    host.daemonDir = path.join(base, 'host', 'daemon')
    await fsp.mkdir(host.home, { recursive: true })
    const hostEnv: NodeJS.ProcessEnv = {
      ...process.env, HOME: host.home, WALNUT_HOME_OVERRIDE: host.home, SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: host.daemonDir, WALNUT_STREAMS_DIR: path.join(base, 'host', 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'host', 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(base, 'host', 'spawn-journal.jsonl'),
      WALNUT_TASK_DIR_ROOT: path.join(base, 'host', 'tasks'), OPEN_WALNUT_HOME: path.join(host.home, '.open-walnut'),
    }
    for (const k of ['XDG_STATE_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete hostEnv[k]
    hostDaemon = spawn(BUN!, [path.join(REPO, 'src/providers/daemon-standalone.ts'), '--start'], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    await waitFor(async () => fs.existsSync(path.join(host.daemonDir, 'daemon.port')) && (await hostRpc('hello')).ok === true, 60_000, 'the machine\'s daemon')
    // `walnut` on the machine's PATH: this checkout's CLI.
    host.bin = path.join(base, 'host', 'bin')
    await fsp.mkdir(host.bin, { recursive: true })
    await fsp.writeFile(path.join(host.bin, 'walnut'), `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(path.join(REPO, 'src/cli.ts'))} "$@"\n`, { mode: 0o755 })
    Object.assign(hostEnv, { PATH: `${host.bin}:${process.env.PATH}`, WALNUT_JOIN_DAEMON_DIR: host.daemonDir, WALNUT_NET_ALLOW_HTTP_JOIN: '1' })
    ;(globalThis as { __hostEnv?: NodeJS.ProcessEnv }).__hostEnv = hostEnv
  }, 600_000)

  afterAll(async () => {
    try { await stopServer() } catch { /* best-effort */ }
    await stopChild(hostDaemon)
    await stopChild(relay)
    try { await replica?.stop() } catch { /* best-effort */ }
    isolation?.restore()
    for (const k of ['WALNUT_NET_BIN', 'WALNUT_NET_ALLOW_HTTP_RELAY', 'WALNUT_NET_NO_DOWNLOAD', 'WALNUT_NET_ACTIVE']) delete process.env[k]
    if (base.includes('walnut-host-net-e2e-')) await fsp.rm(base, { recursive: true, force: true })
  }, 120_000)

  it('a stranger gets nothing: a wrong code, a wrong link, the relay check without its token', async () => {
    const join = await fetch(`http://${companion}/api/v1/net/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAA-BBBB-CCCC', endpointId: netKey('stranger'), hostname: 'x' }),
    })
    expect(join.status).toBe(400)
    expect(((await join.json()) as { error: { code: string } }).error.code).toBe('invalid_code')
    // A wrong link is a script that says why (200, so `curl -f` hands it to sh), and fails.
    const link = await fetch(`http://${companion}/join/AAAA-BBBB-CCCC`)
    expect(link.status).toBe(200)
    expect(await link.text()).toMatch(/^echo "This invite is not valid.*exit 1\n$/s)
    const wrong = spawn('sh', ['-c', `curl -fsSL http://${companion}/join/AAAA-BBBB-CCCC | sh`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    wrong.stderr!.on('data', (b: Buffer) => { said += b.toString() })
    expect(await new Promise<number>((r) => wrong.once('exit', (c) => r(c ?? -1)))).toBe(1)
    expect(said).toContain('This invite is not valid any more')
    expect((await relayAllows('a'.repeat(64), '')).status).toBe(403)
    expect((await relayAllows('a'.repeat(64), 'wrong')).status).toBe(403)
    // A phone (not the owner Mac) may not manage the machines.
    const phone = await fetch(`http://${companion}/api/v1/net/info`, { headers: { Authorization: `Bearer ${replica!.tokens.phone}` } })
    expect(phone.status).toBe(403)
  })

  it('the invite link joins the machine, and the Mac makes it a host on its own', async () => {
    const made = await api('/api/hosts/net/invites', { method: 'POST', body: '{}' })
    const invite = await made.json() as { id: string; link: string; command: string; state: string; expiresAt: number }
    expect(made.status, JSON.stringify(invite)).toBe(201)
    expect(invite.state).toBe('waiting')
    expect(invite.command).toBe(`curl -fsSL ${invite.link} | sh`)
    expect(invite.link).toMatch(new RegExp(`^http://${companion.replace(/\./g, '\\.')}/join/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$`))

    // The Mac told the companion its own id, and the relay lets it in.
    const info = await (await box('/api/v1/net/info')).json() as { members: Array<{ id: string; role: string }>; relays: string[] }
    macId = info.members.find((m) => m.role === 'mac')!.id
    expect(macId).toMatch(/^[0-9a-f]{64}$/)
    expect(await relayAllows(macId)).toEqual({ status: 200, body: 'true' })

    // On the machine: exactly what the user pastes.
    const script = await (await fetch(invite.link)).text()
    const run = spawn('sh', ['-c', `curl -fsSL ${invite.link} | sh`], { env: (globalThis as { __hostEnv?: NodeJS.ProcessEnv }).__hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    run.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    run.stderr!.on('data', (b: Buffer) => { out += b.toString() })
    const code = await new Promise<number>((r) => run.once('exit', (c) => r(c ?? -1)))
    expect(script).toContain('exec "$W" net join')
    expect(code, out).toBe(0)
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('Walnut: adding this machine to your Walnut machines')
    expect(lines[1]).toMatch(/^ {2}1\/3 {2}Walnut \.{12} installed \(.+\)$/)
    expect(lines[2]).toBe('  2/3  Keep it running ... on (already running)')
    const done = /^ {2}3\/3 {2}Join \.{14} done: this machine is "([A-Za-z0-9._-]+)"$/.exec(lines[3])
    expect(done, out).not.toBeNull()
    machine = done![1]
    expect(out).toContain(`Your Mac lists "${machine}" under Settings > Remote Hosts.`)

    // The link is spent.
    expect(await (await fetch(invite.link)).text()).toMatch(/^echo "This invite is not valid/)
    // The Mac sees the join and lists it, with how it reaches it.
    await waitFor(async () => (await (await api(`/api/hosts/net/invites/${invite.id}`)).json() as { state: string }).state === 'joined', 30_000, 'the invite to read joined')
    const listed = await waitFor(async () => {
      const r = await (await api('/api/hosts/net')).json() as { machines: Array<{ host: string; endpoint: string; path: string }> }
      return r.machines.find((m) => m.host === machine)
    }, 30_000, 'Settings to list the machine')
    machineId = listed.endpoint
    expect((await hostRpc('net.identity')).endpointId).toBe(machineId)
    // Its row: a hostname that never resolves (an older Walnut would read the row as an
    // SSH host), the endpoint this Mac dials.
    const cfg = fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')
    expect(cfg).toMatch(new RegExp(`\\n  ${machine}:\\n    hostname: ${machine}\\.walnut-net\\.invalid\\n    label: ${machine}\\n    transport: net\\n    endpoint: ${machineId}\\n`))
    // Both machines are on the relay: it asked the companion and was told yes.
    expect(await relayAllows(machineId)).toEqual({ status: 200, body: 'true' })
    const st = await hostRpc('net.status') as { node?: { relays?: Array<{ connected: boolean }> } }
    expect(st.node?.relays?.[0]?.connected).toBe(true)
  }, 300_000)

  it('the Mac reaches the machine\'s own daemon through the host network, and Settings shows the path', async () => {
    await api(`/api/hosts/${machine}/connect`, { method: 'POST', body: '{}' })
    const st = await waitFor(async () => {
      const s = await (await api('/api/hosts/status')).json() as { hosts?: Array<{ host: string; connected: boolean; daemonDir?: { path: string }; steps?: Array<{ phase: string }> }> }
      const h = s.hosts?.find((x) => x.host === machine)
      return h?.connected ? h : null
    }, 90_000, 'the machine to connect')
    // Reached with no SSH step (and ssh here refuses everything: isolateFromRealSsh).
    expect(st.steps?.map((s) => s.phase)).toEqual(['tunnel', 'handshake'])
    expect(isolation!.calls().join('\n')).not.toContain(machine)
    // A file there, read through that daemon.
    await fsp.writeFile(path.join(host.home, 'on-the-machine.txt'), 'hello from the machine\n')
    const list = await (await api(`/api/v1/files/list?host=${encodeURIComponent(machine)}&path=${encodeURIComponent(host.home)}`)).json() as { entries?: Array<{ name: string }>; files?: Array<{ name: string }> }
    expect(JSON.stringify(list)).toContain('on-the-machine.txt')
    const listed = await waitFor(async () => {
      const r = await (await api('/api/hosts/net')).json() as { machines: Array<{ host: string; path: string; rttMs?: number }> }
      const m = r.machines.find((x) => x.host === machine)
      return m && (m.path === 'direct' || m.path === 'relay') ? m : null
    }, 30_000, 'Settings to show the path')
    expect(typeof listed.rttMs).toBe('number')
  }, 180_000)

  it('with a companion the relay is its own: public relays and no relay are refused, nothing moves', async () => {
    const before = await (await api('/api/hosts/net')).json() as { companion: boolean; relay: string }
    expect(before).toMatchObject({ companion: true, relay: 'own' })
    for (const pick of ['public', 'none']) {
      const r = await api('/api/hosts/net/relay', { method: 'PUT', body: JSON.stringify({ relay: pick }) })
      expect(r.status).toBe(400)
      expect(((await r.json()) as { code: string }).code).toBe('companion_relay')
    }
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).not.toMatch(/\n {2}relay:/)
    const st = await hostRpc('net.status') as { node?: { relayMode?: string } }
    expect(st.node?.relayMode).toBe('custom')
  })

  it('a Settings save of the SSH hosts keeps the machine', async () => {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify({ hosts: { devbox: { hostname: 'devbox.example', enabled: false } } }) })
    expect(r.status).toBe(200)
    const cfg = fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')
    expect(cfg).toContain(`endpoint: ${machineId}`)
  })

  it('a companion that lost its list gets the machine back from the Mac; an unreadable list removes nothing', async () => {
    const store = path.join(base, 'box', 'net-members.json')
    const before = fs.readFileSync(store, 'utf8')
    // Unreadable: the companion says so, and the Mac keeps its row.
    fs.writeFileSync(store, '{ not json')
    expect((await box('/api/v1/net/info')).status).toBe(500)
    const bad = await (await api('/api/hosts/net/sync', { method: 'POST', body: '{}' })).json() as { error: string | null }
    expect(bad.error).toMatch(/not valid JSON/)
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).toContain(`endpoint: ${machineId}`)
    // Lost (a companion rebuilt without its state): the Mac puts the machine back.
    fs.rmSync(store)
    const ok = await (await api('/api/hosts/net/sync', { method: 'POST', body: '{}' })).json() as { error: string | null }
    expect(ok.error).toBeNull()
    const info = await (await box('/api/v1/net/info')).json() as { members: Array<{ id: string; name: string; role: string }> }
    expect(info.members.find((m) => m.id === machineId)).toMatchObject({ name: machine, role: 'host' })
    expect(info.members.find((m) => m.id === macId)).toMatchObject({ role: 'mac' })
    expect(await relayAllows(machineId)).toEqual({ status: 200, body: 'true' })
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).members).toHaveLength(JSON.parse(before).members.length)
  })

  it('an SSH host saved under the name of the machine is refused', async () => {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify({ hosts: { devbox: { hostname: 'devbox.example', enabled: false }, [machine]: { hostname: 'other.example' } } }) })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { code: string }).code).toBe('host_alias_taken')
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).toContain(`endpoint: ${machineId}`)
  })

  it('a row an older Walnut saved without transport and endpoint is taken back, under a label renamed too', async () => {
    const { modifyConfigDoc } = await import('../../src/core/config-store.js')
    await modifyConfigDoc((doc) => {
      const hosts = { ...(doc.hosts as Record<string, Record<string, unknown>>) }
      const { transport: _t, endpoint: _e, ...rest } = hosts[machine]
      hosts[machine] = { ...rest, label: 'GPU box' }
      doc.hosts = hosts
      return { write: true, result: undefined }
    })
    const r = await (await api('/api/hosts/net/sync', { method: 'POST', body: '{}' })).json() as { error: string | null }
    expect(r.error).toBeNull()
    const { getConfig } = await import('../../src/core/config-manager.js')
    const hosts = (await getConfig()).hosts as Record<string, { transport?: string; endpoint?: string; label?: string }>
    expect(hosts[machine]).toMatchObject({ transport: 'net', endpoint: machineId, label: 'GPU box' })
    expect(Object.keys(hosts).filter((k) => hosts[k].endpoint === machineId || k.startsWith(`${machine}-net`))).toEqual([machine])
  })

  it('a Remove the companion cannot answer changes nothing', async () => {
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input instanceof Request ? input.url : input).includes('/api/v1/net/members/') && init?.method === 'DELETE') return Promise.reject(new TypeError('fetch failed'))
      return real(input, init)
    })
    try {
      const r = await api(`/api/hosts/net/machines/${machine}`, { method: 'DELETE' })
      expect(r.status).toBeGreaterThanOrEqual(400)
    } finally {
      spy.mockRestore()
    }
    const { getConfig } = await import('../../src/core/config-manager.js')
    const cfg = await getConfig() as { net?: { removing?: string[] }; hosts?: Record<string, { endpoint?: string }> }
    expect(cfg.net?.removing ?? []).toEqual([])
    expect(cfg.hosts?.[machine]?.endpoint).toBe(machineId)
    expect(await relayAllows(machineId)).toEqual({ status: 200, body: 'true' })
    expect((await hostRpc('net.status') as { running?: boolean }).running).toBe(true)
  })

  it('Remove takes the machine out everywhere, also while a sync runs', async () => {
    // A sync that hands every machine its list must not hand it to the one Remove stops.
    const sync = api('/api/hosts/net/sync', { method: 'POST', body: '{}' })
    const r = await api(`/api/hosts/net/machines/${machine}`, { method: 'DELETE' })
    await sync
    expect(r.status, await r.clone().text()).toBe(200)
    const info = await (await box('/api/v1/net/info')).json() as { members: Array<{ id: string }> }
    expect(info.members.map((m) => m.id)).not.toContain(machineId)
    expect(await relayAllows(machineId)).toEqual({ status: 200, body: 'false' })
    // Its walnut-net stopped (the Mac told it; the reply rides the link it cuts), and it keeps its key.
    const st = await waitFor(async () => {
      const s = await hostRpc('net.status') as { enabled?: boolean; running?: boolean; endpointId?: string }
      return s.enabled === false && s.running === false ? s : null
    }, 15_000, 'the machine to stop its walnut-net')
    expect(st.endpointId).toBe(machineId)
    // And it stays stopped once every push of that sync is out.
    await new Promise((res) => setTimeout(res, 3_000))
    expect(await hostRpc('net.status')).toMatchObject({ enabled: false, running: false })
    const cfg = fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')
    expect(cfg).not.toContain(machineId)
    expect(cfg).toContain('devbox.example')
    const listed = await (await api('/api/hosts/net')).json() as { machines: unknown[] }
    expect(listed.machines).toEqual([])
    // The Mac stays a member.
    expect(await relayAllows(macId)).toEqual({ status: 200, body: 'true' })
  }, 120_000)
})
