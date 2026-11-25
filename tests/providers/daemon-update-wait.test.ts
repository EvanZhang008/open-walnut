/**
 * A host's daemon update that waits says so (src/providers/daemon-update-wait.ts): what it waits
 * for and since when, in one sentence for both update paths, on the host's status as a plain note
 * (host-status.ts foldDaemonUpdate). Before, a postponed or skipped update ("waiting:
 * service.handover: active ACP workers or relay requests must finish first", a shared daemon kept,
 * a held host) showed nowhere but the log.
 *
 * The class guard reads the phases and skip reasons from the source: a new one must say what it
 * is for the wait, or this fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PHASE_WAITS, SKIP_WAIT_LEADS, WAIT_CLOCKS, WAIT_HEALTH, daemonUpdateWaitSentence, endUpdateWait, noteUpdateWait, sinceTime, updateWaitIsLong, waitKindOf,
  LONG_POSTPONE_MS, LONG_SKIP_MS, type DaemonUpdateWait, type DaemonUpdateWaitKind,
} from '../../src/providers/daemon-update-wait.js'
import type { NetUpdatePhase, NetUpdateSkip } from '../../src/providers/daemon-net-update.js'
import { acpUpgradeHoldFlushedForTest, setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { buildHostStatus, type HostDef } from '../../src/core/hosts/host-status.js'
import { DaemonConnection, type DaemonConnectState } from '../../src/providers/daemon-connection.js'

const SRC = path.join(__dirname, '../../src/providers')
const LABEL = 'Big dev box'
/** 14:05 local: the status speaks this server's own time. */
const T = new Date(2026, 10, 24, 14, 5).getTime()
const wait = (kind: DaemonUpdateWaitKind, why: string, since = T): DaemonUpdateWait => ({ kind, why, since, expected: 'build-new' })

/** The members of a string-literal union type, read from its source. */
function unionOf(file: string, name: string): string[] {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8')
  const at = src.indexOf(`export type ${name} =`)
  expect(at).toBeGreaterThan(-1)
  const body = src.slice(at, src.indexOf('\n\n', at))
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]!)
}

