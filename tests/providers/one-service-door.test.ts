/**
 * Everyone a host's one Walnut service does not call directly reaches it through its door
 * (daemon.port), as they reached a daemon program. Each case runs a real service-mode runtime in a
 * process of its own (tests/helpers/service-holder.ts: startInProcessDaemon with `service`, so
 * mode 'service', door open, daemon.pid, hello `serves: 'walnut-serve'`) and talks to it only
 * through that door:
 *   a. walnut-net: `net.configure` makes the runtime's net supervisor (net-core.ts) start
 *      walnut-net (a stub here) on a config naming the door's port file; the stub dials the door
 *      and its hello is this runtime's; `enabled: false` ends it.
 *   b. a second Walnut's host server: another leader's `server.configure` makes the supervisor
 *      (host-server-core.ts) start a child follower (a stub), which says `follower.hello` with the
 *      token the runtime gave it and is accepted; a wrong token and an unknown Walnut are refused;
 *      a spec of null stops it.
 *   c. a hub forward: a port the machine's hub-forwards.json names carries a TCP connection as a
 *      stream over the leader's link on the door, both ways; with the leader gone it refuses.
 *   d. two services on two dir sets of one HOME never adopt each other's sessions: each lists
 *      only its own, a restart of one never takes the other's CLI, each adopts its own again, and a
 *      stop asked of one for the other's session ends nothing.
 * MACHINE SAFETY: one temp root per case (HOME, data, daemon, state and net dirs); the stubs and
 * fake CLIs are this test's own scripts; the only pids signalled are the ones they report.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createStreamEndpoint } from '../../src/lib/link-stream.js'
import { alive, doorPort, fakeStreamCli, holderEnv, leaderOnDoor, openDoor, startHolder, stopHolders, until } from '../helpers/service-holder.js'

const BUN = process.versions.bun ? process.execPath : null
const LEADER = '/leader-of-test/walnut-home'
const WALNUT = 'w-service'
const roots: string[] = []
const holders: ChildProcess[] = []
const strays: number[] = []
afterAll(async () => {
  await stopHolders(holders)
  for (const pid of strays) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function tempRoot(name: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `one-service-door-${name}-`)))
  roots.push(root)
  return root
}

const daemonLog = (dir: string) => fs.readdirSync(dir).filter((n) => /^daemon-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n')
const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return null } }
/** A service's net state dir: the machine's, under its HOME (net-config-core.ts netStateDir). */
const netDirOf = (env: NodeJS.ProcessEnv) => path.join(env.HOME!, '.local', 'state', 'open-walnut', 'net')

/**
 * A stand-in walnut-net: `id --key <f>` answers an id made from its key; `run --config <f>` reads
 * the config the supervisor wrote, dials the daemon port its port file names, records the hello
 * it got beside the config, then says ready and answers its control socket until stdin closes.
 */
const NET_STUB = `
const fs = require('fs'), net = require('net'), path = require('path'), crypto = require('crypto')
const [verb, ...rest] = process.argv.slice(2)
const arg = (n) => rest[rest.indexOf(n) + 1]
const idOf = (key) => {
  if (!fs.existsSync(key)) fs.writeFileSync(key, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  return crypto.createHash('sha256').update(fs.readFileSync(key)).digest('hex')
}
if (verb === 'id') { console.log(JSON.stringify({ id: idOf(arg('--key')) })); process.exit(0) }
if (verb !== 'run') process.exit(64)
const configFile = arg('--config')
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const record = (v) => fs.writeFileSync(path.join(path.dirname(configFile), 'stub-dialed.json'), JSON.stringify(v))
const port = Number(fs.readFileSync(cfg.daemonPortFile, 'utf8'))
const ws = new WebSocket('ws://127.0.0.1:' + port)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' }))
ws.onerror = () => { record({ port, error: 'the door did not answer' }); process.exit(70) }
ws.onmessage = (m) => {
  const v = JSON.parse(String(m.data))
  if (v.id !== 1) return
  record({ port, pid: process.pid, hello: v })
  ws.close()
  try { fs.rmSync(cfg.control, { force: true }) } catch {}
  net.createServer((c) => c.once('data', () => c.end(JSON.stringify({ ok: true, addrs: [], peers: [] }) + '\\n'))).listen(cfg.control, () => {
    process.stdout.write(JSON.stringify({ event: 'ready', id: idOf(cfg.key), protocol: 2 }) + '\\n')
  })
}
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`

