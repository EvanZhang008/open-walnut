/**
 * An ephemeral server (a test run on a copy of the data, `--_ephemeral-child`) never declares a
 * home move, a leader switch's included, even with a promotion record and a permit that leads:
 * it may reach its own local daemon, and a declaration there would move the real Walnut's state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../../helpers/mock-constants.js')
  return createMockConstants('walnut-moved-home-ephemeral', { IS_EPHEMERAL: true })
})
vi.mock('../../../../src/core/leader/switch/boot.js', () => ({
  currentLeaderPermit: () => ({ machine: 'machine-b', trial: false, runtime: { status: () => ({ state: 'leading', record: { number: 8, holder: 'machine-b' } }) } }),
}))

import { IS_EPHEMERAL, WALNUT_HOME } from '../../../../src/constants.js'
import { homeMoveToDeclare, homeRecordFile, resetHomeMoveForTests, settledHomeMove } from '../../../../src/core/home-move.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { writePromoted } from '../../../../src/core/leader/switch/records.js'

afterEach(async () => {
  await resetHomeMoveForTests()
  setOutwardDoorChecker(null)
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
})

describe('an ephemeral server and a leader switch', () => {
  it('declares nothing and waits on nothing, with a led promotion record and a leading permit', async () => {
    expect(IS_EPHEMERAL).toBe(true)
    setOutwardDoorChecker(() => {}, () => true)
    writePromoted(WALNUT_HOME, { switchId: 's1', state: 'led', from: '/srv/a/walnut', to: 'machine-b', handover: 7, fromHomeOnHosts: '/srv/a/walnut', fromFormerHomes: [], at: new Date().toISOString() })
    expect(settledHomeMove()).toBeNull()
    expect(await homeMoveToDeclare()).toBeNull()
    expect(fs.existsSync(homeRecordFile(WALNUT_HOME)), 'no record judged').toBe(false)
  })
})
