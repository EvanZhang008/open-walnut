/**
 * The manual leader switch with real servers (docs/reference/leader-switch.md): the rehearsal's kill
 * matrix (scripts/leader-switch/rehearsal.ts rehearseKill) as assertions. The switch command is
 * killed at each point and rerun with --resume: it finishes or rolls back, with one leader and
 * everything carried. Real servers on synthetic homes in a temp folder, three local witnesses, the
 * real command. No :3456, no ~/.open-walnut.
 *
 * The scaled permit (tests/helpers/leader-switch-real.ts): a rollback waits the handover out, 6 s
 * here for the product's 60 s. Each case asserts the outcome, which either permit path reaches.
 */
import { describe, it } from 'vitest'
import path from 'node:path'
import { KILL_POINTS, rehearseKill } from '../../scripts/leader-switch/rehearsal.js'
import { failed, portsFrom, realSwitchRoot, useScaledPermit, worldSlots } from '../helpers/leader-switch-real.js'

const root = realSwitchRoot('kill')
const ports = portsFrom(2)
const slot = worldSlots()
/** Two worlds at a time: each scenario keeps its own budget inside its slot (worldSlots); a test's timeout also counts its wait for one. */
const FILE_BUDGET_MS = 900_000
useScaledPermit()

describe('the manual leader switch, real servers: the kill matrix', () => {
  for (const point of KILL_POINTS) {
    it.concurrent(`a kill ${point} is finished or rolled back by --resume, with one leader`, async ({ expect }) => {
      const c = await slot(300_000, () => rehearseKill(path.join(root, `kill-${point}`), point, () => {}, ports()))
      expect(failed(c.all)).toEqual([])
    }, FILE_BUDGET_MS)
  }
})