describe('the sentence a waiting update says', () => {
  it('postponed: what it waits for, in the path\'s words, and since when', () => {
    expect(daemonUpdateWaitSentence(LABEL, wait('postponed', 'waiting: service.handover: active ACP workers or relay requests must finish first'), T))
      .toBe('The daemon update on Big dev box waits (since 14:05): service.handover: active ACP workers or relay requests must finish first')
    // The SSH path's reason has no "waiting:" prefix.
    expect(daemonUpdateWaitSentence(LABEL, wait('postponed', 'ACP turns are open'), T)).toBe('The daemon update on Big dev box waits (since 14:05): ACP turns are open')
  })

  it('a wait with a known end says until when', () => {
    expect(daemonUpdateWaitSentence(LABEL, { ...wait('postponed', 'the gap'), until: T + 90 * 60_000 }, T))
      .toBe('The daemon update on Big dev box waits (since 14:05, until 15:35): the gap')
    expect(daemonUpdateWaitSentence(LABEL, { ...wait('postponed', 'the gap'), until: T - 1 }, T)).toBe('The daemon update on Big dev box waits (since 14:05): the gap')
  })

  it('skipped as shared, held, and every other skip: its own lead, then the why', () => {
    expect(daemonUpdateWaitSentence(LABEL, wait('shared', 'shared, another Walnut uses it'), T))
      .toBe('Big dev box keeps the daemon another Walnut uses there, so this Walnut does not update it (since 14:05): shared, another Walnut uses it')
    expect(daemonUpdateWaitSentence(LABEL, wait('held', 'automatic updates are off for this host'), T))
      .toBe('Daemon updates on Big dev box are held by its setting (since 14:05): automatic updates are off for this host')
    expect(daemonUpdateWaitSentence(LABEL, wait('cooldown', ''), T)).toBe('The daemon update on Big dev box waits for its cooldown (since 14:05)')
  })

  it('class guard: every NetUpdatePhase and every NetUpdateSkip in the source says what it is for the wait', () => {
    const phases = unionOf('daemon-net-update.ts', 'NetUpdatePhase') as NetUpdatePhase[]
    const skips = unionOf('daemon-net-update-decide.ts', 'NetUpdateSkip') as NetUpdateSkip[]
    expect(phases.length).toBeGreaterThanOrEqual(8)
    expect(skips.length).toBeGreaterThanOrEqual(16)
    expect(Object.keys(PHASE_WAITS).sort()).toEqual([...phases].sort())
    expect(Object.keys(SKIP_WAIT_LEADS).sort()).toEqual([...skips].sort())
    // Every kind of wait says whether it reaches Walnut Health and which clock it counts on.
    expect(Object.keys(WAIT_HEALTH).sort()).toEqual(['postponed', ...skips].sort())
    expect(Object.keys(WAIT_CLOCKS).sort()).toEqual(['postponed', ...skips].sort())
    // A skip with a lead is a wait with its own sentence; one without is no wait.
    for (const skip of skips) {
      const kind = waitKindOf('skipped', skip)
      if (SKIP_WAIT_LEADS[skip]) {
        expect(kind).toBe(skip)
        const s = daemonUpdateWaitSentence(LABEL, wait(skip, 'why'), T)
        expect(s).toContain('(since 14:05): why')
        expect(s).toContain(skip === 'turned-off' ? 'turned off' : LABEL)
      } else expect(kind).toBeNull()
    }
    expect(waitKindOf('postponed')).toBe('postponed')
    expect(waitKindOf('checking')).toBe('keep')
    for (const p of ['idle', 'running', 'updated', 'failed'] as const) expect(waitKindOf(p)).toBeNull()
  })

  it('class guard: every kind the SSH path notes has its own sentence', () => {
    const src = fs.readFileSync(path.join(SRC, 'daemon-connection.ts'), 'utf8')
    const kinds = [...src.matchAll(/noteUpdateWait\(this\.hostKey, '([a-z0-9_-]+)'/g)].map((m) => m[1]!)
    expect([...new Set(kinds)].sort()).toEqual(['postponed', 'service-set', 'shared', 'unmanaged'])
    for (const k of kinds) expect(k === 'postponed' || SKIP_WAIT_LEADS[k as NetUpdateSkip]).toBeTruthy()
  })

  it('long: postponed past the overdue bound, a skip that went wrong past an hour; never the person\'s choice or a steady fact of the host', () => {
    expect(updateWaitIsLong(wait('postponed', 'x', T), T + LONG_POSTPONE_MS - 1)).toBe(false)
    expect(updateWaitIsLong(wait('postponed', 'x', T), T + LONG_POSTPONE_MS)).toBe(true)
    expect(updateWaitIsLong(wait('gave-up', 'x', T), T + LONG_SKIP_MS - 1)).toBe(false)
    for (const k of ['gave-up', 'contested', 'refused'] as const) expect(updateWaitIsLong(wait(k, 'x', T), T + LONG_SKIP_MS)).toBe(true)
    // A shared daemon that lacks nothing is the designed steady state on every machine two Walnuts share.
    for (const k of ['shared', 'unmanaged', 'old-daemon', 'platform-unknown', 'no-binary', 'held', 'turned-off'] as const) {
      expect(updateWaitIsLong(wait(k, 'x', T), T + 30 * 24 * LONG_SKIP_MS)).toBe(false)
    }
  })

  it('since when: the time today, the date and time on another day', () => {
    expect(sinceTime(T, T + 3_600_000)).toBe('14:05')
    expect(sinceTime(T - 2 * 24 * 3_600_000, T)).toBe('Nov 22, 14:05')
    expect(daemonUpdateWaitSentence(LABEL, wait('held', 'autofix is off', T - 3 * 24 * 3_600_000), T)).toBe('Daemon updates on Big dev box are held by its setting (since Nov 21, 14:05): autofix is off')
  })

  it('class guard: every SSH update path that holds an update notes a wait first', () => {
    const src = fs.readFileSync(path.join(SRC, 'daemon-connection.ts'), 'utf8')
    const body = (name: string): string[] => {
      const at = src.indexOf(`  private async ${name}(`)
      expect(at, name).toBeGreaterThan(-1)
      return src.slice(at, src.indexOf('\n  }\n', at)).split('\n')
    }
    // A wait is noted on the line or in the few above it; a hold that another checked hold made
    // (holdUpgrade, execRunsOpen) or a return that is no hold (nothing to update) needs none.
    const noted = /postponeUpgrade\(|noteUpdateWait\(|stageFailed\(/
    const noHold = /holdUpgrade\(|execRunsOpen\(|done === 'held'|isReadOnlyRemote|remoteVersion === expected|hold === null/
    const misses: string[] = []
    const check = (name: string, holds: RegExp) => {
      const lines = body(name)
      lines.forEach((line, i) => {
        if (!holds.test(line) || noHold.test(line)) return
        if (!lines.slice(Math.max(0, i - 5), i + 1).some((l) => noted.test(l))) misses.push(`${name}: ${line.trim()}`)
      })
    }
    check('holdUpgrade', /return true\b/)
    check('updateManagedDaemon', /return (false|'held')\b/)
    expect(misses).toEqual([])
  })
})

describe('since when: one clock per host and build, kept on disk', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wait-')); setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json')) })
  afterEach(() => { setAcpUpgradeHoldFileForTest(null); fs.rmSync(dir, { recursive: true, force: true }) })

  it('starts over when the wait moves into or out of the person\'s choice or a shared daemon kept', () => {
    expect(noteUpdateWait('devbox', 'held', 'autofix is off', 'b1', T).since).toBe(T)
    // Three days held, then the person turns autofix on and a busy host postpones it: a fresh wait.
    expect(noteUpdateWait('devbox', 'postponed', 'busy', 'b1', T + 3 * 24 * 3600_000).since).toBe(T + 3 * 24 * 3600_000)
    expect(noteUpdateWait('devbox', 'cooldown', 'tried', 'b1', T + 3 * 24 * 3600_000 + 60_000).since).toBe(T + 3 * 24 * 3600_000)
    expect(noteUpdateWait('devbox', 'shared', 'another Walnut uses it', 'b1', T + 3 * 24 * 3600_000 + 120_000).since).toBe(T + 3 * 24 * 3600_000 + 120_000)
    expect(noteUpdateWait('devbox', 'turned-off', 'off', 'b1', T + 3 * 24 * 3600_000 + 180_000).since).toBe(T + 3 * 24 * 3600_000 + 180_000)
  })

  it('holds across reasons and a leader restart, starts over for a new build, and ends when the update lands', async () => {
    expect(noteUpdateWait('devbox', 'postponed', 'busy', 'b1', T).since).toBe(T)
    expect(noteUpdateWait('devbox', 'cooldown', 'cooldown', 'b1', T + 60_000).since).toBe(T)
    // A restart reads the clock from disk.
    await acpUpgradeHoldFlushedForTest()
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    expect(noteUpdateWait('devbox', 'postponed', 'busy', 'b1', T + 120_000).since).toBe(T)
    expect(noteUpdateWait('devbox', 'postponed', 'busy', 'b2', T + 180_000).since).toBe(T + 180_000)
    endUpdateWait('devbox')
    expect(noteUpdateWait('devbox', 'postponed', 'busy', 'b2', T + 240_000).since).toBe(T + 240_000)
  })
})

describe('the SSH path', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wait-ssh-')); setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json')) })
  afterEach(() => { vi.restoreAllMocks(); setAcpUpgradeHoldFileForTest(null); fs.rmSync(dir, { recursive: true, force: true }) })

  type Internals = { _connected: boolean; _daemonVersion: string | null; postponeUpgrade(r: string, e: string, v: string, o?: object): void; clearUpgradeRecheck(): void }

  it('a postponed update is the host\'s wait while connected and behind; none once it runs that build', () => {
    vi.spyOn(DaemonConnection.prototype, 'linkKind', 'get').mockReturnValue('ssh')
    const c = new DaemonConnection('devbox', null)
    const x = c as unknown as Internals
    x._connected = true
    x._daemonVersion = 'build-old'
    x.postponeUpgrade('ACP turns are open', 'build-new', 'build-old', { steady: true })
    expect(c.daemonUpdateWait).toMatchObject({ kind: 'postponed', why: 'ACP turns are open', expected: 'build-new' })
    x.clearUpgradeRecheck()
    expect(c.daemonUpdateWait).toBeNull()
    x.postponeUpgrade('ACP turns are open', 'build-new', 'build-old', { steady: true })
    x._daemonVersion = 'build-new'
    expect(c.daemonUpdateWait).toBeNull()
    x._daemonVersion = 'build-old'
    x._connected = false
    expect(c.daemonUpdateWait).toBeNull()
    x.clearUpgradeRecheck()
    c.disconnect()
  })
})

