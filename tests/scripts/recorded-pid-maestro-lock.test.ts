/**
 * scripts/lib/recorded-pid.sh, scripts/lib/maestro-lock.sh and the ownership checks of
 * scripts/pw-cleanup.sh, run for real on stub processes this test starts itself (a
 * `sleep`, a bun script), in a temp dir. Nothing is signalled but a pid this test
 * recorded, the lock is a temp path (WALNUT_MAESTRO_LOCK), never the machine's
 * /tmp/maestro-ios.lock, and pw-cleanup's run records are a temp dir (PW_RUNS_DIR).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard-core.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const PID_HELPER = path.join(REPO, 'scripts/lib/recorded-pid.sh')
const LOCK_HELPER = path.join(REPO, 'scripts/lib/maestro-lock.sh')
const PW_CLEANUP = path.join(REPO, 'scripts/pw-cleanup.sh')

let dir: string
let lock: string
const started: ChildProcess[] = []
/** Reparented stubs, stopped by the pid they were started with while it still runs their script. */
const orphans: Array<{ pid: number; exe: string }> = []

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A stub process this test owns; its pid is the only one any case may signal. */
function stub(): number {
  const c = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  started.push(c)
  return c.pid!
}

function bash(script: string, extra: Record<string, string> = {}) {
  const r = spawnSync('/bin/bash', ['-c', script], {
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: dir, WALNUT_MAESTRO_LOCK: lock, WALNUT_MAESTRO_LOCK_POLL: '1', ...extra },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

/** A process's start time the way recorded-pid.sh writes it. */
function lstart(pid: number): string {
  return spawnSync('/bin/sh', ['-c', `ps -o lstart= -p ${pid} | awk '{ $1 = $1; print }'`], { encoding: 'utf8' }).stdout.trim()
}

async function gone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-lock-'))
  lock = path.join(dir, 'maestro-ios.lock')
})
afterEach(() => {
  for (const c of started.splice(0)) if (c.pid && alive(c.pid)) c.kill('SIGKILL')
  for (const o of orphans.splice(0)) {
    const command = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(o.pid)], { encoding: 'utf8' }).stdout ?? ''
    if (o.pid > 1 && command.includes(o.exe)) process.kill(o.pid, 'SIGKILL')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('recorded-pid.sh', () => {
  it('stops the recorded process, waits for it, and removes the record', async () => {
    const pid = stub()
    const file = path.join(dir, 'server.pid')
    fs.writeFileSync(file, `${pid}\n`)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(await gone(pid)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('leaves a live process alone when the recorded pid no longer runs the marker', () => {
    const pid = stub()
    const file = path.join(dir, 'server.pid')
    fs.writeFileSync(file, `${pid}\n`)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} mock-server.mjs; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(alive(pid)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each([['an empty file', ''], ['a dead pid', 'DEAD'], ['junk', 'not-a-pid'], ['pid 1', '1']])('does nothing for %s', (_label, value) => {
    const file = path.join(dir, 'server.pid')
    const dead = spawnSync('/usr/bin/true').pid!
    fs.writeFileSync(file, value === 'DEAD' ? `${dead}\n` : value)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('leaves a live process alone when the recorded start time is not its own (a reused pid)', () => {
    const pid = stub()
    const file = path.join(dir, 'server.pid')
    fs.writeFileSync(file, `${pid}\nMon Jan 1 00:00:00 2001\n`)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(alive(pid)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('records the start time beside the pid, and still stops that same process', async () => {
    const pid = stub()
    const file = path.join(dir, 'server.pid')
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_record ${JSON.stringify(file)} ${pid}; sed -n 2p ${JSON.stringify(file)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out.split('\n')[0]).toMatch(/\d{4}$/)
    expect(r.out).toContain('rc=0')
    expect(await gone(pid)).toBe(true)
  })

  it('leaves a process alone, and keeps its record, while the run that recorded it is still going', () => {
    const pid = stub()
    const owner = stub()
    const file = path.join(dir, 'server.pid')
    fs.writeFileSync(file, `${pid}\n${lstart(pid)}\n${owner}\n${lstart(owner)}\n`)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(r.err).toContain(`run of pid ${owner}, which is still going`)
    expect(alive(pid)).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('records its own run beside the pid, and stops the process once that run is gone', async () => {
    const file = path.join(dir, 'server.pid')
    const own = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_record ${JSON.stringify(file)} ${stub()}; echo me=$$; sed -n 3p ${JSON.stringify(file)}`)
    expect(own.out.split('\n')[1]).toBe(own.out.match(/me=(\d+)/)![1])
    const pid = stub()
    const dead = spawnSync('/usr/bin/true').pid!
    fs.writeFileSync(file, `${pid}\n${lstart(pid)}\n${dead}\nMon Jan 1 00:00:00 2001\n`)
    const r = bash(`. ${JSON.stringify(PID_HELPER)}; walnut_pid_stop_recorded ${JSON.stringify(file)} sleep; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(await gone(pid)).toBe(true)
  })

  it('never aborts an EXIT trap under set -e when the child already exited with an error', () => {
    const r = bash(`set -e; . ${JSON.stringify(PID_HELPER)}
/usr/bin/false &
P=$!
/bin/sleep 0.3
trap 'walnut_pid_stop_child "$P"; echo trap-done' EXIT
exit 0`)
    expect(r.status).toBe(0)
    expect(r.out).toContain('trap-done')
  })

  it('gives up on a child that ignores SIGTERM after about 5 s of wall clock', async () => {
    const t0 = Date.now()
    const r = bash(`. ${JSON.stringify(PID_HELPER)}
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 1; done' >/dev/null 2>&1 &
P=$!
echo child=$P
/bin/sleep 0.3
walnut_pid_stop_child "$P"; echo stop=$?`)
    const pid = Number(r.out.match(/child=(\d+)/)?.[1])
    try {
      expect(r.out).toContain('stop=1')
      expect(r.err).toContain('did not exit after SIGTERM')
      expect(Date.now() - t0).toBeLessThan(9000)
    } finally {
      // The test's own child, by the pid it printed.
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    expect(await gone(pid)).toBe(true)
  })

  it('stops a child the shell started and records, and is safe with an empty or dead pid', () => {
    const file = path.join(dir, 'child.pid')
    const r = bash(`. ${JSON.stringify(PID_HELPER)}
/bin/sleep 300 &
P=$!
walnut_pid_record ${JSON.stringify(file)} "$P"
echo recorded=$(cat ${JSON.stringify(file)})
walnut_pid_stop_child "$P"; echo stop=$?
kill -0 "$P" 2>/dev/null && echo still-alive || echo gone
walnut_pid_stop_child ""; echo empty=$?
walnut_pid_stop_child "$P"; echo again=$?`)
    const pid = Number(r.out.match(/recorded=(\d+)/)?.[1])
    expect(pid).toBeGreaterThan(1)
    expect(r.out).toContain('stop=0')
    expect(r.out).toContain('gone')
    expect(r.out).toContain('empty=0')
    expect(r.out).toContain('again=0')
    expect(alive(pid)).toBe(false)
  })
})

describe('maestro-lock.sh', () => {
  const take = (max = 1) => `. ${JSON.stringify(LOCK_HELPER)}; walnut_maestro_lock_acquire ${max}; echo rc=$? pid=$$`

  it('takes a free lock and writes its own pid', () => {
    const r = bash(take())
    const pid = r.out.match(/rc=0 pid=(\d+)/)?.[1]
    expect(pid).toBeTruthy()
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()).toBe(pid)
  })

  it('waits on, and never removes, a lock whose holder is alive', () => {
    const holder = stub()
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${holder}\n`)
    const r = bash(take(1))
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain(`held by pid ${holder}`)
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()).toBe(String(holder))
  })

  it('takes over a lock whose holder is dead', () => {
    const dead = spawnSync('/usr/bin/true').pid!
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${dead}\n`)
    const r = bash(take())
    expect(r.out).toMatch(/rc=0 pid=\d+/)
    expect(r.err).toContain(`holder ${dead} is gone`)
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()).toBe(r.out.match(/pid=(\d+)/)![1])
  })

  it('treats a lock with no pid yet as held for 60 s, and as stale after', () => {
    fs.mkdirSync(lock)
    expect(bash(take(1)).out).toContain('rc=1')
    expect(fs.existsSync(lock)).toBe(true)
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lock, old, old)
    const r = bash(take())
    expect(r.out).toMatch(/rc=0 pid=\d+/)
    expect(r.err).toContain('none recorded')
  })

  it('never removes a stale directory that holds more than a pid file, and says so at once', () => {
    fs.mkdirSync(path.join(lock, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(lock, 'notes.txt'), 'keep me\n')
    fs.writeFileSync(path.join(lock, 'sub', 'inner.txt'), 'and me\n')
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lock, old, old)
    const t0 = Date.now()
    const r = bash(take(3))
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain('holds more than a pid file')
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(fs.readFileSync(path.join(lock, 'notes.txt'), 'utf8')).toBe('keep me\n')
    expect(fs.readFileSync(path.join(lock, 'sub', 'inner.txt'), 'utf8')).toBe('and me\n')
  })

  it('never removes one whose holder is dead either, when it holds other files', () => {
    const dead = spawnSync('/usr/bin/true').pid!
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), `${dead}\n`)
    fs.writeFileSync(path.join(lock, 'notes.txt'), 'keep me\n')
    const r = bash(take(3))
    expect(r.out).toContain('rc=1')
    expect(fs.readFileSync(path.join(lock, 'notes.txt'), 'utf8')).toBe('keep me\n')
    expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()).toBe(String(dead))
  })

  it.each([
    ['the lock path is a regular file', 'file', 'is not a directory'],
    ['the lock directory has no parent', 'parent', 'does not exist'],
  ])('fails at once, without spinning, when %s', (_label, shape, says) => {
    let at = lock
    if (shape === 'file') fs.writeFileSync(lock, 'not a lock\n')
    else at = path.join(dir, 'missing', 'maestro-ios.lock')
    const t0 = Date.now()
    const r = bash(take(3), { WALNUT_MAESTRO_LOCK: at })
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain(says)
    expect(Date.now() - t0).toBeLessThan(4000)
    if (shape === 'file') expect(fs.readFileSync(lock, 'utf8')).toBe('not a lock\n')
  })

  it('counts every wait toward the limit: a held lock gives up after max seconds', () => {
    const holder = stub()
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${holder}\n`)
    const t0 = Date.now()
    const r = bash(take(3))
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain('gave up after 3s')
    expect(Date.now() - t0).toBeLessThan(8000)
  })

  it('refuses a poll interval that is not whole seconds', () => {
    const r = bash(take(3), { WALNUT_MAESTRO_LOCK_POLL: '0.5' })
    expect(r.out).toContain('rc=1')
    expect(r.err).toContain('whole number of seconds')
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('release removes only its own lock', () => {
    const other = stub()
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${other}\n`)
    const r = bash(`. ${JSON.stringify(LOCK_HELPER)}; walnut_maestro_lock_release; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(r.err).toContain('not this run')
    expect(fs.existsSync(lock)).toBe(true)
    fs.rmSync(lock, { recursive: true })
    const own = bash(`. ${JSON.stringify(LOCK_HELPER)}; walnut_maestro_lock_acquire 1 && walnut_maestro_lock_release; [ -d ${JSON.stringify(lock)} ] && echo kept || echo removed`)
    expect(own.out).toContain('removed')
  })

  it('release keeps its own lock directory when something else was put in it', () => {
    const r = bash(`. ${JSON.stringify(LOCK_HELPER)}; walnut_maestro_lock_acquire 1 && echo x > ${JSON.stringify(path.join(lock, 'notes.txt'))} && walnut_maestro_lock_release; echo rc=$?`)
    expect(r.out).toContain('rc=0')
    expect(r.err).toContain('holds files other than its pid')
    expect(fs.existsSync(path.join(lock, 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(lock, 'pid'))).toBe(false)
  })
})

describe('pw-cleanup.sh reaps only what this repo recorded', () => {
  /** A stand-in browser: a bun script whose path looks like Playwright's Chromium. */
  function fakeBrowser(token?: string): number {
    const exe = path.join(dir, 'ms-playwright', 'chromium-0000', 'fake-browser.js')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, 'setTimeout(() => {}, 300_000)\n')
    const env: Record<string, string> = { PATH: guardedPath([], '/usr/bin:/bin') }
    if (token) env.WALNUT_PW_RUN = token
    // Started through a shell that exits at once, so it is reparented like a browser
    // whose run died (the live-run walk up its parents then finds nothing).
    const r = spawnSync('/bin/sh', ['-c', '"$0" "$1" >/dev/null 2>&1 & echo $!', process.execPath, exe], { env, encoding: 'utf8' })
    const pid = Number(r.stdout.trim())
    orphans.push({ pid, exe })
    return pid
  }

  const runs = () => path.join(dir, 'runs')
  const source = (body: string) => bash(`. ${JSON.stringify(PW_CLEANUP)}\n${body}`, { PW_RUNS_DIR: runs(), TMPDIR: dir })

  it('reaps a browser of a recorded run that is gone, and leaves a live run\'s, an unrecorded token and an unmarked one alone', async () => {
    fs.mkdirSync(runs())
    const dead = spawnSync('/usr/bin/true').pid!
    const runner = stub()
    fs.writeFileSync(path.join(runs(), 'gone-1'), `${dead}\n`)
    fs.writeFileSync(path.join(runs(), 'live-1'), `${runner}\n`)
    const owned = fakeBrowser('gone-1')
    const live = fakeBrowser('live-1')
    const unrecorded = fakeBrowser('nobody-1')
    const unmarked = fakeBrowser()
    await new Promise((r) => setTimeout(r, 400))

    const owners = source(`for p in ${owned} ${live} ${unrecorded} ${unmarked}; do echo "$p=$(browser_owner "$p")"; done`)
    expect(owners.out).toContain(`${owned}=owned`)
    expect(owners.out).toContain(`${live}=live`)
    expect(owners.out).toContain(`${unrecorded}=foreign`)
    expect(owners.out).toContain(`${unmarked}=foreign`)

    const r = source('reap_browsers')
    expect(r.out).toMatch(/reaped [1-9]\d* of this repo's/)
    expect(r.out).toContain('left alone')
    expect(await gone(owned)).toBe(true)
    for (const pid of [live, unrecorded, unmarked]) expect(alive(pid)).toBe(true)
  })

  it('names the fixture servers by the pids they recorded in their homes', () => {
    fs.mkdirSync(path.join(dir, 'walnut-pw-1'))
    fs.writeFileSync(path.join(dir, 'walnut-pw-1', 'owner.pid'), '424242\n')
    expect(source('fixture_owner_pids').out.split('\n')).toContain('424242')
  })
})
