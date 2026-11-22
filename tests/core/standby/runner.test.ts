/**
 * The periodic standby (src/core/standby/runner.ts): off, it runs nothing, opens no write gate
 * and writes no file; on (with a target folder), it takes batches, opens the gate, sends a
 * drift report to Walnut Health once, and stops cleanly when the flag goes off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startStandbyRunner, type StandbySettings, type StandbyRunner } from '../../../src/core/standby/runner.js'
import { standbyStatus } from '../../../src/core/standby/index.js'
import { writeGateEnabled } from '../../../src/utils/write-gate.js'
import { sandbox, seedHome, walk, type Sandbox } from './helpers.js'
import { fakeStandbyHost } from './fake-standby-host.js'

let sb: Sandbox
let runner: StandbyRunner | null = null
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  runner?.stop()
  runner = null
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})

describe('standby runner', () => {
  it('off: no timer, no gate, no file anywhere', async () => {
    sb = await sandbox('off')
    dbs.push(...seedHome(sb.home).dbs)
    const before = walk(sb.root)
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const settings = vi.fn(async (): Promise<StandbySettings> => ({ on: false, home: sb.home, dir: sb.target, intervalSeconds: 5 }))
    runner = startStandbyRunner({ settings, notify: async () => true })
    await runner.reconcile()
    expect(settings).toHaveBeenCalled()
    expect(runner.running()).toBe(false)
    expect(writeGateEnabled()).toBe(false)
    expect(await runner.runOnce()).toBeNull()
    expect(setTimer.mock.calls.filter(([, ms]) => ms === 5000)).toEqual([])
    setTimer.mockRestore()
    expect(walk(sb.root)).toEqual(before)
  })

  it('on without a target folder: still nothing runs', async () => {
    sb = await sandbox('nodir')
    runner = startStandbyRunner({ settings: async () => ({ on: true, home: sb.home, intervalSeconds: 30 }), notify: async () => true })
    await runner.reconcile()
    expect(runner.running()).toBe(false)
    expect(writeGateEnabled()).toBe(false)
  })

  it('on: batches run, the gate is open, drift goes to Health once; off again: all stops', async () => {
    sb = await sandbox('on')
    dbs.push(...seedHome(sb.home).dbs)
    let on = true
    const notices: Array<{ title: string; dedupScope: string }> = []
    runner = startStandbyRunner({
      settings: async () => ({ on, home: sb.home, dir: sb.target, intervalSeconds: 3600 }),
      notify: async (n) => { notices.push(n); return true },
    })
    await runner.reconcile()
    expect(runner.running()).toBe(true)
    expect(writeGateEnabled()).toBe(true)
    const first = await runner.runOnce()
    expect(first?.ok, first && !first.ok ? first.reason : '').toBe(true)
    expect((await standbyStatus(sb.target)).batch).toBeGreaterThanOrEqual(1)

    const file = path.join(sb.target, 'copy', 'memory/MEMORY.md')
    fs.chmodSync(path.dirname(file), 0o755)
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, 'edited on the standby\n')
    await runner.runOnce()
    await runner.runOnce()
    const drift = notices.filter((n) => n.title.includes('changed there directly'))
    expect(drift).toHaveLength(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('# Memory\n')

    on = false
    await runner.reconcile()
    expect(runner.running()).toBe(false)
    expect(writeGateEnabled()).toBe(false)
  }, 60_000)

  it('on with a standby host: batches go there through its link, its drift goes to Health once', async () => {
    sb = await sandbox('on-remote')
    dbs.push(...seedHome(sb.home).dbs)
    const host = fakeStandbyHost(sb.root)
    const hosts: string[] = []
    const notices: Array<{ title: string; body: string }> = []
    runner = startStandbyRunner({
      settings: async () => ({ on: true, home: sb.home, dir: sb.target, host: 'standby-box', intervalSeconds: 3600 }),
      notify: async (n) => { notices.push(n); return true },
      connect: async (h) => { hosts.push(h); return host.link },
    })
    await runner.reconcile()
    const first = await runner.runOnce()
    expect(first?.ok, first && !first.ok ? first.reason : '').toBe(true)
    expect(hosts[0]).toBe('standby-box')
    expect((await standbyStatus(sb.target)).batch).toBeGreaterThanOrEqual(1)
    expect(host.log.some((e) => e.cmd === 'receive apply')).toBe(true)

    const file = path.join(sb.target, 'copy', 'memory/MEMORY.md')
    fs.chmodSync(path.dirname(file), 0o755)
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, 'edited on the standby\n')
    await runner.runOnce()
    await runner.runOnce()
    const drift = notices.filter((n) => n.title.includes('changed there directly'))
    expect(drift).toHaveLength(1)
    expect(drift[0].body).toContain(`standby-box:${sb.target}`)
    expect(fs.readFileSync(file, 'utf8')).toBe('# Memory\n')
  }, 60_000)

  it('stopped with chunks still waiting to go to a standby host, it sends nothing more there', async () => {
    sb = await sandbox('remote-stop')
    dbs.push(...seedHome(sb.home).dbs)
    fs.writeFileSync(path.join(sb.home, 'big.bin'), crypto.randomBytes(12 * 1024 * 1024))
    const host = fakeStandbyHost(sb.root)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let started = 0
    const link = { ...host.link, async send(cmd: string, params?: Record<string, unknown>, ms?: number) {
      if (cmd === 'fs.writePart' && String(params?.path).includes('/chunks/')) { started++; await gate }
      return host.link.send(cmd, params, ms)
    } }
    const notices: unknown[] = []
    runner = startStandbyRunner({
      settings: async () => ({ on: true, home: sb.home, dir: sb.target, host: 'standby-box', intervalSeconds: 3600 }),
      notify: async (n) => { notices.push(n); return true },
      connect: async () => link,
    })
    await runner.reconcile()
    const run = runner.runOnce()
    for (let i = 0; i < 200 && started < 8; i++) await new Promise((r) => setTimeout(r, 25))
    expect(started).toBe(8)
    runner.stop()
    runner = null
    release()
    const out = await run
    expect(out?.ok).toBe(false)
    await new Promise((r) => setTimeout(r, 200))
    // Only the parts already on the wire went; no apply, no verify, no notice.
    expect(started).toBe(8)
    expect(host.log.some((e) => e.cmd === 'receive apply' || e.cmd === 'receive verify')).toBe(false)
    expect(notices).toEqual([])
    expect(writeGateEnabled()).toBe(false)
  }, 60_000)

  it('a standby host out of reach is reported behind once, with the last batch known there, without waiting out each step', async () => {
    sb = await sandbox('remote-away')
    dbs.push(...seedHome(sb.home).dbs)
    const host = fakeStandbyHost(sb.root)
    // Each batch attempt reads the target first, into an export of its own.
    const exports = new Set<string>()
    const link = { ...host.link, send(cmd: string, params?: Record<string, unknown>, ms?: number) {
      const args = (params?.args ?? []) as string[]
      if (cmd === 'exec.script' && args.includes('--export')) exports.add(args[args.indexOf('--export') + 1])
      return host.link.send(cmd, params, ms)
    } }
    const notices: Array<{ title: string; body: string }> = []
    runner = startStandbyRunner({
      settings: async () => ({ on: true, home: sb.home, dir: sb.target, host: 'standby-box', intervalSeconds: 3600 }),
      notify: async (n) => { notices.push(n); return true },
      connect: async () => link,
      linkWaitMs: 300,
    })
    await runner.reconcile()
    expect((await runner.runOnce())?.ok).toBe(true)
    host.state.down = true
    const real = Date.now.bind(Date)
    const later = vi.spyOn(Date, 'now').mockImplementation(() => real() + 6 * 60_000)
    try {
      const started = real()
      exports.clear()
      const out = await runner.runOnce()
      expect(out?.ok).toBe(false)
      expect(exports.size).toBe(1)
      // One attempt and no verify or state read over the dead link: a few waits of 300 ms, not minutes.
      expect(real() - started).toBeLessThan(10_000)
      const behind = notices.filter((n) => n.title === 'Standby copy is behind')
      expect(behind).toHaveLength(1)
      expect(behind[0].body).toMatch(/could not be read \(its host is out of reach\); the last batch known there is batch 1/)
      await runner.runOnce()
      expect(notices.filter((n) => n.title === 'Standby copy is behind')).toHaveLength(1)
    } finally {
      later.mockRestore()
    }
  }, 60_000)
})
