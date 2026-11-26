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
import { Checks, caughtUpBeforeSwitch, catchUpBoundMs, switchOnCaughtUp, untilCaughtUp, type CaughtUp } from '../../scripts/leader-switch/rehearsal.js'
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
    const since = Date.now() - 5_000
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

  // Review round 1, minor 5: a log line is written a little after its batch ended, so end - totalMs is a little late.
  it('a batch that began just before the writes is not counted as begun after them (the log line\'s slack)', async () => {
    const { m, standby, log } = await world()
    const since = Date.now() - 10_000
    // end - totalMs is 200 ms after `since`, but the line was written after the batch ended: it may have begun before.
    log(1, since + 4_200, 4_000)
    expect((await untilCaughtUp(m, standby, { since, boundMs: 0 })).ok).toBe(false)
    log(1, since + 6_000, 4_000)
    expect((await untilCaughtUp(m, standby, { since, boundMs: 0 })).ok).toBe(true)
  })

  // Review round 1, M2: a preflight that refuses a standby the rehearsal saw caught up is the switch's failure, not
  // "the standby did not catch up, no switch was tried"; only a wait that runs out is the standby's.
  describe('who failed: the standby or the switch', () => {
    const seen = { ok: true as const, batch: 7, batchMs: 3_000, waitedMs: 0 }
    const refusal = { code: 1, out: 'leader: the standby on machine-b is not caught up, so the final batch would not fit in the commit window: ...' }
    const ok = (batch: number): CaughtUp => ({ ok: true, batch, batchMs: 2_000, waitedMs: 10 })

    it('refused once, caught up again, switched: the switch ran', async () => {
      let n = 0
      const r = await switchOnCaughtUp({ seen, trySwitch: async () => (++n === 1 ? refusal : { code: 0, out: 'Switched' }), waitAgain: async () => ok(8), deadline: Date.now() + 60_000 })
      expect(r).toMatchObject({ kind: 'ran', refused: 1, r: { code: 0 } })
    })

    it('refused after each time the rehearsal saw it caught up: the switch failed, naming the batch it saw', async () => {
      const waits: number[] = []
      const r = await switchOnCaughtUp({ seen, trySwitch: async () => refusal, waitAgain: async (ms) => { waits.push(ms); return ok(8) }, deadline: Date.now() + 60_000 })
      expect(r.kind).toBe('refused-after-caught-up')
      expect(r.refused).toBe(2)
      expect(waits).toHaveLength(1)
      const why = r.kind === 'ran' ? '' : r.why
      expect(why).toMatch(/the rehearsal saw the standby caught up \(batch 8, 2\.0 s\) and the switch's preflight still refused it as not caught up, 2 time\(s\)/)
      expect(why).not.toMatch(/^standby not caught up/)
    })

    it('refused, then the standby never caught up again within the bound: the standby\'s failure', async () => {
      const r = await switchOnCaughtUp({ seen, trySwitch: async () => refusal, waitAgain: async () => ({ ok: false, why: 'standby not caught up: within 0.0 s ...', waitedMs: 0 }), deadline: Date.now() })
      expect(r.kind).toBe('not-caught-up')
      expect(r.kind === 'ran' ? '' : r.why).toMatch(/then standby not caught up: within 0\.0 s/)
    })

    it('any other refusal or failure is the switch\'s own result, never retried', async () => {
      let n = 0
      const r = await switchOnCaughtUp({ seen, trySwitch: async () => { n++; return { code: 1, out: 'leader: only 1 of 3 witnesses answered' } }, waitAgain: async () => ok(9), deadline: Date.now() + 60_000 })
      expect(r).toMatchObject({ kind: 'ran', refused: 0 })
      expect(n).toBe(1)
    })
  })

  it('the bound grows with the home: 180 s small, 30 min or 3 min per GB with filler', () => {
    expect(catchUpBoundMs()).toBe(180_000)
    expect(catchUpBoundMs(1)).toBe(1_800_000)
    expect(catchUpBoundMs(20)).toBe(3_600_000)
  })
})
