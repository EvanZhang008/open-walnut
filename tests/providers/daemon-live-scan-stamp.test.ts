/**
 * The live-dir check (daemon-live-sh.ts w_daemon) run for real, under every shell the host may
 * have (dash, bash, the system sh): a daemon dir's daemon.pid is that dir's daemon only when the
 * dir's stamp (daemon-door.ts stampDoor: the pid and its start time) still matches the process, or,
 * with no stamp for that pid, when its command line is a daemon's of that dir.
 *
 * Review 2026-11-21 #4: a stale daemon.pid whose pid a `walnut serve` of another dir took over
 * counted as a live daemon, and every connect went to the dead daemon's port. The processes here
 * are this test's own children (a JS file that only waits), stopped by their own pid.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DAEMON_PID_SH } from '../../src/providers/daemon-live-sh.js'
import { DAEMON_STAMP_NAME, stampDoor } from '../../src/providers/daemon-door.js'
import { readProcStartTime } from '../../src/providers/daemon-core.js'
import { UP_LINE } from '../../src/providers/daemon-update-shell.js'
import { buildLiveDaemonScanScript, parseLiveDaemonScan } from '../../src/providers/remote-daemon-dir.js'

const run = promisify(execFile)

const shells = ['/bin/sh', '/usr/bin/dash', '/bin/dash', '/usr/bin/bash', '/bin/bash']
  .filter((s) => fs.existsSync(s))
  .filter((s, i, all) => all.findIndex((t) => fs.realpathSync(t) === fs.realpathSync(s)) === i)

let root = ''
let keepJs = ''
const children: ChildProcess[] = []

/** A process of ours that waits, with this command line after the runtime and its script. */
async function waiter(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [keepJs, ...args], { stdio: 'ignore' })
  children.push(child)
  const pid = child.pid
  if (!pid || pid <= 1) throw new Error('no child pid')
  // Its command line is the waiter's once the runtime is past exec (it reads /proc or ps).
  for (let i = 0; i < 100; i++) {
    const { stdout } = await run('/bin/sh', ['-c', `${DAEMON_PID_SH.join('\n')}\nw_args ${pid}`]).catch(() => ({ stdout: '' }))
    if (stdout.includes(keepJs)) return pid
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waiter ${pid} never showed its command line`)
}

function daemonDir(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The daemon's own stamp for `pid` (Linux at once; ps answers a moment later elsewhere). */
async function stamp(dir: string, pid: number): Promise<string> {
  const pidFile = path.join(dir, 'daemon.pid')
  const stampFile = path.join(dir, DAEMON_STAMP_NAME)
  fs.writeFileSync(pidFile, String(pid))
  stampDoor(fs, { pidFile, stampFile }, pid, { procStart: (p) => readProcStartTime(fs, p), execFile: execFile as never, env: process.env })
  for (let i = 0; i < 100 && !fs.existsSync(stampFile); i++) await new Promise((r) => setTimeout(r, 50))
  return fs.readFileSync(stampFile, 'utf8')
}

async function live(shell: string, pid: number, dir: string): Promise<string> {
  const script = `${DAEMON_PID_SH.join('\n')}\nif w_daemon ${pid} '${dir}'; then echo live; else echo dead; fi`
  return (await run(shell, ['-c', script])).stdout.trim()
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-live-stamp-'))
  keepJs = path.join(root, 'keep.js')
  fs.writeFileSync(keepJs, 'setInterval(() => {}, 1000)\n')
})

afterAll(() => {
  for (const child of children) if (child.pid && child.pid > 1 && child.exitCode === null) child.kill('SIGTERM')
  fs.rmSync(root, { recursive: true, force: true })
})

describe.each(shells)('w_daemon under %s', (shell) => {
  it('a walnut serve the dir stamped is live, whatever its command line', async () => {
    const dir = daemonDir(`stamped-${path.basename(shell)}`)
    const pid = await waiter(['serve', '--data', dir])
    expect(await stamp(dir, pid)).toMatch(new RegExp(`^${pid} \\S`))
    expect(await live(shell, pid, dir)).toBe('live')
  })

  it('a stale daemon.pid whose pid another dir\'s walnut serve took is not live', async () => {
    const other = daemonDir(`other-${path.basename(shell)}`)
    const pid = await waiter(['serve', '--data', other])
    const dir = daemonDir(`stale-${path.basename(shell)}`)
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(pid))
    expect(await live(shell, pid, dir), 'no stamp: its command line is no daemon of this dir').toBe('dead')
    // The dead daemon's own stamp names that pid with its start time, not this process's.
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid} 1`)
    expect(await live(shell, pid, dir), 'a stamp of another start time').toBe('dead')
  })

  it('a daemon from before the stamp is live by its command line', async () => {
    const dir = daemonDir(`old-${path.basename(shell)}`)
    const pid = await waiter([`${dir}/daemon-linux-x64`, '--start'])
    expect(await live(shell, pid, dir)).toBe('live')
    const service = await waiter(['/home/u/.local/share/open-walnut/versions/abc/daemon', '--service'])
    expect(await live(shell, service, dir), 'an OS service daemon').toBe('live')
    // A stamp an earlier daemon left for another pid does not speak for this one (a rollback).
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid + 100000} 1`)
    expect(await live(shell, pid, dir)).toBe('live')
  })

  it('a reused pid with the old command line but a stale stamp is not live', async () => {
    const dir = daemonDir(`reused-${path.basename(shell)}`)
    const pid = await waiter([`${dir}/daemon-linux-x64`, '--start'])
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid} 1`)
    expect(await live(shell, pid, dir)).toBe('dead')
    // Its own stamp makes it live again.
    await stamp(dir, pid)
    expect(await live(shell, pid, dir)).toBe('live')
  })

  // Review A3b S34-M1: a newer daemon's stamp stays behind, an older daemon (which never touches
  // the stamp) is put back and gets the same pid: its daemon.pid is newer than the stamp.
  it('a stamp older than daemon.pid is an earlier writer\'s: the command line decides', async () => {
    const dir = daemonDir(`older-${path.basename(shell)}`)
    const pid = await waiter([`${dir}/daemon-linux-x64`, '--start'])
    const stampFile = path.join(dir, DAEMON_STAMP_NAME)
    const pidFile = path.join(dir, 'daemon.pid')
    fs.writeFileSync(stampFile, `${pid} 1`)
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(stampFile, past, past)
    fs.writeFileSync(pidFile, String(pid))
    expect(await live(shell, pid, dir), 'the pre-stamp daemon on the stale stamp\'s pid').toBe('live')
    // Not live by a stale stamp either: a walnut serve is no daemon by its command line.
    const serve = await waiter(['serve', '--data', dir])
    await stamp(dir, serve)
    fs.utimesSync(stampFile, past, past)
    expect(await live(shell, serve, dir), 'an ignored stamp vouches for nothing').toBe('dead')
    // The same stamp with daemon.pid no newer still decides (the daemon writes the pid, then the stamp).
    fs.utimesSync(pidFile, past, past)
    expect(await live(shell, serve, dir)).toBe('live')
  })

  // Review A3b S34-L4: ticks since boot repeat in a later boot; the Linux stamp carries the boot id.
  it.runIf(fs.existsSync('/proc/sys/kernel/random/boot_id'))('a stamp of the same start tick in another boot is not live', async () => {
    const dir = daemonDir(`boot-${path.basename(shell)}`)
    const pid = await waiter([`${dir}/daemon-linux-x64`, '--start'])
    const text = await stamp(dir, pid)
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    expect(text).toBe(`${pid} ${readProcStartTime(fs, pid)} ${boot}`)
    expect(await live(shell, pid, dir)).toBe('live')
    const other = boot.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0'))
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid} ${readProcStartTime(fs, pid)} ${other}`)
    expect(await live(shell, pid, dir), 'its command line is a daemon\'s, but the stamp of another boot decides').toBe('dead')
  })
})

describe('the scripts that read a daemon dir use the stamp', () => {
  it('the leader\'s live-dir scan finds a stamped walnut serve and skips a stale pid', async () => {
    const dir = daemonDir('scan')
    const pid = await waiter(['serve'])
    await stamp(dir, pid)
    fs.writeFileSync(path.join(dir, 'daemon.port'), '4242')
    for (const shell of shells) {
      const found = parseLiveDaemonScan((await run(shell, ['-c', buildLiveDaemonScanScript([dir])])).stdout, [dir])
      expect(found, shell).toMatchObject({ dir, pid, port: 4242 })
    }
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid} 1`)
    for (const shell of shells) {
      const output = (await run(shell, ['-c', buildLiveDaemonScanScript([dir])])).stdout
      expect(output, shell).toContain('walnut-live none')
    }
  })

  it('the update scripts\' t_up takes the stamp first', async () => {
    const dir = daemonDir('up')
    const pid = await waiter(['serve'])
    await stamp(dir, pid)
    fs.writeFileSync(path.join(dir, 'daemon.port'), '4242')
    const up = (shell: string) => run(shell, ['-c', `tr='${dir}'\n${UP_LINE}\nif t_up; then echo up; else echo down; fi`]).then((r) => r.stdout.trim())
    for (const shell of shells) expect(await up(shell), shell).toBe('up')
    fs.writeFileSync(path.join(dir, DAEMON_STAMP_NAME), `${pid} 1`)
    for (const shell of shells) expect(await up(shell), shell).toBe('down')
  })
})
