/**
 * A plugin's `walnut.hosts.run` on another host (src/core/hosts/host-script.ts): through the
 * link to the host's daemon and its exec.script, never ssh. 2026-11-16: the run built its own
 * `ssh <hostname>`, so a host on the host network (transport: net, hostname
 * clouddev.walnut-net.invalid) failed every time.
 *
 * The daemon side here is the real one: host-exec-core's exec.script, running the script in a
 * real shell on this machine, in a temp home; only the link itself (link.ts) is a stand-in that
 * hands each command to it, as a daemon's socket would (tests/providers/host-exec-twins-e2e.test.ts
 * runs both real daemons).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { guardedPath } from '../../setup/exec-guard.js'
import { createHostExec } from '../../../src/providers/host-exec-core.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-script-')))
const tmp = path.join(root, 'tmp')
fs.mkdirSync(tmp)
const core = createHostExec({
  spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: '/bin/sh', home: root, taskDirRoot: null, stateDir: path.join(root, 'state'),
  env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root, TMPDIR: tmp }, promptProbe: null,
})

const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
let capabilities = new Set(['host-exec-v1', 'host-script-v1'])

/** A daemon link: each command answered by this machine as that host's daemon would (replyTransfer). */
const conn = {
  hasCapability: (c: string) => capabilities.has(c),
  async send(cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    sent.push({ cmd, params })
    if (cmd !== 'exec.script') return { ok: false, error: `unknown command ${cmd}` }
    try {
      return { ok: true, ...await core.script(params) }
    } catch (err) {
      return { ok: false, error: `exec.script failed: ${(err as Error).message}`, code: (err as { code?: string }).code }
    }
  },
}

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    hosts: {
      // As Settings writes a machine that joined the host network: no SSH route at all.
      clouddev: { hostname: 'clouddev.walnut-net.invalid', transport: 'net', endpoint: 'ab'.repeat(32), label: 'Cloud dev' },
      devbox: { hostname: 'devbox.example.test', user: 'me', port: 2222 },
    },
  })),
}))
const linked: string[] = []
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: vi.fn(async (host: string) => { linked.push(host); return conn }),
}))

const { runOnPluginHost } = await import('../../../src/core/plugins/plugin-hosts.js')
const { runScriptOverLink } = await import('../../../src/core/hosts/host-script.js')

/** No ssh, ever: a local spawn that is asked to run one fails the test. */
const noSsh = ((command: string, ...rest: unknown[]) => {
  if (/(^|\/)(ssh|scp)$/.test(command)) throw new Error(`ssh spawned: ${command}`)
  return (spawn as (...a: unknown[]) => unknown)(command, ...rest)
}) as unknown as typeof spawn

/** Nothing of a run stays on the host: no job, no log. */
async function nothingKept(): Promise<void> {
  expect((await core.list()).jobs).toEqual([])
  const logs = path.join(root, 'state', 'host-exec')
  expect(fs.existsSync(logs) ? fs.readdirSync(logs) : []).toEqual([])
}

beforeEach(() => {
  sent.length = 0
  linked.length = 0
  capabilities = new Set(['host-exec-v1', 'host-script-v1'])
})

