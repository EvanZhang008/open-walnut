/**
 * The service launcher (src/providers/service-launcher-script.ts), EXECUTED by dash and by bash in
 * POSIX mode against a stub service whose behaviour each test sets (ready or not, crashing, a
 * stalled heartbeat, busy): restarts, the stall check, trial, commit, probation, rollback, the
 * day's refusal, a switch cut off half way, a launcher killed and back, two launchers, and the
 * registry's stop script on a put-back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { renderLauncherScript } from '../../src/providers/service-launcher-script.js'
import { guardedPath } from '../setup/exec-guard.js'

const SHELLS = [['dash', '/bin/dash'], ['bash --posix', '/bin/bash']].filter(([, bin]) => fs.existsSync(bin!))
const CLOCKS = { stall: 2, trial: 3, probation: 5, tick: 0.2, stopWait: 3 }

let dir: string
let state: string
let home: string
let L: string
const children: ChildProcess[] = []

/** A stub service: its mode file (good, noready, fail, crash:N, quit:N, leave:N, beat:S, hang, hangterm) is read on every loop. */
function stub(name: string, mode = 'good'): string {
  const exe = path.join(dir, name)
  fs.writeFileSync(path.join(dir, `${name}.mode`), `${mode}\n`)
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    `d='${dir}'; n='${name}'`,
    'echo "$n $$" >> "$d/pids"; echo "$n $$ $*" >> "$d/runs"',
    'm=$(cat "$d/$n.mode")',
    'case $m in fail) exit 1;; hangterm) trap "" TERM;; *) trap \'echo "$n $$ term" >> "$d/events"; exit 0\' TERM;; esac',
    'r=0; tr=0',
    'while :; do',
    // A stub whose test dir is gone ends: nothing it reports to exists any more.
    '  [ -d "$d" ] || exit 0',
    '  m=$(cat "$d/$n.mode"); now=$(date +%s); [ "$m" = hangterm ] && trap "" TERM',
    '  case $m in hang|hangterm) ;; *) b=$(cat "$d/$n.busy" 2>/dev/null || echo 0); echo "$now $b $$" > "$WALNUT_LAUNCHER_DIR/hb.$$" && mv -f "$WALNUT_LAUNCHER_DIR/hb.$$" "$WALNUT_LAUNCHER_DIR/heartbeat";; esac',
    // <name>.adopts: the version says what it takes over (detached/adopts) before it is ready.
    '  if [ $r = 0 ] && [ "$m" != noready ]; then [ -f "$d/$n.adopts" ] && echo host-exec > "$WALNUT_LAUNCHER_DIR/../detached/adopts"; printf "pid=%s\\n" $$ > "$WALNUT_LAUNCHER_DIR/ready"; r=1; tr=$now; fi',
    '  case $m in crash:*) [ $((now - tr)) -ge ${m#crash:} ] && exit 3;; quit:*) [ $((now - tr)) -ge ${m#quit:} ] && exit 0;; esac',
    // leave:N: a planned exit N s after ready (it prepared for an update an older Walnut runs), said first.
    '  case $m in leave:*) if [ $((now - tr)) -ge ${m#leave:} ]; then printf "pid=%s\\nreason=update\\n" $$ > "$WALNUT_LAUNCHER_DIR/leaving"; exit 1; fi;; esac',
    '  case $m in beat:*) /bin/sleep ${m#beat:};; *) /bin/sleep 0.2;; esac',
    'done',
    '',
  ].join('\n'), { mode: 0o700 })
  return exe
}

function writeLauncher(seed: string, file = path.join(state, 'walnut-launcher.sh'), searchPath = '/usr/bin:/bin'): string {
  const text = renderLauncherScript({
    platform: 'linux', home, executable: seed, args: ['--service'], runtimeDir: path.join(dir, 'runtime'), stateDir: state, path: searchPath,
  }, { backend: 'systemd', self: file, clocks: CLOCKS })
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o700 })
  fs.renameSync(`${file}.tmp`, file)
  return file
}

