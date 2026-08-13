import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildDaemonStartCmd } from '../../src/providers/daemon-start-cmd.js'

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