afterAll(async () => {
  for (const j of (await core.list()).jobs) if (j.running) await core.kill({ jobId: j.jobId }).catch(() => {})
  core.close()
  if (root.includes('walnut-host-script-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('hosts.run on a host-network host', () => {
  it('runs through the link and the daemon, with literal arguments and stdout and stderr apart', async () => {
    const args = ["it's", 'a b', '$(echo injected)', '*', 'caf\u00e9', '']
    const result = await runOnPluginHost('clouddev', { script: 'for a in "$@"; do printf "[%s]" "$a"; done; echo "$0"; echo oops >&2; exit 7', args }, noSsh)
    expect(result).toEqual({ code: 7, stdout: "[it's][a b][$(echo injected)][*][caf\u00e9][]sh\n", stderr: 'oops\n', timedOut: false, truncated: false })
    expect(linked).toEqual(['clouddev'])
    expect(sent.map((s) => s.cmd)).toEqual(['exec.script'])
    await nothingKept()
  })

  it('an SSH host goes the same way: through its link, never an ssh of its own', async () => {
    const result = await runOnPluginHost('devbox', { script: 'echo hi' }, noSsh)
    expect(result).toEqual({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false, truncated: false })
    expect(linked).toEqual(['devbox'])
  })

  it('a login profile neither reaches stdout nor reads the script', async () => {
    const profile = path.join(root, '.profile')
    try {
      // A terminal title with no newline, and a profile that reads its stdin.
      fs.writeFileSync(profile, 'printf "\\033]0;title\\007"\nread -r eaten || true\necho "profile-read:[$eaten]" >&2\n')
      const r = await runOnPluginHost('clouddev', { script: 'echo one\necho two' }, noSsh)
      expect(r).toMatchObject({ code: 0, stdout: 'one\ntwo\n' })
      expect(r.stderr).toContain('profile-read:[]')
      // A profile that exits: the script never ran, and the answer says so.
      fs.writeFileSync(profile, 'exit 0\n')
      const gone = await runOnPluginHost('clouddev', { script: 'echo never' }, noSsh)
      expect(gone).toMatchObject({ code: 255, stdout: '', stderr: expect.stringContaining('the login shell never started the script') })
    } finally {
      fs.rmSync(profile, { force: true })
    }
  })

  it('returns a large stdout whole, and ends a run past its cap', async () => {
    const big = await runOnPluginHost('clouddev', { script: `head -c 3000000 /dev/zero | tr '\\0' a; echo; echo e >&2` }, noSsh)
    expect(big).toMatchObject({ code: 0, truncated: false, stderr: 'e\n' })
    expect(big.stdout).toBe(`${'a'.repeat(3_000_000)}\n`)

    const t0 = Date.now()
    const loud = await runOnPluginHost('clouddev', { script: 'while :; do echo 0123456789; done; sleep 30', maxOutputBytes: 25 }, noSsh)
    expect(loud).toEqual({ code: null, stdout: '0123456789\n0123456789\n012', stderr: '', timedOut: false, truncated: true })
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 30_000)

  it('keeps only the end of a long stderr', async () => {
    const r = await runOnPluginHost('clouddev', { script: 'i=0; while [ $i -lt 2000 ]; do echo "line $i" >&2; i=$((i+1)); done; echo last >&2' }, noSsh)
    expect(r.stderr.length).toBeLessThanOrEqual(4000)
    expect(r.stderr.endsWith('line 1999\nlast\n')).toBe(true)
  })

  it('ends a run at its deadline with what it printed so far, its children stopped with it', async () => {
    const pidFile = path.join(root, 'child.pid')
    const t0 = Date.now()
    const slow = await runOnPluginHost('clouddev', { script: `echo started; echo warn >&2; sleep 30 & echo $! > '${pidFile}'; sleep 30; echo never`, timeoutMs: 1500 }, noSsh)
    expect(slow).toEqual({ code: null, stdout: 'started\n', stderr: 'warn\n', timedOut: true, truncated: false })
    expect(Date.now() - t0).toBeLessThan(10_000)
    const child = Number(fs.readFileSync(pidFile, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5_000 })
    await nothingKept()
  }, 30_000)

  it('a daemon update stops a running script, which answers as stopped at its deadline', async () => {
    const up = path.join(root, 'script.up')
    const run = runOnPluginHost('clouddev', { script: `echo up; : > '${up}'; sleep 30`, timeoutMs: 60_000 }, noSsh)
    await vi.waitFor(() => expect(fs.existsSync(up)).toBe(true), { timeout: 10_000 })
    expect(core.scripts()).toBe(1)
    expect(core.endForUpdate('test update')).toBe(1)
    expect(await run).toMatchObject({ code: null, stdout: 'up\n', timedOut: true })
    expect(core.scripts()).toBe(0)
  }, 30_000)

  it('a host that cannot run it is a failed run with the reason, as ssh\'s exit 255 was', async () => {
    capabilities = new Set(['host-exec-v1'])
    const r = await runOnPluginHost('clouddev', { script: 'true' }, noSsh)
    expect(r).toMatchObject({ code: 255, stdout: '', timedOut: false, truncated: false })
    expect(r.stderr).toMatch(/^walnut: The Walnut daemon on .* needs an update/)
    expect(sent).toEqual([])
  })

  it('the daemon refuses a bad script with its own words', async () => {
    await expect(runScriptOverLink(conn, { script: ' ', args: [], timeoutMs: 1000, maxOutputBytes: 10 })).rejects.toThrow(/^hosts\.run needs a script\.$/)
  })
})
