/**
 * `walnut daemon handback` (src/providers/daemon-service-handback.ts): a stand-in daemon an
 * update's tail started outside launchd hands its sessions to the LaunchAgent's own job the way a
 * service daemon hands over before an update, never by a signal. 2026-11-04 review: the stand-in
 * loop sent it SIGTERM, which cut the ACP turns, host_exec runs and relays the update path waits for.
 *
 * MACHINE SAFETY: every step is a fake; the runtime dir is this file's temp dir; no process is
 * signalled or started.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handBackStandIn, type HandbackDeps } from '../../src/providers/daemon-service-handback.js'
import type { LaunchdSpawn } from '../../src/providers/daemon-service-launchd.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-handback-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let runtimeDir: string
beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(root, 'rt-'))
  fs.writeFileSync(path.join(runtimeDir, 'daemon.pid'), '4242\n')
  fs.writeFileSync(path.join(runtimeDir, 'daemon.standin'), '4242\n')
  fs.writeFileSync(path.join(runtimeDir, 'daemon.instance'), 'inst-standin\n')
})

function deps(over: Partial<HandbackDeps> & { spawn?: LaunchdSpawn; runs?: number } = {}): HandbackDeps & { steps: string[] } {
  const steps: string[] = []
  return {
    steps,
    platform: 'darwin', runtimeDir,
    ours: async () => { steps.push('ours'); return true },
    spawns: async () => { steps.push('spawns'); return over.spawn ?? 'ok' },
    job: async () => { steps.push('job'); return { runs: over.runs ?? 0 } },
    prepareUpdate: async () => { steps.push('prepareUpdate') },
    kickstart: async () => { steps.push('kickstart') },
    ready: async (previous) => { steps.push(`ready ${previous}`); return true },
    alive: (pid) => pid === 4242,
    ...over,
  }
}

describe('the stand-in hands back to launchd\'s job', () => {
  it('asks the stand-in to hand over (service.update), then starts launchd\'s job and waits for a daemon other than the stand-in', async () => {
    const d = deps()
    await expect(handBackStandIn(d)).resolves.toEqual({ ok: true, message: "the stand-in handed over, and launchd's job serves" })
    expect(d.steps).toEqual(['ours', 'job', 'spawns', 'prepareUpdate', 'kickstart', 'ready inst-standin'])
    expect(fs.existsSync(path.join(runtimeDir, 'daemon.standin'))).toBe(false)
  })

  it('a stand-in with work open refuses: nothing else is done, and it keeps serving', async () => {
    const d = deps({ prepareUpdate: async () => { throw new Error('Daemon has active operations; retry after they finish') } })
    const result = await handBackStandIn(d)
    expect(result).toMatchObject({ ok: false, failure: { code: 'updateRefused', message: 'the stand-in keeps serving: Daemon has active operations; retry after they finish' } })
    expect(d.steps).not.toContain('kickstart')
    expect(fs.existsSync(path.join(runtimeDir, 'daemon.standin'))).toBe(true)
  })

  it.each([['none', /launchd is starting no jobs/], ['unknown', /launchd gave no answer whether it starts jobs now/]] as const)(
    'launchd that starts %s jobs touches nothing', async (spawn, words) => {
      const d = deps({ spawn })
      const result = await handBackStandIn(d)
      expect(result).toMatchObject({ ok: false, failure: { code: 'launchdNotSpawning', message: expect.stringMatching(words) } })
      expect(d.steps).toEqual(['ours', 'job', 'spawns'])
    })

  it('a probe with no answer goes ahead once launchd has run the job (it keeps trying to start it beside the stand-in), never when it starts none', async () => {
    // 2026-11-04 review: an unknown probe deferred every handback, so a host whose probe never answers kept the stand-in for good.
    const ran = deps({ spawn: 'unknown', runs: 3 })
    await expect(handBackStandIn(ran)).resolves.toMatchObject({ ok: true })
    expect(ran.steps).toContain('kickstart')
    fs.writeFileSync(path.join(runtimeDir, 'daemon.standin'), '4242\n')
    const none = deps({ spawn: 'none', runs: 3 })
    await expect(handBackStandIn(none)).resolves.toMatchObject({ ok: false, failure: { code: 'launchdNotSpawning' } })
  })

  it('with no job of the service loaded, the stand-in is not stopped (loading one here would start a second daemon beside it)', async () => {
    const d = deps({ job: async () => null })
    const result = await handBackStandIn(d)
    expect(result).toMatchObject({ ok: false, failure: { code: 'notLoaded' } })
    expect(d.steps).not.toContain('prepareUpdate')
  })

  it('no stand-in, or a daemon that is not the stand-in serving: nothing is touched', async () => {
    fs.writeFileSync(path.join(runtimeDir, 'daemon.pid'), '5555\n')
    const other = deps({ alive: () => true })
    expect(await handBackStandIn(other)).toMatchObject({ ok: false, failure: { code: 'noStandIn' } })
    expect(other.steps).toEqual(['ours'])
    fs.rmSync(path.join(runtimeDir, 'daemon.standin'))
    expect(await handBackStandIn(deps())).toMatchObject({ ok: false, failure: { code: 'noStandIn' } })
    const dead = deps({ alive: () => false })
    fs.writeFileSync(path.join(runtimeDir, 'daemon.standin'), '5555\n')
    expect(await handBackStandIn(dead)).toMatchObject({ ok: false, failure: { code: 'noStandIn' } })
  })

  it('a job that does not answer after the handover says so, and leaves the restart to the stand-in loop', async () => {
    const d = deps({ ready: async () => false })
    expect(await handBackStandIn(d)).toMatchObject({ ok: false, failure: { code: 'notReady' } })
  })

  it('only on a Mac, and only for a LaunchAgent of Walnut\'s', async () => {
    expect(await handBackStandIn(deps({ platform: 'linux' }))).toMatchObject({ ok: false, failure: { code: 'unsupported' } })
    expect(await handBackStandIn(deps({ ours: async () => false }))).toMatchObject({ ok: false, failure: { code: 'notInstalled' } })
  })
})
