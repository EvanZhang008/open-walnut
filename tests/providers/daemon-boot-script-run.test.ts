/**
 * The cron boot supervisor script, EXECUTED by /bin/sh against a fake daemon:
 * restart on every exit, give up after a burst of failures, read a rewritten
 * script on the next restart (an update), stop on the stop file, one
 * supervisor at a time, and never hand its lock fd to the daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { renderDaemonBootScript } from '../../src/providers/daemon-service-boot-script.js'
import { guardedPath } from '../setup/exec-guard.js'

let dir: string
let bin: string
let state: string
let home: string
const children: ChildProcess[] = []

function fakeDaemon(name: string): string {
  const exe = path.join(dir, name)
  // Each run appends one line: its name, args, env and whether fd 9 is open, then exits with the next code queued.
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    `fd9=no; [ -e /proc/$$/fd/9 ] && fd9=yes`,
    `echo "${name} $* state=$WALNUT_DAEMON_STATE_DIR dir=$WALNUT_DAEMON_DIR sup=$WALNUT_DAEMON_SUPERVISOR home=$HOME fd9=$fd9" >> "${dir}/runs"`,
    // The test's own record of every process it leaves running, so it stops exactly those.
    `echo "${name} $$" >> "${dir}/pids"`,
    `code=$(head -n 1 "${dir}/codes" 2>/dev/null); sed -i '1d' "${dir}/codes" 2>/dev/null`,
    // No code queued: run until signalled (the real sleep: the supervisor's PATH shadows sleep with a short one).
    `[ -n "$code" ] || { /bin/sleep 30 & S=$!; echo "${name}-sleep $S" >> "${dir}/pids"; trap 'kill $S; exit 0' TERM; wait $S; code=0; }`,
    'exit "$code"',
    '',
  ].join('\n'), { mode: 0o700 })
  return exe
}

function writeScript(executable: string): string {
  const text = renderDaemonBootScript({
    platform: 'linux', home, executable, args: ['--service'], runtimeDir: path.join(dir, 'runtime'), stateDir: state,
    path: `${bin}:/usr/bin:/bin`,
  })
  const file = path.join(state, 'daemon-boot.sh')
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
  return file
}

/** The processes the fake daemons recorded, latest last; `name` keeps only that one's. */
function recorded(name?: string): Array<{ name: string; pid: number }> {
  const file = path.join(dir, 'pids')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
  return lines.map((l) => l.split(' ')).map(([n, pid]) => ({ name: n!, pid: Number(pid) }))
    .filter((r) => r.pid > 1 && (name === undefined || r.name === name))
}

/**
 * Signal a process this test recorded, only while that pid still runs what was
 * recorded (a pid is reused once its process is gone): the fake daemon's command
 * names this test's dir, its sleep is exactly `/bin/sleep 30`.
 */
function signalRecorded(r: { name: string; pid: number }, signal: NodeJS.Signals): void {
  let command = ''
  try { command = execFileSync('ps', ['-o', 'command=', '-p', String(r.pid)], { encoding: 'utf8' }).trim() } catch { return }
  const same = r.name.endsWith('-sleep') ? command === '/bin/sleep 30' : command.includes(dir)
  if (same) { try { process.kill(r.pid, signal) } catch { /* gone */ } }
}

function runs(): string[] {
  return fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8').trim().split('\n').filter(Boolean) : []
}

async function until(test: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out; runs: ${JSON.stringify(runs())}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function start(script: string): ChildProcess {
  const child = spawn('/bin/sh', [script], { stdio: 'ignore', env: { HOME: home, PATH: guardedPath([], '/usr/bin:/bin') } })
  children.push(child)
  return child
}

const exited = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once('exit', (code) => resolve(code)))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-run-'))
  bin = path.join(dir, 'bin')
  state = path.join(dir, 'state')
  home = path.join(dir, 'home')
  for (const d of [bin, state, home]) fs.mkdirSync(d, { mode: 0o700 })
  // The supervisor's own sleeps (1 s, 5 s) shortened so a test of five restarts takes a moment.
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.05\n', { mode: 0o700 })
})

afterEach(() => {
  fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
  for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch {} }
  for (const r of recorded()) signalRecorded(r, 'SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the cron boot supervisor script', () => {
  it('runs the daemon in the foreground with its environment, and restarts it after a clean exit', async () => {
    const exe = fakeDaemon('d1')
    fs.writeFileSync(path.join(dir, 'codes'), '0\n0\n')
    const child = start(writeScript(exe))
    await until(() => runs().length >= 3)
    const [first] = runs()
    expect(first).toContain('d1 --service')
    expect(first).toContain(`state=${state}`)
    expect(first).toContain(`dir=${path.join(dir, 'runtime')}`)
    expect(first).toContain('sup=cron')
    expect(first).toContain(`home=${home}`)
    expect(Number(fs.readFileSync(path.join(state, 'daemon-boot.pid'), 'utf8'))).toBe(child.pid)
  })

  it('never hands its lock fd to the daemon (a CLI the daemon starts would hold the lock)', async () => {
    const exe = fakeDaemon('d1')
    start(writeScript(exe))
    await until(() => runs().length >= 1)
    expect(runs()[0]).toContain('fd9=no')
  })

  it('reads the script again on each restart, so a rewritten EXEC is what the next run starts', async () => {
    const old = fakeDaemon('old')
    const next = fakeDaemon('new')
    fs.writeFileSync(path.join(dir, 'codes'), '1\n')
    const script = writeScript(old)
    start(script)
    await until(() => runs().length >= 1)
    writeScript(next)
    await until(() => runs().some((line) => line.startsWith('new ')))
    expect(runs()[0].startsWith('old ')).toBe(true)
  })

  it('gives up after five failures in a minute and says so', async () => {
    const exe = fakeDaemon('d1')
    fs.writeFileSync(path.join(dir, 'codes'), '3\n3\n3\n3\n3\n3\n3\n')
    const child = start(writeScript(exe))
    expect(await exited(child)).toBe(3)
    expect(runs()).toHaveLength(5)
    expect(fs.readFileSync(path.join(state, 'daemon-service.err.log'), 'utf8')).toContain('failed 5 times in 60s')
    expect(fs.existsSync(path.join(state, 'daemon-boot.pid'))).toBe(false)
  })

  it('stops on the stop file instead of restarting', async () => {
    const exe = fakeDaemon('d1')
    fs.writeFileSync(path.join(dir, 'codes'), '0\n')
    fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
    const child = start(writeScript(exe))
    expect(await exited(child)).toBe(0)
    expect(runs()).toHaveLength(0)
  })

  it('ends after the running daemon exits once the stop file is there', async () => {
    const exe = fakeDaemon('d1')
    fs.writeFileSync(path.join(dir, 'codes'), '')
    const child = start(writeScript(exe))
    await until(() => runs().length === 1)
    fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
    await until(() => recorded('d1-sleep').length === 1)
    signalRecorded(recorded('d1')[0]!, 'SIGTERM')
    expect(await exited(child)).toBe(0)
    expect(runs()).toHaveLength(1)
    expect(fs.existsSync(path.join(state, 'daemon-boot.pid'))).toBe(false)
  })

  it.skipIf(spawnSync('sh', ['-c', 'command -v flock']).status !== 0)('lets one supervisor run at a time', async () => {
    const exe = fakeDaemon('d1')
    const script = writeScript(exe)
    start(script)
    await until(() => runs().length === 1)
    const second = start(script)
    expect(await exited(second)).toBe(0)
    expect(runs()).toHaveLength(1)
  })
})
