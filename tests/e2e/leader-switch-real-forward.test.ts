/**
 * The manual leader switch with real servers (docs/reference/leader-switch.md): the rehearsal's
 * scenarios of a switch that goes forward, and of the experiment off or without witnesses
 * (scripts/leader-switch/rehearsal.ts, stop-rehearsal.ts) as assertions. Real servers on synthetic
 * homes in a temp folder, three local witnesses, the real `walnut leader switch` command. No :3456,
 * no ~/.open-walnut. The product's permit clocks: each switch here commits inside the handover's
 * lease, as the product does.
 *
 * The other scenarios are in the leader-switch-real-*.test.ts files (tests/helpers/leader-switch-real.ts).
 */
import { describe, it } from 'vitest'
import path from 'node:path'
import { rehearseLateWriter, rehearseLauncherRace } from '../../scripts/leader-switch/stop-rehearsal.js'
import { rehearseFlagOff, rehearseHomePrefix, rehearseLedgerControl, rehearseNoWitnesses } from '../../scripts/leader-switch/rehearsal.js'
import { failed, portsFrom, realSwitchRoot, worldSlots } from '../helpers/leader-switch-real.js'

const root = realSwitchRoot('forward')
const ports = portsFrom(1)
const slot = worldSlots()
/** Two worlds at a time: each scenario keeps its own budget inside its slot (worldSlots); a test's timeout also counts its wait for one. */
const FILE_BUDGET_MS = 900_000

describe('the manual leader switch, real servers: switches that go forward', () => {
  it.concurrent('a home moved to another HOME prefix: its own places name the new home, settings the new account, a repo stays where the work is, and no old path is left', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseHomePrefix(path.join(root, 'home-prefix'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('control: without the ledger rewrite the old leader\'s ops apply again on the new one', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseLedgerControl(path.join(root, 'ledger'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('a writer after the old leader\'s first final batch reaches B; the old home names B\'s door; --status reads the switch on both machines', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseLateWriter(path.join(root, 'late-writer'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('a launcher that restarts the home during the switch back waits and never leads until the switch settled', async ({ expect }) => {
    const c = await slot(500_000, () => rehearseLauncherRace(path.join(root, 'launcher-race'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('with the experiment off nothing of it runs', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseFlagOff(path.join(root, 'flag-off'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)

  it.concurrent('with the experiment on and no witnesses set up (every_experiment), nothing of the permit is loaded', async ({ expect }) => {
    const c = await slot(300_000, () => rehearseNoWitnesses(path.join(root, 'no-witnesses'), () => {}, ports()))
    expect(failed(c.all)).toEqual([])
  }, FILE_BUDGET_MS)
})