/** A stand-in follower server: says follower.hello on the door with the token it was started with, records the answer, reports, and stays. */
const FOLLOWER_STUB = `
const fs = require('fs')
const e = process.env
const ws = new WebSocket('ws://127.0.0.1:' + e.STUB_DOOR_PORT)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, cmd: 'follower.hello', home: e.STUB_HOME, walnutId: e.STUB_WALNUT, token: e.WALNUT_FOLLOWER_TOKEN }))
ws.onmessage = (m) => {
  const v = JSON.parse(String(m.data))
  if (v.id !== 1) return
  fs.writeFileSync(e.STUB_OUT, JSON.stringify({ pid: process.pid, hadToken: typeof e.WALNUT_FOLLOWER_TOKEN === 'string' && e.WALNUT_FOLLOWER_TOKEN.length >= 32, hello: v }))
  if (v.ok) ws.send(JSON.stringify({ id: 0, cmd: 'follower.report', report: { stub: true, pid: process.pid } }))
}
setInterval(() => {}, 1 << 30)
`

describe.skipIf(!BUN || process.platform !== 'linux')('a host\'s one Walnut service, through its door', () => {
  it('a. walnut-net: the net supervisor starts walnut-net on the door\'s port file, and walnut-net reaches this runtime', async () => {
    const root = tempRoot('net')
    const stub = path.join(root, 'walnut-net-stub.cjs')
    fs.writeFileSync(stub, NET_STUB)
    const bin = path.join(root, 'bin', 'walnut-net')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(stub)} "$@"\n`, { mode: 0o755 })
    const env = holderEnv(root, { serviceHome: LEADER, extra: { WALNUT_NET_BIN: bin } })
    const dir = env.WALNUT_DAEMON_DIR!
    const holder = await startHolder(env, holders)
    const port = doorPort(dir)
    const leader = await leaderOnDoor(port, LEADER, WALNUT)
    const said = await leader.call({ cmd: 'hello' })
    expect(said).toMatchObject({ ok: true, serves: 'walnut-serve' })
    expect(said.capabilities as string[]).toContain('net-v1')

    expect(await leader.call({ cmd: 'net.status' })).toMatchObject({ ok: true, available: true, enabled: false, running: false })
    const configured = await leader.call({ cmd: 'net.configure', relays: [], members: [] }, 40_000)
    expect(configured, holder.output().slice(-2000)).toMatchObject({ ok: true, running: true, endpointId: expect.stringMatching(/^[0-9a-f]{64}$/) })
    // Its config names the door's port file, and it lives under the machine's net state, not the daemon dir.
    const cfg = readJson(path.join(netDirOf(env), 'config.json'))!
    expect(cfg.daemonPortFile).toBe(path.join(dir, 'daemon.port'))
    // walnut-net dialed the door and was answered by this very runtime.
    const dialed = await until('walnut-net to dial the door', () => readJson(path.join(netDirOf(env), 'stub-dialed.json')))
    expect(dialed.port).toBe(port)
    expect(dialed.hello).toMatchObject({ ok: true, instanceId: said.instanceId, serves: 'walnut-serve' })
    const status = await leader.call({ cmd: 'net.status' })
    expect(status).toMatchObject({ ok: true, running: true, enabled: true, pid: dialed.pid, endpointId: configured.endpointId })
    strays.push(Number(dialed.pid))

    // Off: the supervisor ends it and forgets the config.
    expect(await leader.call({ cmd: 'net.configure', enabled: false }, 20_000)).toMatchObject({ ok: true, running: false })
    await until('walnut-net to exit', () => !alive(Number(dialed.pid)), 10_000)
    expect(fs.existsSync(path.join(netDirOf(env), 'config.json'))).toBe(false)
    leader.close()
    await holder.stop()
  }, 120_000)

  it('b. a second Walnut\'s host server: its child follower says follower.hello with its token and is accepted; a wrong token is refused', async () => {
    const root = tempRoot('second')
    const env = holderEnv(root, { serviceHome: LEADER })
    const dir = env.WALNUT_DAEMON_DIR!
    const holder = await startHolder(env, holders)
    const port = doorPort(dir)
    // The Walnut the service follows, and a second Walnut that uses this host too.
    const owner = await leaderOnDoor(port, LEADER, WALNUT)
    const SECOND = '/second-walnut/walnut-home'
    const second = await leaderOnDoor(port, SECOND, 'w-second')

    const stub = path.join(root, 'follower-stub.cjs')
    fs.writeFileSync(stub, FOLLOWER_STUB)
    const outFile = path.join(root, 'follower-said.json')
    fs.mkdirSync(path.join(root, 'second-data'), { recursive: true })
    const spec = {
      v: 1, home: SECOND, walnutId: 'w-second', command: BUN, args: [stub], cwd: path.join(root, 'second-data'), log: path.join(root, 'second-follower.log'),
      port: 1, settings: {}, env: { STUB_DOOR_PORT: String(port), STUB_HOME: SECOND, STUB_WALNUT: 'w-second', STUB_OUT: outFile },
    }
    // The second spec takes only its own Walnut: naming the service's Walnut is refused.
    expect(await second.call({ cmd: 'server.configure', home: SECOND, spec: { ...spec, walnutId: WALNUT } })).toMatchObject({ ok: false })
    const configured = await second.call({ cmd: 'server.configure', home: SECOND, spec })
    expect(configured, holder.output().slice(-2000)).toMatchObject({ ok: true, status: { state: 'running' } })
    const said = await until('the child follower to say hello', () => readJson(outFile))
    strays.push(Number(said.pid))
    expect(said.hadToken).toBe(true)
    expect(said.hello).toMatchObject({ ok: true, walnutId: 'w-second', home: SECOND })
    // It is the supervisor's child for that Walnut, and its report reaches that leader's server.status.
    const reported = await until('the report', async () => {
      const r = await second.call({ cmd: 'server.status', home: SECOND })
      return (r.status as { report?: unknown } | undefined)?.report ? r : null
    })
    expect(reported.status).toMatchObject({ state: 'running', pid: said.pid, report: { stub: true, pid: said.pid } })
    expect(daemonLog(dir)).toMatch(new RegExp(`follower: a server on this host follows its leader.*${SECOND.replace(/[/-]/g, '\\$&')}`))

    // A process the runtime did not start cannot speak for that Walnut: a wrong token, an unknown Walnut.
    const stranger = await openDoor(port)
    expect(await stranger.call({ cmd: 'follower.hello', home: SECOND, walnutId: 'w-second', token: '0'.repeat(64) })).toMatchObject({ ok: false, errorKind: 'not_started_here' })
    expect(await stranger.call({ cmd: 'follower.hello', home: '/nobody/home', walnutId: 'w-nobody', token: '0'.repeat(64) })).toMatchObject({ ok: false, errorKind: 'unknown_walnut' })
    stranger.close()

    // A spec of null stops the second Walnut's server.
    expect(await second.call({ cmd: 'server.configure', home: SECOND, spec: null })).toMatchObject({ ok: true })
    await until('the second follower to stop', () => !alive(Number(said.pid)), 15_000)
    owner.close()
    second.close()
    await holder.stop()
  }, 120_000)

  it('c. a hub forward: a listed port carries a TCP connection as a stream over the leader\'s link on the door', async () => {
    const root = tempRoot('hub')
    const env = holderEnv(root, { serviceHome: LEADER })
    // "The leader's loopback service": an echo server that says who it is.
    const echo = net.createServer((c) => { c.write('svc:'); c.pipe(c) })
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    const svcPort = (echo.address() as net.AddressInfo).port
    const local = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
    // The machine's own file, beside its network key.
    const forwards = path.join(netDirOf(env), 'hub-forwards.json')
    fs.mkdirSync(path.dirname(forwards), { recursive: true, mode: 0o700 })
    fs.writeFileSync(forwards, JSON.stringify({ forwards: [{ local_port: local, to: 'primary', port: svcPort }] }))
    const holder = await startHolder(env, holders)
    const port = doorPort(env.WALNUT_DAEMON_DIR!)

    try {
      const leader = await leaderOnDoor(port, LEADER, WALNUT)
      expect((await leader.call({ cmd: 'hello' })).capabilities as string[]).toContain('hub-forward-v1')
      // The leader's side: a stream endpoint that plugs a hub stream for the listed port into it.
      const opened: Array<{ from: string; port?: number }> = []
      const ep = createStreamEndpoint({
        send: (frame) => leader.ws.send(JSON.stringify(frame)),
        accept: (info) => {
          opened.push({ from: info.from, port: info.port })
          if (info.from !== 'hub' || info.port !== svcPort) return null
          return (stream) => {
            const s = net.connect(svcPort, '127.0.0.1')
            stream.pipe(s)
            s.pipe(stream)
            s.on('error', () => stream.destroy())
            stream.on('error', () => s.destroy())
          }
        },
      })
      leader.onEvent((frame) => { ep.handle(frame) })
      const listening = async () => {
        const st = await leader.call({ cmd: 'hub.status' })
        return ((st.forwards ?? []) as Array<Record<string, unknown>>).some((f) => f.local_port === local && f.listening === true) ? st : null
      }
      const st = await until('the forward to listen', listening, 20_000)
      expect(st.file).toBe(forwards)

      const roundTrip = (text: string) => new Promise<string>((resolve, reject) => {
        const c = net.connect(local, '127.0.0.1')
        let got = ''
        c.on('data', (b) => { got += b.toString(); if (got.length >= 4 + text.length) { c.end(); resolve(got) } })
        c.on('error', reject)
        c.on('connect', () => c.write(text))
      })
      const big = 'x'.repeat(256 * 1024)
      expect(await roundTrip('hello through the door')).toBe('svc:hello through the door')
      expect(await roundTrip(big)).toBe(`svc:${big}`)
      expect(opened).toEqual([{ from: 'hub', port: svcPort }, { from: 'hub', port: svcPort }])

      // With no leader link the port is not bound: a connection is refused by TCP.
      leader.close()
      const refused = await until('the forward to stop listening', () => new Promise<boolean>((resolve) => {
        const c = net.connect(local, '127.0.0.1')
        c.on('error', (err: Error & { code?: string }) => resolve(err.code === 'ECONNREFUSED'))
        c.on('connect', () => { c.destroy(); resolve(false) })
      }), 15_000)
      expect(refused).toBe(true)
    } finally {
      echo.close()
      await holder.stop()
    }
  }, 120_000)

  it('d. two services on two dir sets of one HOME never adopt each other\'s sessions', async () => {
    const root = tempRoot('two')
    const cli = fakeStreamCli(root)
    // One account (one HOME, one spawn journal), two Walnut services each with its own daemon, state and data dirs.
    const shared = { HOME: path.join(root, 'home'), WALNUT_HOME_OVERRIDE: path.join(root, 'home'), WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl') }
    const envA = holderEnv(path.join(root, 'a'), { serviceHome: '/walnut-a/home', extra: shared })
    const envB = holderEnv(path.join(root, 'b'), { serviceHome: '/walnut-b/home', extra: shared })
    fs.mkdirSync(shared.HOME, { recursive: true })
    const work = path.join(root, 'work')
    fs.mkdirSync(work, { recursive: true })
    const SID_A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
    const SID_B = 'bbbbbbbb-0000-4000-8000-0000000000b1'
    const start = async (env: NodeJS.ProcessEnv, sid: string) => {
      const door = await openDoor(doorPort(env.WALNUT_DAEMON_DIR!))
      const args = [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid]
      const r = await door.call({ cmd: 'start', sid, cwd: work, message: '', mode: 'default', args })
      door.close()
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
      strays.push(Number(r.pid))
      return Number(r.pid)
    }
    const sessionsOf = async (env: NodeJS.ProcessEnv) => {
      const door = await openDoor(doorPort(env.WALNUT_DAEMON_DIR!))
      const list = ((await door.call({ cmd: 'list' })).sessions ?? []) as Array<{ sid: string; pid: number; alive: boolean }>
      const status = await Promise.all([SID_A, SID_B].map(async (sid) => [sid, (await door.call({ cmd: 'status', sid })).exists === true] as const))
      door.close()
      return { listed: list.filter((s) => s.alive).map((s) => s.sid).sort(), known: status.filter(([, known]) => known).map(([sid]) => sid).sort() }
    }

    let a = await startHolder(envA, holders)
    let b = await startHolder(envB, holders)
    const pidA = await start(envA, SID_A)
    const pidB = await start(envB, SID_B)
    expect(await sessionsOf(envA)).toEqual({ listed: [SID_A], known: [SID_A] })
    expect(await sessionsOf(envB)).toEqual({ listed: [SID_B], known: [SID_B] })

    // A stops (a service keeps its sessions across its own restart); B restarts meanwhile: B never takes A's CLI.
    await a.stop()
    expect(alive(pidA)).toBe(true)
    await b.stop()
    b = await startHolder(envB, holders)
    expect(await sessionsOf(envB)).toEqual({ listed: [SID_B], known: [SID_B] })
    expect(alive(pidA)).toBe(true)
    // A comes back and adopts its own, with the same pid; B's stays B's.
    a = await startHolder(envA, holders)
    expect(await sessionsOf(envA)).toEqual({ listed: [SID_A], known: [SID_A] })
    const doorA = await openDoor(doorPort(envA.WALNUT_DAEMON_DIR!))
    expect(await doorA.call({ cmd: 'status', sid: SID_A })).toMatchObject({ ok: true, exists: true, alive: true, pid: pidA })
    doorA.close()
    expect(alive(pidB)).toBe(true)

    // A stop asked of B for A's session ends nothing; each service ends its own.
    const stopVia = async (env: NodeJS.ProcessEnv, sid: string) => {
      const door = await openDoor(doorPort(env.WALNUT_DAEMON_DIR!))
      const r = await door.call({ cmd: 'stop', sid })
      door.close()
      return r
    }
    await stopVia(envB, SID_A)
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(pidA)).toBe(true)
    expect((await stopVia(envA, SID_A)).ok).toBe(true)
    await until('A\'s CLI to end', () => !alive(pidA), 15_000)
    expect(alive(pidB)).toBe(true)
    expect((await stopVia(envB, SID_B)).ok).toBe(true)
    await until('B\'s CLI to end', () => !alive(pidB), 15_000)
    await a.stop()
    await b.stop()
  }, 180_000)
})
