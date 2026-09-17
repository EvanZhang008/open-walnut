/**
 * Regression lock for the temp-dir sweep behind the 2026-09-13 disk-full incident
 * (52k leaked test dirs in $TMPDIR). Every case runs against its own mkdtemp
 * root — the sweep must never see, let alone touch, the real $TMPDIR here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OWNER_FILE, pidAlive, sweepStaleTmpDirs, writeOwnerPid } from './stale-tmp'

/** A pid that certainly belonged to a process and is certainly gone now. */
function deadPid(): number {
  const r = spawnSync('true')
  if (typeof r.pid !== 'number' || r.pid <= 1) throw new Error('could not obtain a finished child pid')
  return r.pid
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-tmp-test-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const mk = (name: string): string => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'payload'), 'x')
  return dir
}
const exists = (p: string): boolean => fs.existsSync(p)
const ageTo = (dir: string, ms: number): void => {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(dir, t, t)
}

describe('pidAlive', () => {
  it('is true for this process and false for a finished child', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(deadPid())).toBe(false)
  })
  it('never probes pid 0, 1 or negatives (those are broadcasts, not processes)', () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(1)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(Number.NaN)).toBe(false)
  })
})

describe('sweepStaleTmpDirs — pid in the name', () => {
  const rule = { prefix: 'open-walnut-test-runtime-', pidFrom: 'name' as const }

  it('removes dirs (and their -streams sibling) whose pid is dead, keeps live ones', () => {
    const dead = deadPid()
    const gone = mk(`open-walnut-test-runtime-${dead}`)
    const goneStreams = mk(`open-walnut-test-runtime-${dead}-streams`)
    const live = mk(`open-walnut-test-runtime-${process.pid}`)
    const liveStreams = mk(`open-walnut-test-runtime-${process.pid}-streams`)

    const removed = sweepStaleTmpDirs([rule], root)

    expect(removed.sort()).toEqual([gone, goneStreams].sort())
    expect(exists(gone)).toBe(false)
    expect(exists(goneStreams)).toBe(false)
    expect(exists(live)).toBe(true)
    expect(exists(liveStreams)).toBe(true)
  })

  it('leaves dirs that merely share the prefix but carry no pid', () => {
    const other = mk('open-walnut-test-runtime-notes')
    const unrelated = mk('open-walnut-test-global')
    const file = path.join(root, `open-walnut-test-runtime-${deadPid()}`)
    fs.writeFileSync(file, 'a plain file, not a dir')

    sweepStaleTmpDirs([rule], root)

    expect(exists(other)).toBe(true)
    expect(exists(unrelated)).toBe(true)
    expect(exists(file)).toBe(true)
  })
})

describe('sweepStaleTmpDirs — owner.pid file', () => {
  const rule = { prefix: 'walnut-pw-', name: /^walnut-pw-\d+$/, pidFrom: 'owner-file' as const, orphanAgeMs: 60_000 }

  it('removes a dir whose recorded owner is dead, keeps one whose owner is alive', () => {
    const gone = mk('walnut-pw-1000')
    fs.writeFileSync(path.join(gone, OWNER_FILE), String(deadPid()))
    const live = mk('walnut-pw-2000')
    writeOwnerPid(live)

    const removed = sweepStaleTmpDirs([rule], root)

    expect(removed).toEqual([gone])
    expect(exists(live)).toBe(true)
    expect(fs.readFileSync(path.join(live, OWNER_FILE), 'utf8')).toBe(String(process.pid))
  })

  it('a dir with no owner file is kept while young and swept once older than orphanAgeMs', () => {
    const young = mk('walnut-pw-3000')
    const old = mk('walnut-pw-4000')
    ageTo(old, 5 * 60_000)

    const removed = sweepStaleTmpDirs([rule], root)

    expect(removed).toEqual([old])
    expect(exists(young)).toBe(true)
  })

  it('never touches the shared lease dir or other prefix-sharing names', () => {
    // The real incident-adjacent trap: `walnut-pw-lease` shares the prefix, has
    // no owner and is always "old" — sweeping it would break the run's port gate.
    const lease = mk('walnut-pw-lease')
    ageTo(lease, 24 * 60 * 60_000)
    const gate = mk('walnut-pw-gate-test-123-abc')
    ageTo(gate, 24 * 60 * 60_000)

    const removed = sweepStaleTmpDirs([rule], root)

    expect(removed).toEqual([])
    expect(exists(lease)).toBe(true)
    expect(exists(gate)).toBe(true)
  })

  it('an unreadable owner file counts as no owner (age decides), not as dead', () => {
    const garbage = mk('walnut-pw-5000')
    fs.writeFileSync(path.join(garbage, OWNER_FILE), 'not a pid')

    expect(sweepStaleTmpDirs([rule], root)).toEqual([])
    expect(exists(garbage)).toBe(true)
  })
})

describe('sweepStaleTmpDirs — age only (mock homes re-created by child processes)', () => {
  const rule = { prefix: '', name: /^[a-z][a-z0-9-]*-\d{13}-[a-z0-9]{6,}$/, pidFrom: 'age' as const, orphanAgeMs: 60 * 60_000 }

  it('removes a matching name older than orphanAgeMs, keeps a young one and non-matching names', () => {
    const old = mk('walnut-test-1789577827889-6wls13fkkx')
    ageTo(old, 2 * 60 * 60_000)
    const young = mk('walnut-inbox-local-first-1789577905704-970wwmxv1f')
    const pw = mk('walnut-pw-1789579595210') // fixture home: no trailing token, owner-file rule owns it
    ageTo(pw, 24 * 60 * 60_000)
    const runtime = mk(`open-walnut-test-runtime-${process.pid}`)
    ageTo(runtime, 24 * 60 * 60_000)
    const other = mk('some-app-2026-09-17-cache')
    ageTo(other, 24 * 60 * 60_000)

    const removed = sweepStaleTmpDirs([rule], root)

    expect(removed).toEqual([old])
    for (const d of [young, pw, runtime, other]) expect(exists(d), d).toBe(true)
  })

  it('an age rule without a name pattern matches nothing (an empty prefix alone must never sweep)', () => {
    const dir = mk('walnut-test-1789577827889-6wls13fkkx')
    ageTo(dir, 24 * 60 * 60_000)
    expect(sweepStaleTmpDirs([{ prefix: '', pidFrom: 'age', orphanAgeMs: 1 }], root)).toEqual([])
    expect(exists(dir)).toBe(true)
  })
})

describe('sweepStaleTmpDirs — scope', () => {
  it('only looks at immediate children of the given root', () => {
    const nested = mk(path.join('keep', `open-walnut-test-runtime-${deadPid()}`))
    sweepStaleTmpDirs([{ prefix: 'open-walnut-test-runtime-', pidFrom: 'name' }], root)
    expect(exists(nested)).toBe(true)
  })

  it('an empty prefix matches nothing', () => {
    const dir = mk(`open-walnut-test-runtime-${deadPid()}`)
    expect(sweepStaleTmpDirs([{ prefix: '', pidFrom: 'name' }], root)).toEqual([])
    expect(exists(dir)).toBe(true)
  })

  it('a missing root is a no-op, not an error', () => {
    expect(sweepStaleTmpDirs([{ prefix: 'x-', pidFrom: 'name' }], path.join(root, 'nope'))).toEqual([])
  })
})
