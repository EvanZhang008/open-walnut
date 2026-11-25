/**
 * One Walnut service per machine and daemon dir (A3b): a dir whose session daemon another service
 * runs in its own process (its lock banner says inProcess) is refused with why, and never stopped
 * the way a daemon program is (that service's door answers on daemon.port as a program's does).
 * Another dir (a test's, dev:ephemeral's) is not touched.
 * The holder is a real second process (fixtures/in-process-service-holder.ts).
 * MACHINE SAFETY: temp roots only; the holder ends when its stdin closes; nothing is signalled.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AnotherServiceError, anotherServiceHolds, ensureInProcessDaemon } from '../../src/providers/in-process-daemon.js'
import { readDaemonInstanceOwner } from '../../src/providers/daemon-instance-lock.js'
import { doorPort, holderEnv, openDoor, startHolder as startHolderOf, stopHolders } from '../helpers/service-holder.js'

const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
const holders: ChildProcess[] = []
afterAll(async () => {
  await stopHolders(holders)
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

const envFor = (root: string) => holderEnv(root)
const startHolder = (env: NodeJS.ProcessEnv) => startHolderOf(env, holders)

describe.skipIf(!BUN)('one Walnut service per machine and daemon dir', () => {
  it('a second service on the dir is refused with why, and the first is never stopped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-'))
    roots.push(root)
    const env = envFor(root)
    const dir = env.WALNUT_DAEMON_DIR!
    const holder = await startHolder(env)

    // Its banner names its data dir, end to end (no server lock there: no port to name).
    expect(await anotherServiceHolds(dir)).toEqual({ pid: holder.pid, home: env.OPEN_WALNUT_HOME })
    // The first service's door answers on daemon.port like a program's would: it is not stopped.
    expect(fs.existsSync(path.join(dir, 'daemon.port'))).toBe(true)
    let stopped = false
    const second = ensureInProcessDaemon({
      dir, readPort: () => Number(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')), alive: async () => true,
      stopProgram: async () => { stopped = true }, env: async () => env,
    })
    await expect(second).rejects.toBeInstanceOf(AnotherServiceError)
    await expect(second).rejects.toThrow(new RegExp(`^Another Walnut server \\(pid ${holder.pid}, data dir ${env.OPEN_WALNUT_HOME}\\) already runs the session daemon of ${dir} in its own process`))
    expect(stopped).toBe(false)
    // Still running and still holding its dir.
    expect(holder.child.exitCode).toBeNull()
    expect(await anotherServiceHolds(dir)).toMatchObject({ pid: holder.pid })

    // Another dir (an isolated test or ephemeral server) is its own: nothing holds it.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-other-'))
    roots.push(other)
    expect(await anotherServiceHolds(other)).toBeNull()

    // Once the holder stops, the dir is free.
    holder.child.stdin!.end()
    await new Promise((r) => holder.child.once('exit', r))
    expect(await anotherServiceHolds(dir)).toBeNull()
  }, 90_000)

  it('a daemon program holding the dir is no other service (it is stopped and taken over, as before)', async () => {
    const read = async () => ({ uid: 1, dir: '/x', pid: 4242, instanceId: 'd-x', wsPort: 5555 })
    expect(await anotherServiceHolds('/x', read)).toBeNull()
    expect(await anotherServiceHolds('/x', async () => ({ ...(await read()), inProcess: true as const }))).toEqual({ pid: 4242 })
    // An older server's banner names no data dir: the pid alone, as before.
    expect(await anotherServiceHolds('/x', async () => ({ ...(await read()), pid: process.pid, inProcess: true as const }))).toBeNull()
  })

  it('the host shape: a service runtime says so in its banner and hello, names its pid, writes no launcher mark of its own, and a second service on its dirs is refused with why', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-host-'))
    roots.push(root)
    const env = holderEnv(root, { serviceHome: '/leader/home' })
    const launcher = env.WALNUT_LAUNCHER_DIR!
    const dir = env.WALNUT_DAEMON_DIR!
    const holder = await startHolder(env)
    const owner = await readDaemonInstanceOwner({ runtimeDir: dir, uid: os.userInfo().uid })
    expect(owner).toMatchObject({ pid: holder.pid, inProcess: true, service: true })
    expect(await anotherServiceHolds(dir)).toEqual({ pid: holder.pid, service: true, home: env.OPEN_WALNUT_HOME })
    expect(Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8'))).toBe(holder.pid)
    const door = await openDoor(doorPort(dir))
    const said = await door.call({ cmd: 'hello' })
    expect(said).toMatchObject({ ok: true, serves: 'walnut-serve', cronSupervision: { startup: 'service' } })
    // The server that holds it is the one writer of the launcher's marks: the runtime wrote none.
    await new Promise((r) => setTimeout(r, 300))
    expect(fs.readdirSync(launcher)).toEqual([])

    // A second service on the same dirs (what the server's boot asks, server.ts) is refused with
    // why, naming the first; the first is never stopped and its door answers as the same runtime.
    let stopped = false
    const second = ensureInProcessDaemon({
      dir, readPort: () => doorPort(dir), alive: async () => true,
      stopProgram: async () => { stopped = true }, env: async () => env, service: { home: '/leader/home' },
    })
    await expect(second).rejects.toBeInstanceOf(AnotherServiceError)
    await expect(second).rejects.toThrow(new RegExp(`^Another Walnut service \\(pid ${holder.pid}, data dir [^)]+\\) already runs the session daemon of ${dir}`))
    expect(stopped).toBe(false)
    expect(holder.child.exitCode).toBeNull()
    expect((await door.call({ cmd: 'hello' })).instanceId).toBe(said.instanceId)
    door.close()
    await holder.stop()
  }, 90_000)

  it('a host\'s one Walnut service (banner inProcess and service) is another service too: a second one is refused', async () => {
    const read = async () => ({ uid: 1, dir: '/x', pid: 4242, instanceId: 'd-x', wsPort: 5555, inProcess: true as const, service: true as const })
    expect(await anotherServiceHolds('/x', read)).toEqual({ pid: 4242, service: true })
    const second = ensureInProcessDaemon({
      dir: '/x', readPort: () => 5555, alive: async () => true, stopProgram: async () => { throw new Error('never stopped') },
      env: async () => ({}), otherService: () => anotherServiceHolds('/x', read), service: { home: '/leader' },
    })
    await expect(second).rejects.toBeInstanceOf(AnotherServiceError)
  })

  // The leader's own computer (task brief, 2026-11-25): with in_process_daemon on by default, a second
  // server under the same account that meets the first's daemon dir refuses to boot (server.ts). The
  // words say which server runs (pid, port, data dir) and the three ways on.
  it('the refusal names the running server by pid, port and data dir, and says what to do', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-words-'))
    roots.push(root)
    const home = path.join(root, '.open-walnut')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'server.lock.json'), JSON.stringify({ pid: 4242, port: 3456, startedAt: '2026-11-25T00:00:00.000Z' }))
    const read = async () => ({ uid: 1, dir: '/tmp/open-walnut', pid: 4242, instanceId: 'd-x', wsPort: null, inProcess: true as const, home })
    const other = await anotherServiceHolds('/tmp/open-walnut', read)
    expect(other).toEqual({ pid: 4242, home, port: 3456 })
    const err = new AnotherServiceError('/tmp/open-walnut', other!)
    expect(err.message).toBe(
      `Another Walnut server (pid 4242, port 3456, data dir ${home}) already runs the session daemon of /tmp/open-walnut in its own process: `
      + 'one Walnut server per daemon dir runs this computer\'s sessions. Use that one (http://localhost:3456), stop it first, '
      + 'or start this one with a data dir and a daemon dir of its own (OPEN_WALNUT_HOME and WALNUT_DAEMON_DIR, as a test or sandbox server does).')
    expect(err.pid).toBe(4242)
    // A lock that names another pid (a server since gone) gives no port; a banner with no data dir names the pid alone.
    fs.writeFileSync(path.join(home, 'server.lock.json'), JSON.stringify({ pid: 777, port: 3999, startedAt: 'x' }))
    expect(await anotherServiceHolds('/tmp/open-walnut', read)).toEqual({ pid: 4242, home })
    expect(new AnotherServiceError('/d', { pid: 9 }).message).toMatch(/^Another Walnut server \(pid 9\) already runs the session daemon of \/d in its own process: .* Use that one, stop it first, or start/)
    expect(new AnotherServiceError('/d', { pid: 9, service: true }).message).toMatch(/^Another Walnut service \(pid 9\)/)
  })

  // Review of the default flip: a refusal under a launchd KeepAlive job would loop as a held instance lock did.
  it('the server\'s boot removes its own launchd job on this refusal, as on a held instance lock', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/server.ts'), 'utf8')
    const at = src.indexOf('const refusal = new AnotherServiceError(')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 400)).toMatch(/removeOwnLaunchdJob\(refusal\.message\)[^]*throw refusal/)
  })

  // The sandbox on :3457 and dev:ephemeral never meet a running server's daemon dir: each gets a data
  // dir and a daemon dir of its own (ephemeral: tests/unit/ephemeral-snapshot.test.ts ephemeralChildEnv).
  it('the sandbox server starts on a daemon dir and a data dir of its own', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/walnut-sandbox.sh'), 'utf8')
    const launch = src.slice(src.indexOf('launch() {'), src.indexOf('dist/cli.js" web'))
    expect(launch).toContain('OPEN_WALNUT_HOME="$ROOT/.open-walnut"')
    expect(launch).toContain('WALNUT_DAEMON_DIR="$ROOT/daemon"')
    expect(launch).toMatch(/env -i \\\n\s+HOME="\$home_dir"/)
  })
})
