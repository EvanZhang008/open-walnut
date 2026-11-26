/**
 * The rehearsals' wait before a switch (scripts/leader-switch/rehearsal.ts untilCaughtUp): a standby is
 * caught up only when a batch of the leader's runner that began after the writes took at most the
 * catch-up's budget AND landed at the copy. Its bound's end says "standby not caught up", with what the
 * standby did, and is a check of its own: never a failed switch.
 *
 * Found by the lead's 20 GB run (2026-11-25): the switch back at 20 Mbit/s was started while the copy back
 * was still sending; its catch-up refused after 300 s and the next try a minute later read as a failed switch.
 * And standby-behind's 180 s wait for one batch threw "timed out waiting for a standby batch" on a 20 GB
 * tracked home, reported as the scenario not running to its end.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Checks, caughtUpBeforeSwitch, catchUpBoundMs, untilCaughtUp } from '../../scripts/leader-switch/rehearsal.js'
import type { Machine } from '../../scripts/leader-switch/world.js'
import { snapshotTo } from '../../src/core/standby/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { return } for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name)) }
    open(d)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** A leader machine with a home, a standby copy of it (batch 1 current), and its server log in its daemon dir. */
async function world(): Promise<{ m: Machine; standby: string; log: (batch: number, endAt: number, totalMs: number) => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-caught-up-'))
  dirs.push(root)
  const home = path.join(root, 'a', 'home')
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(home, 'notes', 'a.md'), 'a\n')
  const standby = path.join(root, 'b', 'standby')
  const out = await snapshotTo(home, standby)
  expect(out.ok, out.ok ? '' : out.reason).toBe(true)
  const daemon = path.join(root, 'a', 'daemon')
  fs.mkdirSync(daemon, { recursive: true })
  const file = path.join(daemon, 'open-walnut-2026-11-26.log')
  const m: Machine = { id: 'machine-a', dir: path.join(root, 'a'), idFile: path.join(root, 'a', 'machine-id'), home, standbyDir: path.join(root, 'a', 'standby'), port: 0, env: { WALNUT_DAEMON_DIR: daemon } }
  const log = (batch: number, endAt: number, totalMs: number) =>
    fs.appendFileSync(file, `${JSON.stringify({ time: new Date(endAt).toISOString(), level: 'info', subsystem: 'session', message: 'standby: batch committed', batch, totalMs, sentBytes: 2 * 1_048_576 })}\n`)
  return { m, standby, log }
}

describe('the rehearsal waits until the standby caught up before a switch', () => {
  it('caught up: a batch begun after the writes, within the budget, that landed at the copy', async () => {
    const { m, standby, log } = await world()
    const since = Date.now() - 60_000
    log(1, Date.now() - 1_000, 4_000)
    const r = await untilCaughtUp(m, standby, { since, boundMs: 0 })
    expect(r).toMatchObject({ ok: true, batch: 1, batchMs: 4_000 })
  })

  it('not caught up: batches over the budget (50 s of the default window), a batch begun before the writes, or one that has not landed', async () => {
    const { m, standby, log } = await world()
    const since = Date.now() - 600_000
    log(1, Date.now() - 5_000, 300_000)
    // Began before `since`: its writes may not be in it.
    log(1, Date.now() - 2_000, 700_000)
    // Fits, but the copy holds batch 1 only.
    log(2, Date.now() - 1_000, 3_000)
    const r = await untilCaughtUp(m, standby, { since, boundMs: 0 })
    expect(r.ok).toBe(false)
    const why = r.ok ? '' : r.why
    expect(why).toMatch(/^standby not caught up: /)
    expect(why).toMatch(/took at most 50\.0 s/)
    expect(why).toMatch(/batch 1 300\.0 s\/2\.0 MB, batch 2 3\.0 s\/2\.0 MB/)
    expect(why).toMatch(/the copy holds batch 1, landed /)
    expect(why).toMatch(/nothing under way there/)
  })

  it('a batch that fits later is waited for within the bound', async () => {
    const { m, standby, log } = await world()
    const since = Date.now() - 1_000
    setTimeout(() => log(1, Date.now(), 500), 300)
    const r = await untilCaughtUp(m, standby, { since, boundMs: 10_000 })
    expect(r.ok).toBe(true)
  })

  it('as a check: a FAIL named for the standby, never for the switch, and no switch tried', async () => {
    const { m, standby } = await world()
    const c = new Checks()
    const ok = await caughtUpBeforeSwitch(c, 'kill after-handover', m, standby, { boundMs: 0 })
    expect(ok).toBe(false)
    expect(c.all).toHaveLength(1)
    expect(c.all[0]!.name).toBe('kill after-handover: the standby caught up before the switch (no switch was tried)')
    expect(c.all[0]!.detail).toMatch(/^standby not caught up: /)
  })

  it('the bound grows with the home: 180 s small, 30 min or 3 min per GB with filler', () => {
    expect(catchUpBoundMs()).toBe(180_000)
    expect(catchUpBoundMs(1)).toBe(1_800_000)
    expect(catchUpBoundMs(20)).toBe(3_600_000)
  })
})