/** A `date` on PATH whose epoch runs `offset` seconds ahead (a wake from sleep, a clock jump) for the launcher and its service. */
function clockShim(): { path: string; jump: (seconds: number) => void } {
  const shim = path.join(dir, 'shim')
  fs.mkdirSync(shim)
  const offset = path.join(dir, 'offset')
  fs.writeFileSync(path.join(shim, 'date'), [
    '#!/bin/sh', `off=$(cat '${offset}' 2>/dev/null || echo 0)`,
    'if [ "$1" = "+%s" ]; then echo $(( $(/bin/date +%s) + off )); else exec /bin/date "$@"; fi', '',
  ].join('\n'), { mode: 0o700 })
  return { path: `${shim}:/usr/bin:/bin`, jump: (seconds) => fs.writeFileSync(offset, `${seconds}\n`) }
}

let shell = '/bin/dash'
let shellArgs: string[] = []
function launch(script: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(shell, [...shellArgs, script], { stdio: 'ignore', detached: true, env: { HOME: home, PATH: guardedPath([], '/usr/bin:/bin'), ...env } })
  children.push(child)
  return child
}

const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
function kv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of read(file).split('\n')) { const at = line.indexOf('='); if (at > 0) out[line.slice(0, at)] = line.slice(at + 1) }
  return out
}
const launcherState = () => kv(path.join(L, 'state'))
const result = () => kv(path.join(L, 'result'))
function runs(name?: string): Array<{ name: string; pid: number }> {
  return read(path.join(dir, 'runs')).trim().split('\n').filter(Boolean).map((l) => l.split(' '))
    .map(([n, pid]) => ({ name: n!, pid: Number(pid) })).filter((r) => name === undefined || r.name === name)
}
const alive = (pid: number): boolean => {
  if (!(pid > 1)) return false
  const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return st !== '' && !st.startsWith('Z')
}
/** The stub processes running now, by name. */
const live = (name?: string) => runs(name).filter((r) => alive(r.pid))

