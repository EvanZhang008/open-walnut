/**
 * A machine that leads as its one Walnut service (src/binary/service-entry.ts runLeaderService), end
 * to end in real processes: the launcher's `--service` start (fixtures/one-service-runner.ts, the
 * calls main.ts makes) on a mode written by setServiceRole({ role: 'leader' }):
 *   1. it boots as the leader server on that home: the launcher's ready mark names its pid as the
 *      Walnut server, GET /api/config answers, the runtime in its process answers hello on its door,
 *      the follower child an older daemon started from this Walnut's spec is stopped first (its pid
 *      file goes: service-entry.ts stopOldFollowers), and that spec is not started again
 *      (host-server-core.ts leads);
 *   2. a session starts on a fake CLI through that runtime and answers once;
 *   3. SIGTERM is the server's planned stop: well inside the launcher's 60 s, with the leaving mark;
 *      the same file started again leads again and the session is still the same process;
 *   4. not ready in time (a ready deadline of 1 s, shorter than a real boot): the fallback marker,
 *      the planned stop, and the next start runs the session daemon only; an idempotent setServiceRole
 *      keeps the marker (a hook calls it every start), a real mode write clears it, and it leads again;
 *   5. a home that handed the leader over (its hand-over marker) boots as the standby, which counts as
 *      ready: the ready mark names it, the standby answers /api/config, the machine's sessions keep
 *      their runtime (an older session alive, a new one answers once), no fallback marker past the
 *      ready deadline, and SIGTERM is still the planned stop (standby-service.ts).
 * MACHINE SAFETY: one temp root (HOME, data, daemon, state, streams); the only processes signalled
 * are the runners this test spawned and the fake CLI its own service started (by the pid it reported).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { alive, doorPort, fakeStreamCli, openDoor, until } from '../helpers/service-holder.js'
import { readServiceMode, readServiceRoleFallback, setServiceRole, SERVICE_ROLE_FALLBACK_FILE } from '../../src/binary/service-mode.js'
import { removeMarker, writeMarker } from '../../src/core/leader/switch/records.js'
import { defaultReadStartTime } from '../../src/providers/daemon-core.js'

const RUNNER = path.resolve(__dirname, 'fixtures/one-service-runner.ts')
const BUN = process.versions.bun ? process.execPath : null
/** The leader this machine followed before it was promoted, and the Walnut both are. */
const OLD_LEADER = '/old-leader-of-test/walnut-home'
const WALNUT = 'w-lead'
const FOLLOWER_MARK = 'follower-of-w-lead-must-not-run'
const roots: string[] = []
const spawned: ChildProcess[] = []
const strays: number[] = []
afterAll(async () => {
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null && c.pid && c.pid > 1) { try { process.kill(c.pid, 'SIGKILL') } catch { /* gone */ } }
  for (const pid of strays) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

interface Run { child: ChildProcess; out: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

function start(env: NodeJS.ProcessEnv): Run {
  const child = spawn(BUN!, [RUNNER, '--service'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(child)
  let out = ''
  child.stdout!.on('data', (c) => { out += c })
  child.stderr!.on('data', (c) => { out += c })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })))
  return { child, out: () => out, exited }
}

