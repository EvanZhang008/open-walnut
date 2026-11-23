/**
 * Two Walnut services on one machine share one walnut-net (src/providers/net-core.ts with
 * a service set id, net-config-core.ts netConfigText): one key, one config, one running
 * walnut-net; each service writes only its own set's members.
 *
 *  1. The default set with no other set writes exactly the text Walnut wrote before sets.
 *  2. Two writers interleaved (the default set and a set) never lose each other's members;
 *     the set's carry its daemon's port file, and the top-level one stays the default's.
 *  3. An older Walnut replacing the whole file drops the set's members; the set's next
 *     configure puts them back, and the default's stay.
 *  4. One machine listed by both sets is one entry: the one that lets it in.
 *  5. A service whose walnut-net another service runs starts no second one, has the running
 *     one read its writes, and takes over (same key, same state) once it is gone.
 *  6. Leaving removes only its own set's members; the file and the key stay while another
 *     set has members, and go (as before sets) when none remain.
 *
 * walnut-net itself is a fake here (it answers the control socket as the real one does);
 * the real one's routing per member is native/walnut-net/src/join_tests.rs, and the end-to-end
 * pair at the bottom runs the real binary when one is built.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { createNetSupervisor, type NetDeps, type NetSupervisor } from '../../src/providers/net-core.js'
import { netConfigText, netConfigWithout, parseNetConfig } from '../../src/providers/net-config-core.js'
import { netKey } from '../helpers/net-keys.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-sets-')))
afterAll(() => { if (root.includes('wn-net-sets-')) fs.rmSync(root, { recursive: true, force: true }) })

const SET = '0123456789abcdef'
const SELF = netKey('sets-self')
const macA = { id: netKey('sets-mac-a'), name: 'mac-a', accept: true }
const boxA = { id: netKey('sets-box-a'), name: 'box-a', accept: false, addrs: ['10.0.0.2:4100'] }
const macB = { id: netKey('sets-mac-b'), name: 'mac-b', accept: true }
const macB2 = { id: netKey('sets-mac-b2'), name: 'mac-b2', accept: true }

let open: NetSupervisor[] = []
afterEach(async () => {
  for (const s of open) await s.stop()
  open = []
})

/** A stand-in for walnut-net: `id` prints the key's id; `run` answers status and reload on the control socket. */
function fakeNet() {
  const seen = { runs: 0, reloads: 0, running: [] as Array<{ members: () => string[]; stop: () => void }> }
  const spawn: NetDeps['spawn'] = (_cmd, args) => {
    const p = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    Object.assign(p, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: 40000 + seen.runs })
    if (args[0] === 'id') {
      setTimeout(() => stdout.write(JSON.stringify({ id: SELF }) + '\n'), 1)
      setTimeout(() => p.emit('exit', 0, null), 20)
      return p
    }
    seen.runs++
    const configFile = args[2]!
    const read = () => JSON.parse(fs.readFileSync(configFile, 'utf8')) as { control: string; members: Array<{ name: string }> }
    const cfg = read()
    let members = cfg.members
    const server = net.createServer((sock) => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', (d: string) => {
        buf += d
        if (!buf.includes('\n')) return
        const req = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { op: string }
        let res: Record<string, unknown> = { ok: false, error: `unknown op ${req.op}` }
        if (req.op === 'reload') { seen.reloads++; members = read().members; res = { ok: true, restart: false } }
        if (req.op === 'status') res = { ok: true, peers: members.map((m) => ({ name: m.name })) }
        sock.end(JSON.stringify(res) + '\n')
      })
    })
    let alive = true
    const stop = (signal: string | null) => {
      if (!alive) return
      alive = false
      server.close()
      fs.rmSync(cfg.control, { force: true })
      setTimeout(() => p.emit('exit', signal ? null : 0, signal), 5)
    }
    Object.assign(p, { kill: (sig?: string) => { stop(sig ?? 'SIGTERM'); return true } })
    server.listen(cfg.control, () => stdout.write(JSON.stringify({ event: 'ready', id: SELF, protocol: 2 }) + '\n'))
    seen.running.push({ members: () => members.map((m) => m.name).sort(), stop: () => stop('SIGKILL') })
    return p
  }
  return { spawn, seen }
}