describe('buildHostStatus folds the wait', () => {
  const devbox: HostDef = { hostname: 'devbox.example.test', user: 'builder', label: LABEL }
  const state = (extra: Partial<DaemonConnectState>): DaemonConnectState => ({ host: 'devbox', connected: true, phase: 'connected', phaseElapsedMs: 0, connectElapsedMs: 0, ...extra })

  it('each phase of the host network\'s updater: a wait is one plain line, anything else none', () => {
    const skips = Object.keys(SKIP_WAIT_LEADS) as NetUpdateSkip[]
    for (const phase of Object.keys(PHASE_WAITS) as NetUpdatePhase[]) {
      for (const skip of phase === 'skipped' || phase === 'held' ? skips : [undefined]) {
        const kind = waitKindOf(phase, skip)
        const w = kind && kind !== 'keep' ? wait(kind, `why of ${phase}`) : undefined
        const status = buildHostStatus('devbox', devbox, state(w ? { daemonUpdateWait: w } : {}))
        if (w) expect(status.warnings).toEqual([daemonUpdateWaitSentence(LABEL, w)])
        else expect(status.warnings ?? []).toEqual([])
        // A normal wait is never a failure, a hint or a phase of its own.
        expect(status.phase).toBe('connected')
        expect(status.hint).toBeUndefined()
      }
    }
  })

  it('not connected: no wait line (the link\'s own state is the thing to show)', () => {
    const status = buildHostStatus('devbox', devbox, state({ connected: false, phase: 'reconnecting', daemonUpdateWait: wait('postponed', 'busy') }))
    expect((status.warnings ?? []).some((w) => w.includes('waits'))).toBe(false)
  })

  it('a failed update and a new wait: both lines', () => {
    const status = buildHostStatus('devbox', devbox, state({ daemonUpdate: { state: 'failed', at: T, message: 'it did not start' }, daemonUpdateWait: wait('cooldown', 'tried 2 min ago') }))
    expect(status.warnings).toHaveLength(2)
  })
})