const readOr = (file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
const tail = (run: Run) => run.out().split('\n').slice(-60).join('\n')

describe.skipIf(!BUN || process.platform !== 'linux')('a machine that leads as its one Walnut service', () => {
  it('boots as the leader, runs a session, stops the planned way, and falls back to the daemon when not ready in time', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-lead-')))
    roots.push(root)
    const p = (n: string) => path.join(root, n)
    const home = p('home'), data = p('data'), state = p('s'), daemonDir = p('d'), launcher = path.join(state, 'launcher'), streams = p('streams')
    for (const d of [home, data, path.join(state, 'host-server'), launcher, streams]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    // The launcher's state names the version it runs (this bun running the entry): setServiceRole names it in the mode.
    fs.writeFileSync(path.join(launcher, 'state'), `current=${BUN}\ngood=${BUN}\nphase=committed\nsince=1\n`)
    // The follower this machine ran of the same Walnut before the promotion: its spec stays on disk.
    const followerPort = await freePort()
    const spec = {
      v: 1, home: OLD_LEADER, walnutId: WALNUT, command: BUN, args: ['-e', `/* ${FOLLOWER_MARK} */ setInterval(() => {}, 1000)`],
      cwd: p('follower-data'), log: p('follower.log'), port: followerPort, settings: {},
      env: {
        OPEN_WALNUT_HOME: p('follower-data'), WALNUT_DAEMON_DIR: p('follower-run'), WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(followerPort),
        WALNUT_LEADER_HOME: OLD_LEADER, WALNUT_WALNUT_ID: WALNUT, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'test-host',
      },
    }
    const specFile = path.join(state, 'host-server', 'server-00112233aabbccdd.json')
    fs.writeFileSync(specFile, JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
    // The follower child the older daemon started from that spec still runs (it survives its daemon by
    // design): this test's own detached sleep, recorded in the spec's pid file as the supervisor does.
    const oldFollower = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    spawned.push(oldFollower)
    const oldFollowerGone = new Promise((r) => oldFollower.once('exit', r))
    const followerPidFile = specFile.replace(/\.json$/, '.pid')
    fs.writeFileSync(followerPidFile, JSON.stringify({ pid: oldFollower.pid, startTime: defaultReadStartTime(fs, oldFollower.pid!) }))
    expect(setServiceRole(state, { role: 'leader', home: data, walnutId: WALNUT })).toEqual({ previous: null, changed: true })

    const leadPort = await freePort()
    // A leader server asks `claude --version` at boot: a stand-in answers it, ahead of the exec guard.
    const fakeBin = p('bin')
    fs.mkdirSync(fakeBin)
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo "2.1.0 (Claude Code)"; exit 0; }\nexit 1\n', { mode: 0o755 })
    const env: NodeJS.ProcessEnv = {
      HOME: home, WALNUT_HOME_OVERRIDE: home, PATH: guardedPath([fakeBin], '/usr/bin:/bin'), SHELL: '/bin/sh', LANG: 'C',
      WALNUT_DAEMON_DIR: daemonDir, WALNUT_DAEMON_STATE_DIR: state, WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: launcher,
      WALNUT_STREAMS_DIR: streams, WALNUT_LEGACY_STREAMS_DIR: p('no-legacy'), WALNUT_SPAWN_JOURNAL: p('spawn-journal.jsonl'),
      WALNUT_JOURNAL_DIR: p('j'), WALNUT_TASK_DIR_ROOT: p('t'), TMPDIR: os.tmpdir(), WALNUT_NET_NO_DOWNLOAD: '1',
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      WALNUT_SERVICE_LEAD_PORT: String(leadPort),
    }
    const readyFile = path.join(launcher, 'ready')
    /** The ready mark, once it names `run`'s pid as the Walnut server. */
    const readyOf = (run: Run) => until(`the ready mark of ${run.child.pid}`, () => {
      if (run.child.exitCode !== null) throw new Error(`the service exited ${run.child.exitCode} before it was ready\n${tail(run)}`)
      const text = readOr(readyFile)
      return text.split('\n').includes(`pid=${run.child.pid}`) ? text : null
    }, 120_000).catch((err) => { throw new Error(`${(err as Error).message}\n${tail(run)}`) })

    // 1. It boots as the leader on that home.
    const first = start(env)
    const ready = await readyOf(first)
    expect(ready).toContain('serves=walnut-serve')
    const config = await fetch(`http://127.0.0.1:${leadPort}/api/config`)
    expect(config.status).toBe(200)
    expect(typeof await config.json()).toBe('object')
    expect(Number(readOr(path.join(daemonDir, 'daemon.pid')))).toBe(first.child.pid)
    const door = await openDoor(doorPort(daemonDir))
    const said = await door.call({ cmd: 'hello' })
    // From source the program is no compiled Walnut file: its list is present, and empty (service-roles.ts).
    expect(said).toMatchObject({ ok: true, serves: 'walnut-serve', serviceRoles: [], cronSupervision: { managed: true, startup: 'service' } })
    // The older daemon's follower was stopped before the leader served, and its pid file went.
    await oldFollowerGone
    expect(first.out()).toContain('the follower an older daemon started was stopped')
    // The follower of the Walnut it leads is not started again: the supervisor says so, no pid file, no such process.
    const daemonLog = () => fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n)).map((n) => readOr(path.join(daemonDir, n))).join('\n')
    await until('the supervisor to skip the follower', () => daemonLog().includes('this machine leads this Walnut; its follower is not started'), 20_000)
    expect(fs.existsSync(specFile.replace(/\.json$/, '.pid'))).toBe(false)
    const running = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => readOr(`/proc/${n}/cmdline`).includes(FOLLOWER_MARK))
    expect(running).toEqual([])

    // 2. A session through that runtime answers once.
    const cli = fakeStreamCli(root)
    const work = p('work')
    fs.mkdirSync(work)
    const SID = 'cccccccc-0000-4000-8000-0000000000c1'
    const args = [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', SID]
    const started = await door.call({ cmd: 'start', sid: SID, cwd: work, message: 'hello', mode: 'default', args })
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true })
    const cliPid = Number(started.pid)
    strays.push(cliPid)
    const results = () => readOr(path.join(streams, `${SID}.jsonl`)).split('\n').filter((l) => l.includes('"type":"result"')).length
    await until('the session\'s answer', () => results() >= 1, 30_000)
    door.close()
    expect(results()).toBe(1)

    // 3. SIGTERM: the planned stop, well inside the launcher's 60 s, with the leaving mark.
    const t0 = Date.now()
    first.child.kill('SIGTERM')
    const end = await first.exited
    expect(Date.now() - t0).toBeLessThan(30_000)
    expect(end, tail(first)).toEqual({ code: 0, signal: null })
    expect(readOr(path.join(launcher, 'leaving'))).toContain(`pid=${first.child.pid}`)
    expect(alive(cliPid)).toBe(true)
    // The same file again (the launcher's restart): it leads again and keeps the session.
    fs.rmSync(path.join(launcher, 'leaving'), { force: true })
    const second = start(env)
    await readyOf(second)
    const door2 = await openDoor(doorPort(daemonDir))
    expect(await door2.call({ cmd: 'status', sid: SID })).toMatchObject({ ok: true, exists: true, alive: true, pid: cliPid })
    door2.close()
    expect((await fetch(`http://127.0.0.1:${leadPort}/api/config`)).status).toBe(200)
    second.child.kill('SIGTERM')
    expect((await second.exited).code).toBe(0)

    // 4. Not ready in time: a deadline of 1 s, shorter than the boot of a real leader server.
    const late = start({ ...env, WALNUT_SERVICE_LEAD_READY_SECONDS: '1' })
    const lateEnd = await Promise.race([late.exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))])
    expect(lateEnd, `the late leader did not stop\n${tail(late)}`).not.toBeNull()
    expect(late.out()).toMatch(/was not ready within 1 s/)
    // The planned stop: the server's SIGTERM handler (exit 0), or SIGTERM itself when it came before the server had one.
    expect([{ code: 0, signal: null }, { code: null, signal: 'SIGTERM' }]).toContainEqual(lateEnd)
    expect(readOr(readyFile).split('\n')).not.toContain(`pid=${late.child.pid}`)
    expect(readServiceRoleFallback(state)).toMatchObject({ role: 'leader', home: data, exe: BUN })
    // The mode itself is untouched.
    expect(readServiceMode(state)).toMatchObject({ mode: { role: 'leader', home: data, exe: BUN, walnutId: WALNUT } })
    // The next start runs the session daemon only.
    const asDaemon = start({ ...env, WALNUT_TEST_SERVICE_DAEMON: '1' })
    await until('the daemon to listen', async () => {
      if (asDaemon.child.exitCode !== null) throw new Error(`the daemon exited ${asDaemon.child.exitCode}\n${tail(asDaemon)}`)
      if (Number(readOr(path.join(daemonDir, 'daemon.pid'))) !== asDaemon.child.pid) return false
      const d = await openDoor(doorPort(daemonDir)).catch(() => null)
      if (!d) return false
      const h = await d.call({ cmd: 'hello' }).catch(() => null)
      d.close()
      return h?.ok === true && h.serves === 'daemon'
    }, 60_000)
    expect(asDaemon.out()).toContain('running as the session daemon (the leader role did not get ready in time')
    await expect(fetch(`http://127.0.0.1:${leadPort}/api/config`)).rejects.toThrow()
    asDaemon.child.kill('SIGTERM')
    await asDaemon.exited

    // The switch's hook calls setServiceRole on every start: the same role and home write nothing and keep the marker,
    // or a role that cannot get ready would be tried again on every start. A real mode write is the next try.
    expect(setServiceRole(state, { role: 'leader', home: data, walnutId: WALNUT }).changed).toBe(false)
    expect(fs.existsSync(path.join(state, SERVICE_ROLE_FALLBACK_FILE))).toBe(true)
    expect(setServiceRole(state, { role: 'replica', home: OLD_LEADER, walnutId: WALNUT }).changed).toBe(true)
    expect(fs.existsSync(path.join(state, SERVICE_ROLE_FALLBACK_FILE))).toBe(false)
    expect(setServiceRole(state, { role: 'leader', home: data, walnutId: WALNUT }).changed).toBe(true)
    const again = start(env)
    await readyOf(again)
    expect((await fetch(`http://127.0.0.1:${leadPort}/api/config`)).status).toBe(200)
    again.child.kill('SIGTERM')
    expect((await again.exited).code).toBe(0)

    // 5. The home handed the leader over: the leading service boots as the standby, which is ready.
    fs.rmSync(path.join(launcher, 'leaving'), { force: true })
    writeMarker(data, { switchId: 's-test', to: 'other-machine', state: 'handed-over', at: new Date().toISOString() })
    const READY_SECONDS = 15
    const standby = start({ ...env, WALNUT_SERVICE_LEAD_READY_SECONDS: String(READY_SECONDS) })
    const bootedAt = Date.now()
    expect(await readyOf(standby)).toContain('serves=walnut-serve')
    const standbyConfig = await fetch(`http://127.0.0.1:${leadPort}/api/config`)
    expect(standbyConfig.status).toBe(200)
    expect(await standbyConfig.json()).toMatchObject({ standby: true })
    const door3 = await openDoor(doorPort(daemonDir))
    expect(await door3.call({ cmd: 'hello' })).toMatchObject({ ok: true, serves: 'walnut-serve' })
    // The older session is still the same process, and a new one answers once through the standby's runtime.
    expect(await door3.call({ cmd: 'status', sid: SID })).toMatchObject({ ok: true, exists: true, alive: true, pid: cliPid })
    const SID2 = 'cccccccc-0000-4000-8000-0000000000c2'
    const args2 = [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', SID2]
    const started2 = await door3.call({ cmd: 'start', sid: SID2, cwd: work, message: 'hello', mode: 'default', args: args2 })
    expect(started2, JSON.stringify(started2)).toMatchObject({ ok: true })
    strays.push(Number(started2.pid))
    const results2 = () => readOr(path.join(streams, `${SID2}.jsonl`)).split('\n').filter((l) => l.includes('"type":"result"')).length
    await until('the standby session\'s answer', () => results2() >= 1, 30_000)
    expect(results2()).toBe(1)
    door3.close()
    // Past the ready deadline: no fallback marker, and the standby still serves.
    await until('the ready deadline to pass', () => {
      if (standby.child.exitCode !== null || standby.child.signalCode !== null) throw new Error(`the standby ended\n${tail(standby)}`)
      if (fs.existsSync(path.join(state, SERVICE_ROLE_FALLBACK_FILE))) throw new Error(`the standby wrote the fallback marker\n${tail(standby)}`)
      return Date.now() - bootedAt > (READY_SECONDS + 5) * 1000
    }, (READY_SECONDS + 30) * 1000)
    expect(standby.out()).not.toMatch(/was not ready within/)
    expect((await fetch(`http://127.0.0.1:${leadPort}/api/config`)).status).toBe(200)
    // SIGTERM: the planned stop with the leaving mark; the sessions outlive it.
    standby.child.kill('SIGTERM')
    expect(await standby.exited, tail(standby)).toEqual({ code: 0, signal: null })
    expect(readOr(path.join(launcher, 'leaving'))).toContain(`pid=${standby.child.pid}`)
    expect(alive(cliPid)).toBe(true)
    removeMarker(data)
  }, 600_000)
})