/** One service's supervisor on the machine's shared state dir (`machine`), with its own daemon port file. */
function service(machine: string, name: string, opts: { setId?: string; spawn: NetDeps['spawn']; bin?: string; heldCheckMs?: number }) {
  const dir = path.join(root, machine)
  const portFile = path.join(dir, `${name}.port`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(portFile, '1\n')
  const s = createNetSupervisor({
    spawn: opts.spawn, stateDir: path.join(dir, 'net'), portFile, bin: () => opts.bin ?? '/fake/walnut-net',
    ...(opts.setId !== undefined ? { setId: opts.setId } : {}),
    ...(opts.heldCheckMs ? { heldCheckMs: opts.heldCheckMs } : {}),
  })
  open.push(s)
  return { s, portFile, stateDir: path.join(dir, 'net'), configFile: path.join(dir, 'net', 'config.json') }
}

type FileMember = { id: string; name: string; walnut?: string; daemonPortFile?: string }
const fileOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as { daemonPortFile: string; members: FileMember[]; relayMode?: string }
const names = (f: string) => fileOf(f).members.map((m) => m.name).sort()

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('one walnut-net config, two service sets', () => {
  it('the default set alone writes the text Walnut wrote before sets', async () => {
    // Generated by HEAD's net-core.ts (before sets) for these inputs, with the dir names cut.
    const fake = fakeNet()
    const d = service('snapshot', 'default', { spawn: fake.spawn })
    const self = { id: SELF, name: 'me', accept: false }
    await d.s.configure({ relayMode: 'public', members: [macA, boxA, self] })
    await d.s.configure({ relayMode: 'public', members: [boxA, { ...macA, relays: ['https://relay.example.test'] }] })
    const text = fs.readFileSync(d.configFile, 'utf8').split(path.dirname(d.stateDir)).join('<dir>')
    expect(text).toBe(`{
  "version": 1,
  "key": "<dir>/net/net.key",
  "relayMode": "public",
  "relays": [],
  "relayRoots": [],
  "members": [
    {
      "id": "${boxA.id}",
      "name": "box-a",
      "accept": false,
      "addrs": [
        "10.0.0.2:4100"
      ]
    },
    {
      "id": "${macA.id}",
      "name": "mac-a",
      "accept": true,
      "relays": [
        "https://relay.example.test"
      ]
    }
  ],
  "daemonPortFile": "<dir>/default.port",
  "control": "<dir>/net/ctl.sock"
}
`)
    // And the pure writer gives the same text from the same request, with or without a file.
    const write = { setId: '', self: SELF, keyFile: path.join(d.stateDir, 'net.key'), control: path.join(d.stateDir, 'ctl.sock'), portFile: d.portFile, request: parseNetConfig({ relayMode: 'public', members: [boxA, { ...macA, relays: ['https://relay.example.test'] }] }) }
    const disk = fs.readFileSync(d.configFile, 'utf8')
    expect(netConfigText({ ...write, current: null })).toBe(disk)
    expect(netConfigText({ ...write, current: disk })).toBe(disk)
  })

  it("two writers interleaved keep each other's members, and only the default writes the top level", async () => {
    const fake = fakeNet()
    const d = service('pair', 'default', { spawn: fake.spawn })
    const b = service('pair', 'set', { spawn: fake.spawn, setId: SET })
    await d.s.configure({ relayMode: 'public', members: [macA] })
    await b.s.configure({ members: [macB] })
    await d.s.configure({ relayMode: 'public', members: [macA, boxA] })
    await b.s.configure({ members: [macB2] })
    const f = fileOf(d.configFile)
    expect(names(d.configFile)).toEqual(['box-a', 'mac-a', 'mac-b2'])
    expect(f.daemonPortFile).toBe(d.portFile)
    // The set's own request never moved the endpoint (no relay mode in it).
    expect(f.relayMode).toBe('public')
    const own = f.members.find((m) => m.name === 'mac-b2')!
    expect(own).toMatchObject({ walnut: SET, daemonPortFile: b.portFile })
    for (const m of f.members.filter((x) => x.name !== 'mac-b2')) {
      expect(m.walnut).toBeUndefined()
      expect(m.daemonPortFile).toBeUndefined()
    }
    // One walnut-net ran, and it read every write.
    expect(fake.seen.runs).toBe(1)
    expect(fake.seen.running[0]!.members()).toEqual(['box-a', 'mac-a', 'mac-b2'])
  })

  it("an older Walnut's whole-file write drops the set's members, and the set's next configure puts them back", async () => {
    const fake = fakeNet()
    const d = service('old', 'default', { spawn: fake.spawn })
    const b = service('old', 'set', { spawn: fake.spawn, setId: SET })
    await d.s.configure({ members: [macA] })
    await b.s.configure({ members: [macB] })
    // What today's applyConfig writes: the whole file, its own members only.
    const old = netConfigText({ current: null, setId: '', self: SELF, keyFile: path.join(d.stateDir, 'net.key'), control: path.join(d.stateDir, 'ctl.sock'), portFile: d.portFile, request: parseNetConfig({ members: [macA, boxA] }) })
    fs.writeFileSync(d.configFile, old)
    expect(names(d.configFile)).toEqual(['box-a', 'mac-a'])
    await b.s.configure({ members: [macB] })
    expect(names(d.configFile)).toEqual(['box-a', 'mac-a', 'mac-b'])
    expect(fileOf(d.configFile).daemonPortFile).toBe(d.portFile)
  })

  it('one machine listed by both sets stays one entry, the one that lets it in', () => {
    const base = { self: SELF, keyFile: '/s/net.key', control: '/s/ctl.sock' }
    const shared = { id: netKey('sets-shared'), name: 'shared', accept: false }
    const first = netConfigText({ ...base, current: null, setId: '', portFile: '/a.port', request: parseNetConfig({ members: [shared] }) })
    const taken = netConfigText({ ...base, current: first, setId: SET, portFile: '/b.port', request: parseNetConfig({ members: [{ ...shared, accept: true }] }) })
    const once = (JSON.parse(taken) as { members: FileMember[] }).members.filter((m) => m.id === shared.id)
    expect(once).toEqual([{ ...shared, accept: true, walnut: SET, daemonPortFile: '/b.port' }])
    // Two alike: the one already in the file stays, so the two never take it in turn.
    const alike = netConfigText({ ...base, current: first, setId: SET, portFile: '/b.port', request: parseNetConfig({ members: [shared] }) })
    expect((JSON.parse(alike) as { members: FileMember[] }).members).toEqual([shared])
  })

  it('a service whose walnut-net another service runs starts none, and takes over once it is gone', async () => {
    const fake = fakeNet()
    const d = service('held', 'default', { spawn: fake.spawn })
    const b = service('held', 'set', { spawn: fake.spawn, setId: SET, heldCheckMs: 100 })
    await d.s.configure({ members: [macA] })
    expect((await b.s.configure({ members: [macB] })).running).toBe(true)
    b.s.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(fake.seen.runs).toBe(1)
    const st = await b.s.status()
    expect(st).toMatchObject({ heldByOther: true, running: true, pid: null })
    expect(((st.node?.peers ?? []) as Array<{ name: string }>).map((p) => p.name).sort()).toEqual(['mac-a', 'mac-b'])
    // The holder's service goes (its walnut-net ends with it): the set's service runs one, on the same state.
    await d.s.stop()
    await until(async () => fake.seen.runs === 2 && (await b.s.status()).heldByOther === false, 5_000, 'the set to take over')
    expect(fake.seen.running[1]!.members()).toEqual(['mac-a', 'mac-b'])
  })

  it('a plain socket another walnut-net holds keeps it from starting a second, until it closes', async () => {
    const fake = fakeNet()
    const b = service('socket', 'set', { spawn: fake.spawn, setId: SET, heldCheckMs: 100 })
    fs.mkdirSync(b.stateDir, { recursive: true, mode: 0o700 })
    const conns = new Set<net.Socket>()
    const other = net.createServer((s) => { conns.add(s); s.on('error', () => {}); s.on('close', () => conns.delete(s)); s.end('{"ok":true,"restart":false}\n') })
    const sock = path.join(b.stateDir, 'ctl.sock')
    await new Promise<void>((r) => other.listen(sock, r))
    await b.s.configure({ members: [macB] })
    await new Promise((r) => setTimeout(r, 300))
    expect(fake.seen.runs).toBe(0)
    const closed = new Promise<void>((r) => other.close(() => r()))
    for (const c of conns) c.destroy()
    await closed
    fs.rmSync(sock, { force: true })
    await until(() => fake.seen.runs === 1, 5_000, 'it to start its own')
  })

  it('leaving removes only its own members; the file and key stay while another set has some', async () => {
    const fake = fakeNet()
    const d = service('leave', 'default', { spawn: fake.spawn })
    const b = service('leave', 'set', { spawn: fake.spawn, setId: SET })
    await d.s.configure({ members: [macA, boxA] })
    await b.s.configure({ members: [macB] })
    fs.writeFileSync(path.join(d.stateDir, 'net.key'), Buffer.alloc(32, 7), { mode: 0o600 })
    // The default set leaves first: the set's member stays, and its walnut-net keeps serving it.
    expect((await d.s.configure({ enabled: false })).running).toBe(true)
    expect(names(d.configFile)).toEqual(['mac-b'])
    expect(fake.seen.running[0]!.members()).toEqual(['mac-b'])
    await b.s.configure({ members: [macB, macB2] })
    // Then the set: none left, so the config goes as it did before sets; the key stays.
    expect((await b.s.configure({ enabled: false })).running).toBe(false)
    expect(fake.seen.running[0]!.members()).toEqual([])
    expect(fs.existsSync(d.configFile)).toBe(false)
    expect(fs.existsSync(path.join(d.stateDir, 'net.key'))).toBe(true)
  })

  it('a set leaving keeps the default members untouched in the text', () => {
    const base = { self: SELF, keyFile: '/s/net.key', control: '/s/ctl.sock' }
    const a = netConfigText({ ...base, current: null, setId: '', portFile: '/a.port', request: parseNetConfig({ members: [macA] }) })
    const both = netConfigText({ ...base, current: a, setId: SET, portFile: '/b.port', request: parseNetConfig({ members: [macB] }) })
    expect(netConfigWithout(both, SET)).toEqual({ text: a, remaining: 1 })
    expect(netConfigWithout(a, '')).toMatchObject({ remaining: 0 })
    expect(netConfigWithout(null, SET)).toBeNull()
  })
})

// The real walnut-net (built by scripts/build-walnut-net.sh), when there is one.
const NET_BIN = (() => {
  const env = process.env.WALNUT_NET_TEST_BIN
  if (env && fs.existsSync(env)) return env
  const built = path.resolve(__dirname, `../../dist/daemon-binaries/walnut-net-${process.platform}-${process.arch}`)
  return fs.existsSync(built) ? built : null
})()

describe.skipIf(!NET_BIN)('two services and the real walnut-net', () => {
  it('the second service writes into the one that runs, and takes it over with the same key', async () => {
    const spawn: NetDeps['spawn'] = (cmd, args, o) => realSpawn(cmd, args, o)
    const d = service('real', 'default', { spawn, bin: NET_BIN!, heldCheckMs: 200 })
    const b = service('real', 'set', { spawn, bin: NET_BIN!, setId: SET, heldCheckMs: 200 })
    const id = (await d.s.configure({ relayMode: 'none', members: [macA] })).endpointId
    expect((await b.s.configure({ members: [macB] })).endpointId).toBe(id)
    const peers = async (s: NetSupervisor) => (((await s.status()).node?.peers ?? []) as Array<{ name: string }>).map((p) => p.name).sort()
    expect(await peers(d.s)).toEqual(['mac-a', 'mac-b'])
    expect((await b.s.status()).heldByOther).toBe(true)
    await d.s.stop()
    await until(async () => { const st = await b.s.status(); return st.running && !st.heldByOther }, 20_000, 'the set to run walnut-net')
    expect((await b.s.status()).endpointId).toBe(id)
    expect(await peers(b.s)).toEqual(['mac-a', 'mac-b'])
  }, 60_000)
})
