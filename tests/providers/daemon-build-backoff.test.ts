/**
 * The day-long backoff of a build that did not stay serving, kept across server restarts
 * (src/providers/daemon-build-backoff.ts). 2026-11-04 review: it lived in memory, so every deploy
 * let the next connect stop the healthy daemon for the same failing build again.
 *
 * MACHINE SAFETY: the file is this file's temp file (WALNUT_BUILD_BACKOFF_FILE); nothing runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUILD_BACKOFF_MS, buildBackedOff, buildBackoffSettled, readBuildBackoff, writeBuildBackoff } from '../../src/providers/daemon-build-backoff.js'
import { resetUpdateStoreMachineIdsForTest, updateStoreMachineId } from '../../src/providers/daemon-update-store.js'
import { WALNUT_HOME } from '../../src/constants.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-build-backoff-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
afterEach(() => { delete process.env.WALNUT_BUILD_BACKOFF_FILE })
/** This machine's key for a place (daemon-update-store.ts: its machine id, kept in the data home's local dir). */
let id = ''
beforeAll(async () => { id = (await updateStoreMachineId())! })
const mine = (key: string) => `${id}|${key}`

describe('the kept build backoff', () => {
  it('is read back by a later process (the same file), per place, until a newer build or a day', async () => {
    const file = path.join(root, 'a.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    const at = Date.now()
    void writeBuildBackoff('ssh:devbox', { expected: 'b1', at, reason: 'it did not start' })
    await buildBackoffSettled()
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    const kept = await readBuildBackoff('ssh:devbox')
    expect(kept).toEqual({ expected: 'b1', at, reason: 'it did not start' })
    expect(await readBuildBackoff('ssh:other')).toBeNull()
    expect(buildBackedOff(kept, 'b1')).toBe(true)
    expect(buildBackedOff(kept, 'b2')).toBe(false)
    expect(buildBackedOff(kept, 'b1', at + BUILD_BACKOFF_MS + 1)).toBe(false)
    // Wall clock: a clock set back does not stretch it past a day either.
    expect(buildBackedOff(kept, 'b1', at - BUILD_BACKOFF_MS - 1)).toBe(false)
    void writeBuildBackoff('ssh:devbox', null)
    await buildBackoffSettled()
    expect(await readBuildBackoff('ssh:devbox')).toBeNull()
  })

  it('drops entries past their day on the next write, and survives a broken file', async () => {
    const file = path.join(root, 'b.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    fs.writeFileSync(file, JSON.stringify({ [mine('local:/x')]: { expected: 'old', at: Date.now() - BUILD_BACKOFF_MS - 5, reason: '' } }))
    void writeBuildBackoff('net:mac', { expected: 'b1', at: Date.now(), reason: '' })
    await buildBackoffSettled()
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([mine('net:mac')])
    fs.writeFileSync(file, '{ not json')
    expect(await readBuildBackoff('net:mac')).toBeNull()
  })

  it('keeps how the build that ran before was started again, and drops a malformed one', async () => {
    const file = path.join(root, 'c.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    const at = Date.now()
    void writeBuildBackoff('ssh:devbox', { expected: 'b1', at, reason: '', previous: { runtime: 'bun', bunPath: '/opt/bun' } })
    await buildBackoffSettled()
    expect(await readBuildBackoff('ssh:devbox')).toEqual({ expected: 'b1', at, reason: '', previous: { runtime: 'bun', bunPath: '/opt/bun' } })
    fs.writeFileSync(file, JSON.stringify({ [mine('ssh:devbox')]: { expected: 'b1', at, reason: '', previous: { runtime: 7 } } }))
    expect(await readBuildBackoff('ssh:devbox')).toEqual({ expected: 'b1', at, reason: '' })
  })

  // 2026-11-04 review: one file for every machine that has the data home (a copy, a sync) made
  // one machine's day off hold a good build on another with the same daemon dir.
  it('holds only on the machine that wrote it: another machine\'s entry under the same place is not read', async () => {
    const file = path.join(root, 'd.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    fs.writeFileSync(file, JSON.stringify({ 'other-mac|local:/tmp/open-walnut': { expected: 'b1', at: Date.now(), reason: 'it did not start there' } }))
    expect(await readBuildBackoff('local:/tmp/open-walnut')).toBeNull()
    void writeBuildBackoff('local:/tmp/open-walnut', { expected: 'b1', at: Date.now(), reason: 'here' })
    await buildBackoffSettled()
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort()).toEqual([mine('local:/tmp/open-walnut'), 'other-mac|local:/tmp/open-walnut'].sort())
  })

  // 2026-11-04 review 4: the key was os.hostname(), which on a Mac with no HostName set follows
  // the network (DHCP, a VPN): a laptop that moved lost every hold and every stop record.
  it('is keyed by a machine id made once and kept in the data home, not by the host name, which may change', async () => {
    const file = path.join(root, 'e.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'local', 'machine-id'), 'utf8').trim()).toBe(id)
    // Never beside a store file a test names (os.tmpdir() there, 2026-11-04 review 5).
    expect(fs.existsSync(path.join(root, 'machine-id'))).toBe(false)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const at = Date.now()
    void writeBuildBackoff('local:/tmp/open-walnut', { expected: 'b1', at, reason: 'it did not stay' })
    await buildBackoffSettled()
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([mine('local:/tmp/open-walnut')])
    const named = vi.spyOn(os, 'hostname').mockReturnValue('Someones-MacBook-Pro.vpn.example')
    try {
      expect(await readBuildBackoff('local:/tmp/open-walnut')).toEqual({ expected: 'b1', at, reason: 'it did not stay' })
    } finally { named.mockRestore() }
    // Two processes that start at the same time agree on the id (made once), and a later one reads it.
    const other = path.join(root, 'twin')
    resetUpdateStoreMachineIdsForTest()
    const first = updateStoreMachineId(other)
    resetUpdateStoreMachineIdsForTest()
    const second = updateStoreMachineId(other)
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).toBe(a)
    resetUpdateStoreMachineIdsForTest()
    expect(await updateStoreMachineId(other)).toBe(a)
  })

  // 2026-11-04 review 5: the id file was made with O_EXCL and written in a second step, so a process
  // that met it in between read it empty and put its own id over it, while the first kept its own.
  it('many processes that start at once all agree on one id, whole on disk', async () => {
    for (let round = 0; round < 5; round++) {
      const dir = path.join(root, `race-${round}`)
      const made: Promise<string | null>[] = []
      for (let i = 0; i < 12; i++) {
        resetUpdateStoreMachineIdsForTest()
        made.push(updateStoreMachineId(dir))
      }
      const ids = await Promise.all(made)
      expect(new Set(ids).size).toBe(1)
      expect(fs.readFileSync(path.join(dir, 'machine-id'), 'utf8').trim()).toBe(ids[0])
      expect(fs.readdirSync(dir)).toEqual(['machine-id'])
    }
    resetUpdateStoreMachineIdsForTest()
  })

  it('of an entry under the id and one an older build wrote under the host name since, the newer counts', async () => {
    const file = path.join(root, 'g.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    const at = Date.now()
    const legacy = `${os.hostname() || 'unknown'}|ssh:devbox`
    fs.writeFileSync(file, JSON.stringify({
      [mine('ssh:devbox')]: { expected: 'b1', at: at - 60_000, reason: 'this build, before a downgrade' },
      [legacy]: { expected: 'b2', at, reason: 'the older build that ran in between' },
    }))
    expect(await readBuildBackoff('ssh:devbox')).toEqual({ expected: 'b2', at, reason: 'the older build that ran in between' })
    await buildBackoffSettled()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [mine('ssh:devbox')]: { expected: 'b2', at, reason: 'the older build that ran in between' } })
  })

  it('an entry an older build kept under the host name is read once and moved under the id', async () => {
    const file = path.join(root, 'f.json')
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    const at = Date.now()
    const legacy = `${os.hostname() || 'unknown'}|ssh:devbox`
    fs.writeFileSync(file, JSON.stringify({ [legacy]: { expected: 'b1', at, reason: 'kept by an older build' } }))
    expect(await readBuildBackoff('ssh:devbox')).toEqual({ expected: 'b1', at, reason: 'kept by an older build' })
    await buildBackoffSettled()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [mine('ssh:devbox')]: { expected: 'b1', at, reason: 'kept by an older build' } })
    expect(await readBuildBackoff('ssh:devbox')).toEqual({ expected: 'b1', at, reason: 'kept by an older build' })
  })

  it('a test run keeps none unless it names the file (tests share one data home)', async () => {
    void writeBuildBackoff('ssh:devbox', { expected: 'b1', at: Date.now(), reason: '' })
    await buildBackoffSettled()
    expect(await readBuildBackoff('ssh:devbox')).toBeNull()
  })
})
