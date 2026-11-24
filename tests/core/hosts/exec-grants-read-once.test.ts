/**
 * exec-grants lookups parse their file only when it changed. Every grant lookup runs on the
 * server's loop, several per host_exec call and before every part a host_copy sends; on
 * 2026-11-20 each one re-read and parsed the 240 KB grants file (576 grants), which held the loop
 * 250 ms to 1.3 s at a time while copies ran under load: 31 stall flight records in an hour.
 *
 * The class: any synchronous lookup the module exports. The test enumerates the module's exports
 * itself, so a NEW lookup that reads the file again on every call fails here without anyone
 * listing it. It also proves the cache never hides a change: a revoke through the module, and a
 * write by another writer (an older Walnut, an editor), are both seen by the very next lookup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as grants from '../../../src/core/hosts/exec-grants.js'

/** Sync exports that are not lookups of the store. */
const NOT_LOOKUPS = new Set(['setExecGrantsFileForTest', 'onAccessChange'])

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-read-once-'))
  file = path.join(dir, 'exec-grants.json')
  grants.setExecGrantsFileForTest(file)
})
afterEach(() => {
  vi.restoreAllMocks()
  grants.setExecGrantsFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

function syncLookups(): Array<[string, (...args: unknown[]) => unknown]> {
  return Object.entries(grants)
    .filter(([name, v]) => typeof v === 'function' && v.constructor.name !== 'AsyncFunction' && !NOT_LOOKUPS.has(name))
    .map(([name, v]) => [name, v as (...args: unknown[]) => unknown])
}

function readsOf(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((c) => String(c[0]).startsWith(dir)).length
}

describe('exec-grants lookups', () => {
  it('every sync lookup parses each file at most once while it is unchanged', async () => {
    for (let i = 0; i < 50; i++) await grants.grant(`t${i}`, 'macbox', 'own-host')
    await grants.setHostClosed('otherbox', true)
    const lookups = syncLookups()
    // The known ones, so an export rename cannot empty the list unseen.
    expect(lookups.map(([n]) => n)).toEqual(expect.arrayContaining(['findGrant', 'grantById', 'isHostClosed', 'closedHosts', 'listGrants', 'findAsk', 'wasRevoked', 'lastRevokedAt', 'listDenied']))
    // As a fresh process: nothing kept yet.
    grants.setExecGrantsFileForTest(file)
    const spy = vi.spyOn(fs, 'readFileSync')
    // Warm both files once, then no lookup may read either again.
    grants.findGrant('t1', 'macbox')
    grants.isHostClosed('macbox')
    expect(readsOf(spy)).toBe(2)
    const extra: Record<string, number> = {}
    for (const [name, fn] of lookups) {
      const before = readsOf(spy)
      for (let i = 0; i < 20; i++) fn('t1', 'macbox')
      extra[name] = readsOf(spy) - before
    }
    expect(extra).toEqual(Object.fromEntries(lookups.map(([n]) => [n, 0])))
  })

  it('a revoke is seen by the next lookup, and a write by another writer too', async () => {
    const g = await grants.grant('t1', 'macbox', 'letter')
    expect(grants.findGrant('t1', 'macbox')?.id).toBe(g.id)
    await grants.revokeGrant(g.id)
    expect(grants.findGrant('t1', 'macbox')).toBeUndefined()

    // Another writer puts a grant back, in place (same inode) and through a rename.
    const store = JSON.parse(fs.readFileSync(file, 'utf8'))
    store.grants.push({ id: 'xg-outside00001', taskId: 't2', host: 'macbox', grantedAt: 1, via: 'letter', runs: 0 })
    fs.writeFileSync(file, JSON.stringify(store))
    expect(grants.findGrant('t2', 'macbox')?.id).toBe('xg-outside00001')
    store.grants[store.grants.length - 1].revokedAt = 2
    fs.writeFileSync(`${file}.x`, JSON.stringify(store))
    fs.renameSync(`${file}.x`, file)
    expect(grants.findGrant('t2', 'macbox')).toBeUndefined()

    // The closed hosts, in their own file.
    expect(grants.isHostClosed('macbox')).toBe(false)
    fs.writeFileSync(path.join(dir, 'exec-grants-closed.json'), JSON.stringify({ closed: ['macbox'] }))
    expect(grants.isHostClosed('macbox')).toBe(true)
    // Opened again by a writer: seen at once. A file that only vanished keeps its stops a minute
    // (a rename or a checkout in flight), and reads as no stops after that (exec-grants-unreadable.test.ts).
    fs.writeFileSync(path.join(dir, 'exec-grants-closed.json'), JSON.stringify({ closed: [] }))
    expect(grants.isHostClosed('macbox')).toBe(false)
  })

  it('a value a lookup returns cannot change the store in place', async () => {
    await grants.grant('t1', 'macbox', 'letter')
    const g = grants.findGrant('t1', 'macbox')!
    expect(() => { (g as { revokedAt?: number }).revokedAt = 1 }).toThrow(TypeError)
    expect(grants.findGrant('t1', 'macbox')).toBeDefined()
    grants.closedHosts().push('macbox')
    expect(grants.isHostClosed('macbox')).toBe(false)
  })
})
