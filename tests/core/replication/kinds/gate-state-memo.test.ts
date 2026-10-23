/**
 * The off flag and the copy's clock are kept in memory (kinds/gate.ts stateOf): a state file
 * is parsed again only after a write to it, whoever wrote it, never on every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-gate-state-memo'))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { copyKindAsOf, copyKindOff, copyStateFile, markCopyOff } from '../../../../src/core/replication/kinds/gate.js'
import { writeCopyFile } from '../../../../src/core/replication/kind-follower.js'

beforeEach(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }) })
afterEach(() => { vi.restoreAllMocks() })

describe('copyKindOff / copyKindAsOf', () => {
  it('parse a state file once per write, and see every new write', async () => {
    const reads = vi.spyOn(fsp, 'readFile')
    const parsed = () => reads.mock.calls.filter(([f]) => f === copyStateFile('prefs')).length
    expect([await copyKindOff('prefs'), await copyKindAsOf('prefs')]).toEqual([false, null])
    expect(parsed()).toBe(0)
    await writeCopyFile(copyStateFile('prefs'), { v: 1, hashes: { a: 'h1' }, asOf: 1234 })
    for (let i = 0; i < 50; i++) expect([await copyKindOff('prefs'), await copyKindAsOf('prefs')]).toEqual([false, 1234])
    expect(parsed()).toBe(1)
    await markCopyOff('prefs', 2000)
    expect([await copyKindOff('prefs'), await copyKindAsOf('prefs')]).toEqual([true, null])
    expect(await copyKindOff('prefs')).toBe(true)
    expect(parsed()).toBe(2)
    // Another writer of the file (a restarted process, a hand edit) is seen too.
    await fsp.writeFile(copyStateFile('prefs'), JSON.stringify({ v: 1, hashes: {}, asOf: 99, pad: 'x'.repeat(40) }))
    expect([await copyKindOff('prefs'), await copyKindAsOf('prefs')]).toEqual([false, 99])
    // Removed: nothing held, nothing off.
    await fsp.rm(copyStateFile('prefs'))
    expect([await copyKindOff('prefs'), await copyKindAsOf('prefs')]).toEqual([false, null])
  })

  it('an unreadable file is neither off nor held', async () => {
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    await writeCopyFile(copyStateFile('inbox'), { v: 1, off: true, at: 1 })
    await fsp.writeFile(copyStateFile('inbox'), '{ not json')
    expect([await copyKindOff('inbox'), await copyKindAsOf('inbox')]).toEqual([false, null])
  })
})
