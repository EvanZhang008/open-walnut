/**
 * The manual leader switch with real servers (docs/reference/leader-switch.md): the
 * rehearsal's scenarios (scripts/leader-switch/rehearsal.ts) as assertions. Each scenario
 * runs two real servers as their own processes on synthetic homes in a temp folder, three
 * local witnesses, and the real `walnut leader switch` command. No :3456, no ~/.open-walnut.
 *
 * The whole kill matrix (six points) and the three trial failures run here; the rehearsal
 * script runs the same with one line per check.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KILL_POINTS, TRIAL_FAILURES, rehearseCancel, rehearseCancelAfterCommit, rehearseFlagOff, rehearseHomePrefix, rehearseNoWitnesses, rehearseRestart, rehearseKill, rehearseLedgerControl, rehearseSwitchAndBack, rehearseTrialFailure, type Check } from '../../scripts/leader-switch/rehearsal.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-switch-e2e-'))
afterAll(() => {
  const open = (p: string) => {
    try { fs.chmodSync(p, 0o700); if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) open(path.join(p, e)) } catch { /* gone */ }
  }
  open(root)
  fs.rmSync(root, { recursive: true, force: true })
})

let port = 4950 + (process.pid % 20) * 4
const ports = () => { port += 2; return { portA: port, portB: port + 1 } }
const failed = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)

describe('the manual leader switch, real servers', () => {
  it('switches under load, keeps every acknowledged write, never has two leaders, keeps the old home as a standby that leads nothing and changes nothing (witnesses online and unreachable), and switches back with A leading again', async () => {
    const r = await rehearseSwitchAndBack(path.join(root, 'main'), () => {}, ports())
    expect(failed(r.checks.all)).toEqual([])
    expect(r.checks.all.length).toBeGreaterThan(20)
    expect(r.downtimeMs).toBeGreaterThan(0)
  }, 600_000)

  it('a home moved to another HOME prefix: its own places name the new home, settings the new account, a repo stays where the work is, and no old path is left', async () => {
    const c = await rehearseHomePrefix(path.join(root, 'home-prefix'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)

  it('control: without the ledger rewrite the old leader\'s ops apply again on the new one', async () => {
    const c = await rehearseLedgerControl(path.join(root, 'ledger'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)

  for (const point of KILL_POINTS) {
    it(`a kill ${point} is finished or rolled back by --resume, with one leader`, async () => {
      const c = await rehearseKill(path.join(root, `kill-${point}`), point, () => {}, ports())
      expect(failed(c.all)).toEqual([])
    }, 300_000)
  }

  it('a switch killed after its commit stood and then cancelled by hand goes forward: B leads', async () => {
    const c = await rehearseCancelAfterCommit(path.join(root, 'cancel-after-commit'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)

  it('a switch cut off after its handover and cancelled by hand gives A its permission back', async () => {
    const c = await rehearseCancel(path.join(root, 'cancel'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)

  for (const kind of TRIAL_FAILURES) {
    it(`a trial that finds ${kind} cancels, and the old leader leads with everything`, async () => {
      const c = await rehearseTrialFailure(path.join(root, `trial-${kind}`), kind, () => {}, ports())
      expect(failed(c.all)).toEqual([])
    }, 300_000)
  }

  it('with the experiment off nothing of it runs', async () => {
    const c = await rehearseFlagOff(path.join(root, 'flag-off'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)

  it('a planned restart closes the doors for seconds, a crash until the record runs out; a routine slot due meanwhile fires once', async () => {
    const c = await rehearseRestart(path.join(root, 'restarts'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 400_000)

  it('with the experiment on and no witnesses set up (every_experiment), nothing of the permit is loaded', async () => {
    const c = await rehearseNoWitnesses(path.join(root, 'no-witnesses'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 300_000)
})