async function until(test: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; log:\n${read(path.join(L, 'launcher.log'))}\nruns: ${read(path.join(dir, 'runs'))}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function request(exe: string, extra: Record<string, string> = {}): string {
  const id = `r${Math.random().toString(16).slice(2, 10)}`
  const body = { id, op: 'switch', exe, prepared: '1', at: String(Math.floor(Date.now() / 1000)), build: `walnut-daemon-${path.basename(exe)}`, ...extra }
  fs.writeFileSync(path.join(L, 'request.tmp'), Object.entries(body).map(([k, v]) => `${k}=${v}\n`).join(''))
  fs.renameSync(path.join(L, 'request.tmp'), path.join(L, 'request'))
  return id
}

/** Kill only what this test started: its launchers, and the stubs whose command names this test's dir. */
function killAll(): void {
  fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
  // Each launcher is its own process group (spawned detached), and the stubs it runs stay in it:
  // ending the group ends a stub the runs file does not name yet (2026-11-22: ten stubs outlived
  // their test on a Mac, each forking every 0.2 s for a day).
  for (const child of children.splice(0)) {
    if (child.pid && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  for (const r of runs()) {
    let command = ''
    try { command = execFileSync('ps', ['-o', 'command=', '-p', String(r.pid)], { encoding: 'utf8' }).trim() } catch { continue }
    if (command.includes(dir)) { try { process.kill(r.pid, 'SIGKILL') } catch { /* gone */ } }
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launcher-run-'))
  state = path.join(dir, 'state')
  home = path.join(dir, 'home')
  L = path.join(state, 'launcher')
  for (const d of [state, home]) fs.mkdirSync(d, { mode: 0o700 })
})

afterEach(() => {
  killAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.each(SHELLS)('the service launcher under %s', (_label, bin) => {
  beforeEach(() => {
    shell = bin!
    shellArgs = bin!.endsWith('bash') ? ['--posix'] : []
  })

  it('starts the seed version, with the launcher dir in its environment, and brings it back after a kill', async () => {
    const v1 = stub('v1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    expect(launcherState()).toMatchObject({ current: v1, good: v1, phase: 'committed', pin: v1 })
    const first = live('v1')[0]!
    process.kill(first.pid, 'SIGKILL')
    const killedAt = Date.now()
    await until(() => live('v1').length === 1 && live('v1')[0]!.pid !== first.pid, 5_000, 'restart')
    expect(Date.now() - killedAt).toBeLessThan(4_000)
    expect(live().length).toBe(1)
  })

  it('ends a service whose heartbeat stalls and starts it again, but not one that said it is busy', async () => {
    const v1 = stub('v1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    // Busy for 6 s ahead, then the heartbeat stops: no stall while the busy time lasts.
    fs.writeFileSync(path.join(dir, 'v1.busy'), `${Math.floor(Date.now() / 1000) + 6}\n`)
    await sleep(700)
    fs.writeFileSync(path.join(dir, 'v1.mode'), 'hang\n')
    const busyPid = live('v1')[0]!.pid
    await sleep(4_000)
    expect(alive(busyPid)).toBe(true)
    // Past the busy time: ended (TERM) and started again.
    await until(() => !alive(busyPid), 8_000, 'stalled service ended')
    fs.writeFileSync(path.join(dir, 'v1.mode'), 'good\n')
    await until(() => live('v1').length === 1, 6_000, 'restart after the stall')
    expect(read(path.join(L, 'launcher.log'))).toMatch(/no heartbeat from pid \d+ for \d+ s: ending it/)
  })

  it('kills a stalled service that ignores SIGTERM', async () => {
    const v1 = stub('v1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const pid = live('v1')[0]!.pid
    fs.writeFileSync(path.join(dir, 'v1.mode'), 'hangterm\n')
    await until(() => !alive(pid), 20_000, 'stalled service killed')
    expect(read(path.join(L, 'launcher.log'))).toMatch(/did not stop in 10 s: KILL/)
  }, 30_000)

  it('a stalled service that leads its own process group and ignores SIGTERM is KILLed with everything in that group', async () => {
    // The Mac's run script shape: it makes itself a group leader, and the real server runs below it.
    const exe = path.join(dir, 'grouped')
    fs.writeFileSync(exe, [
      '#!/bin/sh',
      `d='${dir}'`,
      '[ "$G" = 1 ] || { G=1; export G; exec perl -e \'setpgrp(0,0); exec @ARGV or exit 127\' /bin/sh "$0" "$@"; }',
      'trap "" TERM',
      '( trap "" TERM; while [ -d "$d" ]; do /bin/sleep 0.2; done ) &',
      'echo "grouped $$ $!" >> "$d/runs"',
      'printf "pid=%s\\n" $$ > "$WALNUT_LAUNCHER_DIR/ready"',
      // One beat, then none: a stall.
      'echo "$(date +%s) 0 $$" > "$WALNUT_LAUNCHER_DIR/hb.$$" && mv -f "$WALNUT_LAUNCHER_DIR/hb.$$" "$WALNUT_LAUNCHER_DIR/heartbeat"',
      'while [ -d "$d" ]; do /bin/sleep 0.2; done',
      '',
    ].join('\n'), { mode: 0o700 })
    launch(writeLauncher(exe))
    await until(() => read(path.join(dir, 'runs')).includes('grouped '), 5_000, 'grouped start')
    const [, pid, below] = read(path.join(dir, 'runs')).trim().split('\n')[0]!.split(' ').map(Number)
    expect(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()).toBe(String(pid))
    await until(() => !alive(pid!) && !alive(below!), 25_000, 'the whole group ended')
    expect(read(path.join(L, 'launcher.log'))).toMatch(/did not stop in 10 s: KILL \(its process group\)/)
    // The launcher itself (another group) lives on and starts it again.
    await until(() => read(path.join(dir, 'runs')).trim().split('\n').length >= 2, 8_000, 'restart')
  }, 40_000)

  it('switches to a new version as a trial, commits it once ready, and makes it the good one after probation', async () => {
    const v1 = stub('v1'); const v2 = stub('v2')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    expect(live('v1').length).toBe(0)
    expect(live('v2').length).toBe(1)
    expect(launcherState()).toMatchObject({ current: v2, good: v1, phase: 'probation' })
    await until(() => launcherState().phase === 'committed', 10_000, 'probation end')
    expect(launcherState()).toMatchObject({ current: v2, good: v2, build: 'walnut-daemon-v2', good_build: 'walnut-daemon-v2' })
  })

  it('puts the old version back when the new one is never ready, refuses it for a day, and leaves the reason', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'noready')
    fs.mkdirSync(path.join(state, 'detached'))
    // The registry's stop script (detached-registry.ts) is run with its dir before the old version starts.
    fs.writeFileSync(path.join(state, 'detached', 'stop-detached.sh'), `#!/bin/sh\necho "stop $1" >> '${dir}/stops'\n`)
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'rolledback', 10_000, 'rollback')
    expect(result().reason).toMatch(/not ready within 3 s/)
    await until(() => live('v1').length === 1 && live('v2').length === 0, 5_000, 'v1 back')
    expect(launcherState()).toMatchObject({ current: v1, good: v1, phase: 'committed' })
    expect(kv(path.join(L, 'rollback'))).toMatchObject({ from: v2, to: v1, build: 'walnut-daemon-v2' })
    expect(read(path.join(state, 'update-probation.failed')).split('\n')[0]).toBe('walnut-daemon-v2')
    // At the put-back, and again when v1 is ready without saying what it adopts (it may land before this read).
    const stops = read(path.join(dir, 'stops')).trim().split('\n')
    expect(stops.length).toBeGreaterThanOrEqual(1)
    expect(new Set(stops)).toEqual(new Set([`stop ${path.join(state, 'detached')}`]))
    // Asked again the same day: refused, nothing stopped.
    const v1pid = live('v1')[0]!.pid
    const again = request(v2)
    await until(() => result().id === again, 5_000, 'refusal')
    expect(result()).toMatchObject({ outcome: 'refused', reason: 'this version failed here in the last day' })
    expect(alive(v1pid)).toBe(true)
  })

  it('a switch during a clean probation makes the running version the one a failed switch puts back', async () => {
    // Deploys come every 10 minutes, the probation is 15: a second update must not fall back two versions.
    const v1 = stub('v1'); const v2 = stub('v2'); const v3 = stub('v3', 'fail')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id2 = request(v2)
    await until(() => result().id === id2 && result().outcome === 'committed', 8_000, 'v2 commit')
    expect(launcherState()).toMatchObject({ current: v2, good: v1, phase: 'probation' })
    const id3 = request(v3)
    await until(() => result().id === id3 && result().outcome === 'rolledback', 8_000, 'v3 rollback')
    expect(kv(path.join(L, 'rollback'))).toMatchObject({ from: v3, to: v2 })
    await until(() => live('v2').length === 1 && live('v1').length === 0, 5_000, 'v2 back')
    expect(launcherState()).toMatchObject({ current: v2, good: v2, phase: 'committed' })
  })

  it('puts the old version back when the new one exits before it is ready', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'fail')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'rolledback', 8_000, 'rollback')
    expect(result().reason).toMatch(/exited with 1 .*before it was ready/)
    await until(() => live('v1').length === 1, 5_000, 'v1 back')
  })

  it('puts the old version back when the new one fails twice in its probation, not after one failure', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'crash:1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    await until(() => runs('v2').length >= 2, 8_000, 'second start of v2')
    expect(launcherState().current).toBe(v2)
    await until(() => kv(path.join(L, 'rollback')).from === v2, 10_000, 'rollback in probation')
    expect(kv(path.join(L, 'rollback')).reason).toMatch(/failed 2 times in its first/)
    await until(() => live('v1').length === 1 && live('v2').length === 0, 5_000, 'v1 back')
  })

  it('a planned exit the service said first (an update an older Walnut runs) is no crash in the probation', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'leave:1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    await until(() => runs('v2').length >= 3, 10_000, 'v2 left twice and started again')
    await until(() => launcherState().phase === 'committed', 10_000, 'probation end')
    expect(launcherState()).toMatchObject({ current: v2, good: v2, crashes: '0' })
    expect(read(path.join(L, 'rollback'))).toBe('')
    expect(read(path.join(L, 'launcher.log'))).toMatch(/left on purpose \(update\)/)
  })

  it('any exit in the probation it did not announce counts, a clean one included', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'quit:1')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    request(v2)
    await until(() => kv(path.join(L, 'rollback')).from === v2, 12_000, 'rollback in probation')
    expect(kv(path.join(L, 'rollback')).reason).toMatch(/failed 2 times .*exited with 0/)
  })

  it('a switch cut off by SIGTERM (the unit restarted right after the update asked) is tried again by the next launcher', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'noready')
    const script = writeLauncher(v1)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => live('v2').length === 1 && launcherState().phase === 'trial', 5_000, 'trial running')
    process.kill(first.pid!, 'SIGTERM')
    await until(() => !alive(first.pid!) && live().length === 0, 8_000, 'stopped')
    // Back to the old version, the switch left for the next launcher: no put-back, no refusal.
    expect(launcherState()).toMatchObject({ current: v1, phase: 'committed' })
    expect(kv(path.join(L, 'request'))).toMatchObject({ id, exe: v2, prepared: '1' })
    expect(result().id).not.toBe(id)
    fs.writeFileSync(path.join(dir, 'v2.mode'), 'good\n')
    launch(script)
    await until(() => result().id === id, 10_000, 'the switch answered')
    expect(result().outcome).toBe('committed')
    expect(launcherState().current).toBe(v2)
    expect(read(path.join(L, 'bad'))).toBe('')
  })

  it('a switch cut off by a stop three times is the version\'s failure: put back and refused', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'noready')
    const script = writeLauncher(v1)
    let launcher = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    for (let i = 1; i <= 3; i++) {
      await until(() => live('v2').length === 1 && launcherState().phase === 'trial', 6_000, `trial ${i} running`)
      process.kill(launcher.pid!, 'SIGTERM')
      await until(() => !alive(launcher.pid!), 8_000, `launcher ${i} stopped`)
      if (i < 3) { expect(kv(path.join(L, 'request')).tries).toBe(String(i)); launcher = launch(script) }
    }
    expect(result()).toMatchObject({ id, outcome: 'rolledback' })
    expect(read(path.join(L, 'bad'))).toContain(v2)
    expect(fs.existsSync(path.join(L, 'request'))).toBe(false)
  }, 40_000)

  it('drops a prepared switch asked over an hour ago', async () => {
    const v1 = stub('v1'); const v2 = stub('v2')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2, { at: String(Math.floor(Date.now() / 1000) - 4000) })
    await until(() => result().id === id, 5_000, 'answered')
    expect(result().outcome).toBe('failed')
    expect(live('v1')).toHaveLength(1)
  })

  it('a wake from sleep or a clock jump kills nothing and moves the probation clock', async () => {
    const clock = clockShim()
    const v1 = stub('v1', 'beat:1'); const v2 = stub('v2', 'beat:1')
    launch(writeLauncher(v1, undefined, clock.path))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    const pid = live('v2')[0]!.pid
    const since = Number(launcherState().since)
    clock.jump(120)
    await sleep(3_000)
    expect(live('v2').map((r) => r.pid)).toEqual([pid])
    expect(read(path.join(L, 'launcher.log'))).toMatch(/the clock moved 1[12]\d s in one tick/)
    expect(read(path.join(L, 'launcher.log'))).not.toMatch(/no heartbeat/)
    // The 120 s asleep are no probation time: still watched, its clock moved by the gap.
    expect(launcherState().phase).toBe('probation')
    expect(Number(launcherState().since)).toBeGreaterThanOrEqual(since + 110)
  })

  it('a trial that beats and says it is busy (a long adoption) gets longer than the trial time', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'noready')
    fs.writeFileSync(path.join(dir, 'v2.busy'), `${Math.floor(Date.now() / 1000) + 100}\n`)
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await sleep((CLOCKS.trial + 2) * 1000)
    expect(launcherState()).toMatchObject({ current: v2, phase: 'trial' })
    fs.writeFileSync(path.join(dir, 'v2.mode'), 'good\n')
    await until(() => result().id === id, 5_000, 'commit')
    expect(result().outcome).toBe('committed')
  })

  it('a current version that is gone: the launcher runs the good one, else its seed', async () => {
    const v1 = stub('v1'); const v2 = stub('v2')
    const script = writeLauncher(v1)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    process.kill(first.pid!, 'SIGKILL')
    for (const r of live('v2')) process.kill(r.pid, 'SIGKILL')
    fs.rmSync(v2)
    await sleep(300)
    launch(script)
    await until(() => live('v1').length === 1, 6_000, 'v1 again')
    expect(launcherState()).toMatchObject({ current: v1, phase: 'committed' })
    expect(read(path.join(L, 'launcher.log'))).toMatch(/is not there any more: running/)
  })

  it('a put-back asked by the update keeps the reason it gave', async () => {
    const v1 = stub('v1'); const v2 = stub('v2')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    const back = request(v2, { op: 'rollback', reason: 'the new daemon did not answer as walnut-daemon-v2' })
    await until(() => result().id === back, 8_000, 'rollback answered')
    expect(kv(path.join(L, 'rollback')).reason).toBe('the new daemon did not answer as walnut-daemon-v2')
    await until(() => live('v1').length === 1, 5_000, 'v1 back')
  })

  it('a version that says nothing of what it takes over (no detached/adopts) gets the registry\'s work ended once it is ready', async () => {
    const reg = path.join(state, 'detached')
    fs.mkdirSync(reg)
    fs.writeFileSync(path.join(reg, 'stop-detached.sh'), `#!/bin/sh\necho "stop $1" >> '${dir}/stops'\n`, { mode: 0o700 })
    const v1 = stub('v1'); const v2 = stub('v2')
    fs.writeFileSync(path.join(dir, 'v1.adopts'), '')
    fs.writeFileSync(path.join(reg, 'adopts'), 'stale from an earlier version\n')
    launch(writeLauncher(v1))
    await until(() => live('v1').length === 1 && fs.existsSync(path.join(L, 'ready')), 5_000, 'v1 ready')
    // v1 wrote its own adopts (the stale one was removed before it started): nothing is ended.
    expect(read(path.join(reg, 'adopts'))).toBe('host-exec\n')
    await sleep(600)
    expect(read(path.join(dir, 'stops'))).toBe('')
    // v2 predates the registry: once ready, the work it cannot follow is ended, once.
    const id = request(v2)
    await until(() => result().id === id && result().outcome === 'committed', 8_000, 'commit')
    await until(() => read(path.join(dir, 'stops')) !== '', 5_000, 'registry work ended')
    expect(read(path.join(dir, 'stops'))).toBe(`stop ${reg}\n`)
    expect(fs.existsSync(path.join(reg, 'adopts'))).toBe(false)
    expect(read(path.join(L, 'launcher.log'))).toMatch(/takes over no detached work/)
  })

  it('a launcher and its trial killed mid-switch (a power loss): the next launcher runs the old version', async () => {
    const v1 = stub('v1'); const v2 = stub('v2', 'noready')
    const script = writeLauncher(v1)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    request(v2)
    await until(() => live('v2').length === 1 && launcherState().phase === 'trial', 5_000, 'trial running')
    process.kill(first.pid!, 'SIGKILL')
    for (const r of live('v2')) process.kill(r.pid, 'SIGKILL')
    // As systemd (RestartSec=1), launchd or cron would, a moment later.
    await sleep(300)
    launch(script)
    await until(() => live('v1').length === 1, 6_000, 'v1 again')
    expect(launcherState()).toMatchObject({ current: v1, phase: 'committed' })
    expect(kv(path.join(L, 'rollback')).reason).toMatch(/not confirmed before the launcher or the machine stopped/)
    // Not the version's fault: it is not refused, and a new request for it is a switch again.
    expect(read(path.join(L, 'bad'))).toBe('')
  })

  it('a killed launcher leaves its service running, and the next one watches it on without starting a second', async () => {
    const v1 = stub('v1')
    const script = writeLauncher(v1)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const pid = live('v1')[0]!.pid
    process.kill(first.pid!, 'SIGKILL')
    await sleep(1_000)
    expect(alive(pid)).toBe(true)
    launch(script)
    await until(() => read(path.join(L, 'launcher.log')).includes(`watching the service already running (pid ${pid}`), 5_000, 'adoption')
    await sleep(1_500)
    expect(live('v1').map((r) => r.pid)).toEqual([pid])
    // It still keeps it: killed, it comes back under the new launcher.
    process.kill(pid, 'SIGKILL')
    await until(() => live('v1').length === 1 && live('v1')[0]!.pid !== pid, 6_000, 'restart by the new launcher')
  })

  it('watches its running service on where ps pads its columns (macOS), never starting a second one', async () => {
    // 2026-11-21, the Mac's launchd run: a padded lstart never matched the one written, so the next
    // launcher took its own service for another process and started a second one.
    const shims = path.join(dir, 'shims'); fs.mkdirSync(shims)
    fs.writeFileSync(path.join(shims, 'ps'), '#!/bin/sh\n/bin/ps "$@" | sed "s/^/  /; s/$/    /"\n', { mode: 0o700 })
    const v1 = stub('v1')
    const script = writeLauncher(v1, undefined, `${shims}:/usr/bin:/bin`)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const pid = live('v1')[0]!.pid
    process.kill(first.pid!, 'SIGKILL')
    await sleep(500)
    launch(script)
    await until(() => read(path.join(L, 'launcher.log')).includes(`watching the service already running (pid ${pid}`), 5_000, 'adoption')
    await sleep(1_500)
    expect(live('v1').map((r) => r.pid)).toEqual([pid])
  })

  it('a descendant that inherited L_LOCKED still takes the lock: no second launcher', async () => {
    const v1 = stub('v1')
    const script = writeLauncher(v1)
    const first = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const second = launch(script, { L_LOCKED: String(first.pid) })
    await until(() => second.exitCode !== null, 5_000, 'second launcher gone')
    expect(second.exitCode).toBe(0)
    expect(live('v1')).toHaveLength(1)
    // The service never inherits the launcher's lock marker.
    const environ = `/proc/${live('v1')[0]!.pid}/environ`
    if (fs.existsSync(environ)) expect(fs.readFileSync(environ, 'utf8')).not.toMatch(/(^|\0)L_LOCKED=/)
  })

  it('two launchers on one state dir: only one runs the service', async () => {
    const v1 = stub('v1')
    const script = writeLauncher(v1)
    const a = launch(script); const b = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    await sleep(1_500)
    expect(live('v1').length).toBe(1)
    expect([a.exitCode, b.exitCode]).toContain(0)
  })

  it('SIGTERM stops the service, then the launcher; the stop file ends it and leaves the service', async () => {
    const v1 = stub('v1')
    const child = launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'first start')
    const pid = live('v1')[0]!.pid
    process.kill(child.pid!, 'SIGTERM')
    await until(() => child.exitCode !== null && !alive(pid), 6_000, 'stop')
    const next = launch(writeLauncher(v1))
    await until(() => live('v1').length === 1, 5_000, 'start again')
    fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
    await until(() => next.exitCode !== null, 3_000, 'launcher end')
    expect(live('v1').length).toBe(1)
  })

  it('follows an EXEC an older Walnut wrote into the script, and runs a rewritten launcher in place', async () => {
    const v1 = stub('v1'); const v2 = stub('v2')
    const script = writeLauncher(v1)
    const child = launch(script)
    await until(() => live('v1').length === 1, 5_000, 'first start')
    // An older update rewrites EXEC only; the launcher notices its script changed and follows it.
    writeLauncher(v2, script)
    await until(() => live('v2').length === 1 && live('v1').length === 0, 20_000, 'EXEC followed')
    expect(launcherState()).toMatchObject({ current: v2, good: v2, pin: v2, phase: 'committed' })
    expect(alive(child.pid!)).toBe(true)
  }, 30_000)
})
