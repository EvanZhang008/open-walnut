/**
 * The daemon update stores (src/providers/daemon-update-store.ts) keep finding the entries an older
 * build wrote under the data dir's own id (WALNUT_HOME/local/machine-id) once they key by the
 * stable machine id, also when the stable id was made first by another process from another seed
 * (a daemon of another dir, a second data dir): a custom data dir's holds and stop records are
 * never orphaned (A3b review finding 5).
 *
 * MACHINE SAFETY: the data dir is this file's temp WALNUT_HOME (mocked constants), the account's
 * home a temp dir (setMachineIdHomeForTest), and every store file is named by its env var there.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('update-store-legacy-id'))

import { WALNUT_HOME } from '../../src/constants.js'
import { legacyMachineIdFile, machineIdFile, readMachineId, setMachineIdHomeForTest } from '../../src/core/machine-id.js'
import { pendingReplaces, updateStoreFile, updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { buildBackedOff, readBuildBackoff } from '../../src/providers/daemon-build-backoff.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-store-legacy-')))
const OLD = 'c'.repeat(32)
const STABLE = 'a'.repeat(32)
let n = 0

beforeEach(() => {
  const home = path.join(root, `home-${n++}`)
  fs.mkdirSync(home)
  setMachineIdHomeForTest(home)
  // The older build's id, in the custom data dir (not ~/.open-walnut).
  fs.mkdirSync(path.dirname(legacyMachineIdFile()), { recursive: true })
  fs.writeFileSync(legacyMachineIdFile(), `${OLD}\n`)
  process.env.WALNUT_UPDATE_PENDING_FILE = updateStoreFile('daemon-update-pending.json')
  process.env.WALNUT_BUILD_BACKOFF_FILE = updateStoreFile('daemon-build-backoff.json')
})
afterEach(() => {
  setMachineIdHomeForTest(null)
  delete process.env.WALNUT_UPDATE_PENDING_FILE
  delete process.env.WALNUT_BUILD_BACKOFF_FILE
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** Another process made the stable id first, from a seed other than this data dir's. */
function stableMadeElsewhere(): void {
  fs.mkdirSync(path.dirname(machineIdFile()), { recursive: true })
  fs.writeFileSync(machineIdFile(), `${STABLE}\n`)
}

const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

describe('an update store an older build wrote under the data dir\'s id', () => {
  it('keeps its hold and its stop record when the stable id differs, and moves them under it', async () => {
    expect(path.dirname(legacyMachineIdFile())).toBe(path.join(WALNUT_HOME, 'local'))
    stableMadeElsewhere()
    expect(await readMachineId()).toBe(STABLE)
    const at = Date.now()
    const stop = { at, dir: '/tmp/open-walnut', expected: 'b2', previous: { runtime: 'bun', bunPath: '/opt/bun' } }
    const hold = { expected: 'b2', at, reason: 'it did not stay' }
    fs.writeFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, JSON.stringify({ [`${OLD}|ssh:devbox`]: stop }))
    fs.writeFileSync(process.env.WALNUT_BUILD_BACKOFF_FILE!, JSON.stringify({ [`${OLD}|ssh:devbox`]: hold }))

    expect(await pendingReplaces.read('ssh:devbox')).toEqual(stop)
    const kept = await readBuildBackoff('ssh:devbox')
    expect(kept).toEqual(hold)
    expect(buildBackedOff(kept, 'b2')).toBe(true)
    await updateStoresSettled()
    // Moved under the stable id, the old key gone; read again from there.
    expect(read(process.env.WALNUT_UPDATE_PENDING_FILE!)).toEqual({ [`${STABLE}|ssh:devbox`]: stop })
    expect(read(process.env.WALNUT_BUILD_BACKOFF_FILE!)).toEqual({ [`${STABLE}|ssh:devbox`]: hold })
    expect(await pendingReplaces.read('ssh:devbox')).toEqual(stop)
    // The older id file is only read, never changed.
    expect(fs.readFileSync(legacyMachineIdFile(), 'utf8').trim()).toBe(OLD)
  })

  it('of an entry under the stable id and one under the older id, the newer counts', async () => {
    stableMadeElsewhere()
    const at = Date.now()
    const mine = { at: at - 60_000, dir: '/d', expected: 'b1', previous: null }
    const older = { at, dir: '/d', expected: 'b2', previous: null }
    fs.writeFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, JSON.stringify({ [`${STABLE}|local:/d`]: mine, [`${OLD}|local:/d`]: older }))
    expect(await pendingReplaces.read('local:/d')).toEqual(older)
    await updateStoresSettled()
    expect(read(process.env.WALNUT_UPDATE_PENDING_FILE!)).toEqual({ [`${STABLE}|local:/d`]: older })
  })

  it('a missing stable id is seeded from the custom data dir\'s id, so the entries stay under their key', async () => {
    const at = Date.now()
    const stop = { at, dir: '/d', expected: 'b1', previous: null }
    fs.writeFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, JSON.stringify({ [`${OLD}|local:/d`]: stop }))
    expect(await readMachineId()).toBe(OLD)
    expect(await pendingReplaces.read('local:/d')).toEqual(stop)
    await updateStoresSettled()
    expect(read(process.env.WALNUT_UPDATE_PENDING_FILE!)).toEqual({ [`${OLD}|local:/d`]: stop })
  })

  it('another machine\'s older id is not this one\'s: its entry is not read', async () => {
    stableMadeElsewhere()
    fs.writeFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, JSON.stringify({ [`${'e'.repeat(32)}|local:/d`]: { at: Date.now(), dir: '/d', expected: 'b1', previous: null } }))
    expect(await pendingReplaces.read('local:/d')).toBeNull()
  })
})
