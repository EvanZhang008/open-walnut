/**
 * One writer at a time of service-mode.json (src/binary/service-mode-lock.ts, service-mode-update.ts):
 * the leader switch's setServiceRole and `walnut daemon update`'s read-decide-write never interleave,
 * so a leader role written meanwhile is never written over (review point 3). The lock's stale rule:
 * a holder that is gone, or a lock older than LOCK_STALE_MS, is broken and taken.
 * MACHINE SAFETY: temp dirs only; the only process started is this test's own `sleep` standing for
 * another writer, ended by its pid.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readServiceMode, setServiceRole, writeServiceMode, ServiceRoleError } from '../../src/binary/service-mode.js'
import { lockIsStale, LOCK_STALE_MS, SERVICE_MODE_LOCK_FILE, tryLockServiceMode, withServiceModeLockWait } from '../../src/binary/service-mode-lock.js'
import { dropServiceMode, restoreServiceMode, stageServiceMode } from '../../src/binary/service-mode-update.js'
import { cleanRoleLayouts, LEADER, roleLayout } from './fixtures/service-role-layout.js'

afterAll(cleanRoleLayouts)

const busyCode = (fn: () => unknown): string => {
  try { fn() } catch (err) { return err instanceof ServiceRoleError ? err.code : String(err) }
  return 'no throw'
}

describe('the lock', () => {
  it('is taken once, released by its holder only, and a held one refuses at once', () => {
    const l = roleLayout()
    const release = tryLockServiceMode(l.state)
    expect(release).not.toBeNull()
    expect(tryLockServiceMode(l.state)).toBeNull()
    release!()
    expect(fs.existsSync(path.join(l.state, SERVICE_MODE_LOCK_FILE))).toBe(false)
    expect(tryLockServiceMode(l.state)).not.toBeNull()
  })

  it('a lock whose holder is gone, or one older than the stale limit, is broken and taken', async () => {
    const now = 1_000_000
    expect(lockIsStale(`pid=${process.pid}\nat=${now}\n`, now + 1)).toBe(false)
    expect(lockIsStale(`pid=${process.pid}\nat=${now}\n`, now + LOCK_STALE_MS + 1)).toBe(true)
    expect(lockIsStale('garbage', now)).toBe(true)
    // Another live writer (this test's own process) holds it: busy; once it is gone, the lock is broken.
    const l = roleLayout()
    const other = spawn('sleep', ['30'], { stdio: 'ignore' })
    const gone = new Promise((r) => other.once('exit', r))
    fs.writeFileSync(path.join(l.state, SERVICE_MODE_LOCK_FILE), `pid=${other.pid}\nat=${Date.now()}\n`)
    expect(busyCode(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }))).toBe('mode_busy')
    other.kill('SIGKILL')
    await gone
    expect(setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }).changed).toBe(true)
    expect(fs.existsSync(path.join(l.state, SERVICE_MODE_LOCK_FILE))).toBe(false)
  })
})

describe('setServiceRole and walnut daemon update never interleave', () => {
  it('two writers breaking one stale lock at once: the fresh lock the first one took is put back, not taken over', () => {
    const l = roleLayout()
    const file = path.join(l.state, SERVICE_MODE_LOCK_FILE)
    const now = 2_000_000
    fs.writeFileSync(file, `pid=1\nat=${now - LOCK_STALE_MS - 10}\n`)   // pid 1 never holds it: stale
    const fresh = `pid=${process.pid}\nat=${now}\n`
    let raced = false
    // The other writer breaks the same stale lock and takes a fresh one right before our move aside.
    const racing = { ...fs, renameSync: (from: string, to: string) => {
      if (!raced && from === file) { raced = true; fs.rmSync(file, { force: true }); fs.writeFileSync(file, fresh) }
      fs.renameSync(from, to)
    } } as unknown as typeof fs
    expect(tryLockServiceMode(l.state, { f: racing, now: () => now })).toBeNull()
    expect(raced).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(fresh)
    expect(fs.readdirSync(l.state).filter((n) => n.includes('.stale.'))).toEqual([])
  })

  it('the switch cannot write while the update holds the mode between its read and its write', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    let tried = ''
    await withServiceModeLockWait(l.state, async () => {
      // The update read the replica mode; the switch tries now.
      tried = busyCode(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }))
      writeServiceMode(l.state, { v: 1, home: LEADER, exe: '/versions/new/walnut' })
    })
    expect(tried).toBe('mode_busy')
    // The switch tries again after the update: its role stands, on the version the update staged.
    expect(setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }).changed).toBe(true)
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader', home: l.promoted, exe: '/versions/new/walnut' } })
  })

  it('an update that waits for the switch reads its leader role and keeps it', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    const release = tryLockServiceMode(l.state)!
    // The update starts while the switch holds the lock: it waits.
    const staging = stageServiceMode(l.state, { home: LEADER, on: true }, '/versions/new/walnut', { waitMs: 10_000 })
    // Meanwhile the switch's write lands (its own section, done under the lock it holds).
    writeServiceMode(l.state, { v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' })
    release()
    const staged = await staging
    expect(staged.before).toMatchObject({ role: 'leader' })
    expect(staged.note).toMatch(/^service_leads/)
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader', home: l.promoted, exe: '/versions/new/walnut', walnutId: 'w1' } })
  })

  it('a failed update puts its mode back only over its own write', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    const staged = await stageServiceMode(l.state, undefined, '/versions/new/walnut')
    expect(await restoreServiceMode(l.state, staged.before, staged.written)).toBe('restored')
    expect(readServiceMode(l.state)).toMatchObject({ mode: { exe: l.exe } })
    // The switch wrote the leader role after the update staged: the put-back leaves it.
    const again = await stageServiceMode(l.state, undefined, '/versions/new/walnut')
    setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' })
    expect(await restoreServiceMode(l.state, again.before, again.written)).toBe('changed')
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader', home: l.promoted } })
  })

  it('the boot proof\'s drop reads again: a leader mode stays, a mode of another version is not touched', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: '/versions/new/walnut' })
    expect(await dropServiceMode(l.state, '/versions/other/walnut')).toBe('none')
    setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' })
    expect(await dropServiceMode(l.state, '/versions/new/walnut')).toBe('leader')
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader' } })
    setServiceRole(l.state, { role: 'replica', home: LEADER, walnutId: 'w1' })
    expect(await dropServiceMode(l.state, '/versions/new/walnut')).toBe('dropped')
    expect(readServiceMode(l.state)).toMatchObject({ missing: true })
  })
})
