import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildDaemonStartCmd, buildDaemonStopCmd } from '../../src/providers/daemon-start-cmd.js'

const execFileAsync = promisify(execFile)

// Behavior tests for the daemon start command: we EXECUTE the generated shell
// against a fake runtime (a script standing in for bun / the daemon binary)
// and assert the daemon actually boots and receives its env. This is what the
// 2026-08-12 clouddev outage taught us — a string-level review missed that
// `nohup VAR=1 cmd` makes nohup exec 'VAR=1' as the program; running the real
// command catches that class of bug (quoting, env passing, nohup semantics)
// without needing SSH or a real daemon.
describe('buildDaemonStartCmd', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-startcmd-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  /**
   * Fake runtime: writes daemon.pid/daemon.port like the real daemon, dumps
   * its env to env.txt so tests can assert delivery, then sleeps so `kill -0`
   * sees a live pid while confirmRunning runs.
   */
  async function writeFakeRuntime(name: string): Promise<string> {
    const p = path.join(dir, name)
    await fsp.writeFile(p, [
      '#!/bin/sh',
      `printenv > "${dir}/env.txt"`,
      `echo $$ > "${dir}/daemon.pid"`,
      `echo 41673 > "${dir}/daemon.port"`,
      'sleep 5',
    ].join('\n'), { mode: 0o755 })
    return p
  }

  async function run(cmd: string) {
    return execFileAsync('sh', ['-c', cmd], { encoding: 'utf-8', timeout: 30_000 })
  }

  it('bun runtime boots and reports running (no env vars)', async () => {
    const fake = await writeFakeRuntime('fake-bun')
    const { stdout } = await run(buildDaemonStartCmd({ runtime: 'bun', execPath: fake, dir }))
    expect(stdout).toContain('41673')
    expect(stdout).toContain('"running":true')
  })

  it('bun runtime delivers env vars through nohup (the outage shape)', async () => {
    const fake = await writeFakeRuntime('fake-bun')
    const cmd = buildDaemonStartCmd({
      runtime: 'bun',
      execPath: fake,
      dir,
      env: { WALNUT_ENFORCE_SESSION_CRON: '1' },
    })
    const { stdout } = await run(cmd)
    expect(stdout).toContain('"running":true')
    const envDump = await fsp.readFile(path.join(dir, 'env.txt'), 'utf-8')
    expect(envDump).toContain('WALNUT_ENFORCE_SESSION_CRON=1')
    // The start log must NOT contain the nohup exec failure that took
    // clouddev down (nohup tried to run 'VAR=1' as the program).
    const startLog = await fsp.readFile(path.join(dir, 'daemon-start.log'), 'utf-8')
    expect(startLog).not.toContain('failed to run command')
  })

  it('node runtime runs the preamble and delivers env', async () => {
    const fake = await writeFakeRuntime('node')
    const cmd = buildDaemonStartCmd({
      runtime: 'node',
      dir,
      env: { WALNUT_ENFORCE_SESSION_CRON: '1' },
      preamble: `PATH="${dir}:$PATH"; touch "${dir}/preamble-ran"`,
    })
    const { stdout } = await run(cmd)
    expect(stdout).toContain('"running":true')
    await expect(fsp.access(path.join(dir, 'preamble-ran'))).resolves.toBeUndefined()
    const envDump = await fsp.readFile(path.join(dir, 'env.txt'), 'utf-8')
    expect(envDump).toContain('WALNUT_ENFORCE_SESSION_CRON=1')
  })

  it('binary runtime passes --start under nohup with env', async () => {
    // Binary fake also answers --status (the binary-deploy confirm path).
    const p = path.join(dir, 'fake-binary')
    await fsp.writeFile(p, [
      '#!/bin/sh',
      'if [ "$1" = "--status" ]; then echo "{\\"running\\":true,\\"port\\":41673}"; exit 0; fi',
      `printenv > "${dir}/env.txt"`,
      `echo $$ > "${dir}/daemon.pid"`,
      `echo 41673 > "${dir}/daemon.port"`,
      'sleep 5',
    ].join('\n'), { mode: 0o755 })
    const cmd = buildDaemonStartCmd({
      runtime: 'binary',
      execPath: p,
      dir,
      env: { WALNUT_ENFORCE_SESSION_CRON: '1' },
    })
    const { stdout } = await run(cmd)
    expect(stdout).toContain('41673')
    expect(stdout).toContain('"running":true')
    const envDump = await fsp.readFile(path.join(dir, 'env.txt'), 'utf-8')
    expect(envDump).toContain('WALNUT_ENFORCE_SESSION_CRON=1')
  })

  it.each(['bun', 'binary', 'node'] as const)('%s: a daemon dir and runtime path with spaces (HOME="/home/John Smith") still boot', async (runtime) => {
    // The ~/.cache fallback puts the daemon under HOME, and a HOME with a space
    // used to split every path in the start command.
    const spaced = path.join(dir, 'John Smith', '.cache', 'open-walnut')
    await fsp.mkdir(spaced, { recursive: true })
    const exec = path.join(spaced, runtime === 'node' ? 'node' : `fake ${runtime}`)
    await fsp.writeFile(exec, [
      '#!/bin/sh',
      'if [ "$1" = "--status" ]; then echo "{\\"running\\":true,\\"port\\":41673}"; exit 0; fi',
      'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
      'echo $$ > "$(dirname "$0")/daemon.pid"',
      'echo 41673 > "$(dirname "$0")/daemon.port"',
      'sleep 5',
    ].join('\n'), { mode: 0o755 })
    const cmd = runtime === 'node'
      ? buildDaemonStartCmd({ runtime, dir: spaced, preamble: `PATH=${"'"}${spaced}${"'"}:"$PATH"` })
      : buildDaemonStartCmd({ runtime, execPath: exec, dir: spaced, env: { WALNUT_DAEMON_DIR: spaced } })
    const { stdout } = await run(cmd)
    expect(stdout).toContain('41673')
    expect(stdout).toContain('"running":true')
    const args = (await fsp.readFile(path.join(spaced, 'args.txt'), 'utf-8')).trim().split('\n')
    expect(args).toEqual(runtime === 'binary' ? ['--start'] : [path.join(spaced, 'daemon.cjs'), '--start'])
    expect(await fsp.readFile(path.join(spaced, 'daemon-start.log'), 'utf-8')).not.toMatch(/No such file|not found/)
  })

  it('env values with spaces/quotes survive shell quoting', async () => {
    const fake = await writeFakeRuntime('fake-bun')
    const cmd = buildDaemonStartCmd({
      runtime: 'bun',
      execPath: fake,
      dir,
      env: { WALNUT_TEST_VALUE: `a b'c$d;e` },
    })
    const { stdout } = await run(cmd)
    expect(stdout).toContain('"running":true')
    const envDump = await fsp.readFile(path.join(dir, 'env.txt'), 'utf-8')
    expect(envDump).toContain(`WALNUT_TEST_VALUE=a b'c$d;e`)
  })

  it('fail-fast: a wrapper exec failure breaks the poll early instead of spinning ~45s', async () => {
    // Point execPath at a file that doesn't exist — the wrapper chain writes
    // its exec-failure line to the start log ("env: ...: No such file" here,
    // since the env prefix hits it first; "nohup: ..." without one), and the
    // poll must bail on iteration 2 (~2s), not run all 22 iterations (~44s).
    const cmd = buildDaemonStartCmd({
      runtime: 'bun',
      execPath: path.join(dir, 'nonexistent-runtime'),
      dir,
      env: { WALNUT_ENFORCE_SESSION_CRON: '1' },
    })
    const started = Date.now()
    await expect(run(cmd)).rejects.toThrow() // confirmRunning fails — no port file
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('a runtime killed by SIGILL before it writes a pid is reaped once and logged as walnut-daemon-exit=132', async () => {
    // A bun build the CPU cannot run dies silently: no shell is left to say so,
    // and without this the poll spun its whole ~45s and the log said nothing.
    const p = path.join(dir, 'fake-bun-sigill')
    await fsp.writeFile(p, '#!/bin/sh\nkill -ILL $$\n', { mode: 0o755 })
    const cmd = buildDaemonStartCmd({ runtime: 'bun', execPath: p, dir, env: { WALNUT_ENFORCE_SESSION_CRON: '1' } })
    const started = Date.now()
    await expect(run(cmd)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(10_000)
    const log = await fsp.readFile(path.join(dir, 'daemon-start.log'), 'utf-8')
    expect(log).toMatch(/walnut-daemon-exit=132\b/)
  })

  it('a runtime that exits non-zero with a loader error keeps that error AND the exit line', async () => {
    const p = path.join(dir, 'fake-node-glibc')
    await fsp.writeFile(p, "#!/bin/sh\necho \"node: /lib64/libc.so.6: version \\\`GLIBC_2.28' not found\" >&2\nexit 1\n", { mode: 0o755 })
    const started = Date.now()
    await expect(run(buildDaemonStartCmd({ runtime: 'binary', execPath: p, dir }))).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(10_000)
    const log = await fsp.readFile(path.join(dir, 'daemon-start.log'), 'utf-8')
    expect(log).toContain('GLIBC_2.28')
    expect(log).toContain('walnut-daemon-exit=1')
  })

  it('fail-fast also triggers without an env prefix (bare nohup failure)', async () => {
    const cmd = buildDaemonStartCmd({
      runtime: 'bun',
      execPath: path.join(dir, 'nonexistent-runtime'),
      dir,
    })
    const started = Date.now()
    await expect(run(cmd)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('rejects invalid env var names and multi-line values', () => {
    expect(() => buildDaemonStartCmd({ runtime: 'node', dir, env: { 'BAD NAME': '1' } })).toThrow()
    expect(() => buildDaemonStartCmd({ runtime: 'node', dir, env: { OK: 'a\nb' } })).toThrow()
  })

  it('requires execPath for bun/binary runtimes', () => {
    expect(() => buildDaemonStartCmd({ runtime: 'bun', dir })).toThrow()
    expect(() => buildDaemonStartCmd({ runtime: 'binary', dir })).toThrow()
  })

  it.each(['drain', 'timeout', 'reused', 'unknown', 'warning', 'denied', 'invalid', 'foreign', 'exited-before-signal'])('stop waits for identity exit without deleting markers: %s', async (scenario) => {
    await fsp.writeFile(path.join(dir, 'daemon.pid'), scenario === 'invalid' ? '-1' : '4242')
    const stub = [
      'count=0',
      'kill() { printf \'%s\\n\' "$*" >> "$LAB_DIR/signals"; if [ "$SCENARIO" = exited-before-signal ]; then count=7; return 1; fi; [ "$SCENARIO" != denied ]; }',
      'sleep() { count=$((count+1)); }',
      'ps() {',
      '  if [ "$4" = command= ]; then if [ "$SCENARIO" = foreign ]; then printf \'%s\\n\' unrelated-process; else printf \'%s\\n\' "$LAB_DIR/daemon-linux-x64 --start"; fi; return 0; fi',
      '  if [ "$count" -ge 7 ] && [ "$SCENARIO" = exited-before-signal ]; then return 1; fi',
      '  if [ "$SCENARIO" = unknown ]; then printf \'%s\\n\' \'permission denied\' >&2; return 1; fi',
      '  if [ "$SCENARIO" = warning ]; then printf \'%s\\n\' warning >&2; fi',
      '  if [ "$count" -ge 7 ] && [ "$SCENARIO" = drain ]; then return 1; fi',
      '  if [ "$count" -ge 7 ] && [ "$SCENARIO" = reused ]; then printf \'%s\\n\' new-identity; return 0; fi',
      '  printf \'%s\\n\' old-identity',
      '}',
    ].join('\n')
    const output = await execFileAsync('/bin/sh', ['-c', `${stub}\n${buildDaemonStopCmd(dir)}`], {
      env: { PATH: '/usr/bin:/bin', LAB_DIR: dir, SCENARIO: scenario }, timeout: 5000,
    }).then((result) => ({ ok: true, stdout: result.stdout }), () => ({ ok: false, stdout: '' }))
    expect(output.ok).toBe(['drain', 'reused', 'exited-before-signal'].includes(scenario))
    if (output.ok) expect(output.stdout.trim()).toBe('walnut-daemon-stop-confirmed')
    const signals = await fsp.readFile(path.join(dir, 'signals'), 'utf8').catch(() => '')
    expect(signals).toBe(['unknown', 'warning', 'invalid', 'foreign'].includes(scenario) ? '' : '-TERM 4242\n')
    expect(await fsp.readFile(path.join(dir, 'daemon.pid'), 'utf8')).toBe(scenario === 'invalid' ? '-1' : '4242')
  })

  it('never renders a bare VAR= directly after nohup (regression shape)', () => {
    for (const runtime of ['bun', 'binary', 'node'] as const) {
      const cmd = buildDaemonStartCmd({
        runtime,
        execPath: runtime === 'node' ? undefined : '/x/runtime',
        dir,
        env: { WALNUT_ENFORCE_SESSION_CRON: '1', OTHER: '2' },
      })
      expect(cmd).not.toMatch(/nohup +[A-Za-z_]+=/)
      expect(cmd).toMatch(/nohup env /)
    }
  })
})
