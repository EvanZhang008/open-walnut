/**
 * The host side of host_exec on a Mac (src/providers/host-exec-core.ts with platform
 * 'darwin'): a line that reads a place macOS guards is refused before it runs, and a job
 * found idle while a dialog is up for it is stopped and says `blocked` (2026-11-03: a `du`
 * and a `security` call each sat at a dialog on a user's screen until stopped by hand).
 * `allowPrompts` turns both off. The prompt probe is injected: no `ps`, no `log`, no tccd.
 *
 * MACHINE SAFETY: HOME, the task root and the state dir are temp paths; the jobs are
 * `sleep` and `echo`, and only their own process group is signalled.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { guardedPath } from '../setup/exec-guard.js'
import path from 'node:path'
import { createHostExec } from '../../src/providers/host-exec-core.js'
import type { PromptProbe } from '../../src/providers/host-exec-watch.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-mac-')))
afterAll(() => { if (root.includes('walnut-host-exec-mac-')) fs.rmSync(root, { recursive: true, force: true }) })

function macHost(name: string, probe: PromptProbe | null, clt = true) {
  const home = path.join(root, name, 'home')
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true })
  const core = createHostExec({
    spawn: (cmd, args, o) => spawn(cmd, args, o),
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
    shell: '/bin/sh', home, taskDirRoot: path.join(root, name, 'tasks'), stateDir: path.join(root, name, 'state'),
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home },
    platform: 'darwin', promptProbe: probe, promptCheckMs: 150, cltInstalled: () => clt, runPath: () => '/usr/bin:/bin',
  })
  return { core, home }
}

/** A probe that says a SecurityAgent dialog came up after the job started, and counts its looks. */
function dialogProbe() {
  const looks = { snapshot: 0, log: 0 }
  const probe: PromptProbe = {
    // The group as a hung keychain call shows it: idle, not only shells and sleeps.
    snapshot: async (pgids) => { looks.snapshot++; return { processes: pgids.map((pgid) => ({ pid: 99_999, pgid, cpuMs: 0, comm: '/usr/bin/security' })), securityAgentStartedAt: Date.now() } },
    tccPrompts: async () => { looks.log++; return [] },
  }
  return { probe, looks }
}

async function until<T>(fn: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('host_exec on a Mac, on the host itself', () => {
  it('refuses a walk over the home or a read of a guarded place before anything runs; allowPrompts lets it run', async () => {
    const { core, home } = macHost('refuse', null)
    await expect(core.run({ jobId: 'hx-mac-00001', taskId: 't-mac', command: 'du -sh ~' })).rejects.toMatchObject({ code: 'may_prompt' })
    await expect(core.run({ jobId: 'hx-mac-00002', taskId: 't-mac', argv: ['ls', `${home}/Desktop`] })).rejects.toMatchObject({ code: 'may_prompt' })
    await expect(core.run({ jobId: 'hx-mac-00003', taskId: 't-mac', command: 'cd ~/Library/Caches && du -sk .' })).rejects.toMatchObject({ code: 'may_prompt', message: expect.stringContaining('this Mac') })
    expect(await core.list({ taskId: 't-mac' })).toEqual({ jobs: [] })
    // Its own folder, and the same walk once the user agreed.
    expect(await core.run({ jobId: 'hx-mac-00004', taskId: 't-mac', command: 'du -sk ~/proj >/dev/null && echo ok' })).toMatchObject({ exitCode: 0, output: 'ok\n' })
    expect(await core.run({ jobId: 'hx-mac-00005', taskId: 't-mac', command: 'du -sk ~ >/dev/null && echo ok', allowPrompts: true })).toMatchObject({ exitCode: 0, output: 'ok\n' })
  })

  // 2026-11-04: `xcodebuild -version` put "Install Command Line Developer Tools" on a Mac owner's screen.
  it('on a Mac without the Command Line Tools, a stub is refused before anything runs; allowPrompts runs it', async () => {
    const { core } = macHost('no-clt', null, false)
    await expect(core.run({ jobId: 'hx-mac-00020', taskId: 't-clt', command: 'xcodebuild -version' })).rejects.toMatchObject({ code: 'may_prompt', message: expect.stringContaining('Command Line Tools') })
    await expect(core.run({ jobId: 'hx-mac-00021', taskId: 't-clt', argv: ['/usr/bin/git', '--version'] })).rejects.toMatchObject({ code: 'may_prompt' })
    expect(await core.list({ taskId: 't-clt' })).toEqual({ jobs: [] })
    expect(await core.run({ jobId: 'hx-mac-00022', taskId: 't-clt', command: 'echo fine' })).toMatchObject({ exitCode: 0, output: 'fine\n' })
    expect(await core.run({ jobId: 'hx-mac-00023', taskId: 't-clt', command: 'echo agreed', allowPrompts: true })).toMatchObject({ exitCode: 0 })
    // Looking one up runs none of them.
    for (const [k, line] of ['command -v git; echo ok', 'type git >/dev/null 2>&1; echo ok', 'which git >/dev/null 2>&1; echo ok'].entries()) {
      expect(await core.run({ jobId: `hx-mac-0003${k}`, taskId: 't-clt', command: line }), line).toMatchObject({ exitCode: 0 })
    }
    // With the tools there nothing is refused for it.
    const { core: withTools } = macHost('clt', null, true)
    await expect(withTools.run({ jobId: 'hx-mac-00024', taskId: 't-clt2', command: 'command -v git >/dev/null; echo ran' })).resolves.toMatchObject({ exitCode: 0, output: 'ran\n' })
  })

  it('stops a job that sits idle at a dialog, and says which', async () => {
    const { probe, looks } = dialogProbe()
    const { core } = macHost('blocked', probe)
    const started = await core.run({ jobId: 'hx-mac-00010', taskId: 't-blk', command: 'echo waiting; sleep 30', background: true })
    expect(started).toMatchObject({ running: true, blocked: null })
    const ended = await until(async () => {
      const r = await core.read({ jobId: 'hx-mac-00010', taskId: 't-blk' })
      return r.running ? null : r
    })
    expect(ended).toMatchObject({ running: false, blocked: { reason: 'password_prompt', service: 'SecurityAgent' }, timedOut: false })
    expect(ended.output).toBe('waiting\n')
    expect(looks.snapshot).toBeGreaterThan(0)
    // The list names it as blocked too, with its command.
    const { jobs } = await core.list({ taskId: 't-blk' })
    expect(jobs).toMatchObject([{ jobId: 'hx-mac-00010', running: false, blocked: { reason: 'password_prompt' }, command: 'echo waiting; sleep 30', taskId: 't-blk' }])
  })

  it('never watches a job the user agreed may show a dialog, nor one that ends first', async () => {
    const { probe, looks } = dialogProbe()
    const { core } = macHost('allowed', probe)
    await core.run({ jobId: 'hx-mac-00020', taskId: 't-ok', command: 'sleep 0.6; echo done', background: true, allowPrompts: true })
    const ended = await until(async () => {
      const r = await core.read({ jobId: 'hx-mac-00020', taskId: 't-ok', wait: 5_000 })
      return r.running ? null : r
    })
    expect(ended).toMatchObject({ exitCode: 0, output: 'done\n', blocked: null })
    expect(looks.snapshot).toBe(0)
    // A quick job ends before the first look.
    expect(await core.run({ jobId: 'hx-mac-00021', taskId: 't-ok', command: 'echo fast' })).toMatchObject({ exitCode: 0, blocked: null })
    expect(looks.snapshot).toBe(0)
  })
})
