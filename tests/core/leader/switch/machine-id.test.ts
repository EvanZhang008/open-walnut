/**
 * The permit's holder id is the machine's one stable id (src/core/machine-id.ts); the named file
 * of WALNUT_MACHINE_ID_FILE (the one-machine rehearsal) is read as it is and never made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { machineIdFile as stableFile, readMachineIdSync, setMachineIdHomeForTest } from '../../../../src/core/machine-id.js'
import { machineIdFile, permitHolderId } from '../../../../src/core/leader/switch/machine-id.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-machine-id-')); setMachineIdHomeForTest(dir) })
afterEach(() => { setMachineIdHomeForTest(null); fs.rmSync(dir, { recursive: true, force: true }) })

describe('the permit holder id', () => {
  it('is the stable machine id, from its one file', () => {
    expect(permitHolderId({})).toBe(readMachineIdSync())
    expect(machineIdFile({})).toBe(stableFile())
    expect(fs.readFileSync(stableFile(), 'utf8').trim()).toBe(permitHolderId({}))
  })

  it('reads a named file as it is, and never makes one', () => {
    const named = path.join(dir, 'machine-a-id')
    expect(permitHolderId({ WALNUT_MACHINE_ID_FILE: named })).toBeNull()
    expect(fs.existsSync(named)).toBe(false)
    fs.writeFileSync(named, 'machine-a\n')
    expect(permitHolderId({ WALNUT_MACHINE_ID_FILE: named })).toBe('machine-a')
    expect(machineIdFile({ WALNUT_MACHINE_ID_FILE: named })).toBe(named)
  })
})
