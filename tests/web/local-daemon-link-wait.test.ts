/**
 * The live tests' boot wait for the primary's own daemon link and their boot failure
 * (tests/helpers/local-daemon-link.ts), on a fake clock: no server, no daemon, no real
 * wait, no signal.
 *
 *   - no local daemon (wsUrl empty) fails at once, never waits and never skips;
 *   - the budget runs from the call, whatever startServer spent before it;
 *   - a link first seen at the deadline passes, one seen past it fails, and a late wake
 *     past the deadline fails even when the link is up by then;
 *   - a failed boot goes through the stop entry and exits 4 once, whatever the stop did
 *     (resolved, threw, never resolved), and says the native children are NOT_VERIFIED;
 *   - both live boots use these with the default budgets.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  awaitLocalDaemonLink, failBootLink, BOOT_FAIL_EXIT, BOOT_FAIL_STOP_BUDGET_MS, LOCAL_LINK_BUDGET_MS,
} from '../helpers/local-daemon-link.js'

const ROOT = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8')

/** A fake clock; `up(t)` says whether the link is up at clock time t; `lateBy` makes each sleep oversleep. */
function clock(up: (t: number) => boolean, opts: { start?: number; lateBy?: number } = {}) {
  let now = opts.start ?? 1_000_000
  const sleeps: number[] = []
  let checks = 0
  return {
    sleeps,
    at: () => now,
    checks: () => checks,
    /** startServer spending time before the wait is called. */
    spend: (ms: number) => { now += ms },
    connected: () => { checks++; return up(now) },
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms + (opts.lateBy ?? 0) },
  }
}
const URL = 'ws://localhost:1'

describe('awaitLocalDaemonLink', () => {
  for (const wsUrl of ['', null, undefined]) {
    it(`fails at once without a local daemon (wsUrl ${JSON.stringify(wsUrl)})`, async () => {
      const c = clock(() => true)
      await expect(awaitLocalDaemonLink({ ...c, wsUrl })).rejects.toThrow(/no local daemon/)
      expect(c.checks()).toBe(0)
      expect(c.sleeps).toEqual([])
    })
  }

  it('resolves at once when the link is already up', async () => {
    const c = clock(() => true)
    await awaitLocalDaemonLink({ ...c, wsUrl: URL })
    expect(c.sleeps).toEqual([])
  })

  it('the budget runs from the call, not from what startServer spent before it', async () => {
    const c = clock(() => false)
    c.spend(50_000)
    const called = c.at()
    await expect(awaitLocalDaemonLink({ ...c, wsUrl: URL, pollMs: 1_000 })).rejects.toThrow(/within 72s of the wait's start/)
    expect(c.at() - called).toBe(LOCAL_LINK_BUDGET_MS)
  })

  it('a link first seen exactly at the deadline passes', async () => {
    let called = 0
    const c = clock((t) => t >= called + LOCAL_LINK_BUDGET_MS)
    called = c.at()
    await awaitLocalDaemonLink({ ...c, wsUrl: URL, pollMs: 7_000 })
    expect(c.at() - called).toBe(LOCAL_LINK_BUDGET_MS)
    // The last sleep is clipped to the deadline.
    expect(c.sleeps[c.sleeps.length - 1]).toBe(LOCAL_LINK_BUDGET_MS % 7_000)
  })

  it('a link that comes only past the deadline fails at the deadline', async () => {
    let called = 0
    const c = clock((t) => t > called + LOCAL_LINK_BUDGET_MS)
    called = c.at()
    await expect(awaitLocalDaemonLink({ ...c, wsUrl: URL })).rejects.toThrow(/does not show that the attempt or the daemon ended/)
    expect(c.at() - called).toBe(LOCAL_LINK_BUDGET_MS)
  })

  it('a late wake past the deadline fails even with the link up by then', async () => {
    let called = 0
    // Blocked: the one sleep returns 5 s past the deadline, and the link is up by then.
    const c = clock((t) => t > called + LOCAL_LINK_BUDGET_MS, { lateBy: 5_000 })
    called = c.at()
    await expect(awaitLocalDaemonLink({ ...c, wsUrl: URL, pollMs: LOCAL_LINK_BUDGET_MS })).rejects.toThrow(/within 72s/)
    expect(c.sleeps).toEqual([LOCAL_LINK_BUDGET_MS])
    expect(c.at() - called).toBe(LOCAL_LINK_BUDGET_MS + 5_000)
    // The clock was read first: the up link was never consumed.
    expect(c.checks()).toBe(1)
  })
})

describe('failBootLink', () => {
  function fail(stop: () => Promise<void>) {
    const lines: string[] = []
    const exits: number[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    return {
      lines, exits, timers,
      f: { stop, write: (l: string) => lines.push(l), exit: (c: number) => exits.push(c), setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }) } },
    }
  }

  it('the original failure, then stopServer, then exit 4', async () => {
    let stopped = 0
    const x = fail(async () => { stopped++ })
    await failBootLink(new Error('the boot did not link'), x.f)
    expect(stopped).toBe(1)
    expect(x.lines[0]).toBe('BOOT FAIL: the boot did not link')
    expect(x.lines[1]).toBe('BOOT FAIL cleanup: stopServer resolved; the local daemon and other native children: NOT_VERIFIED')
    expect(x.exits).toEqual([BOOT_FAIL_EXIT])
    expect(BOOT_FAIL_EXIT).not.toBe(0)
  })

  it('a stop that throws (sync or async) still exits 4, with both failures written', async () => {
    for (const stop of [async () => { throw new Error('plugins would not close') }, () => { throw new Error('sync throw') }]) {
      const x = fail(stop as () => Promise<void>)
      await failBootLink(new Error('no local daemon'), x.f)
      expect(x.lines[0]).toBe('BOOT FAIL: no local daemon')
      expect(x.lines[1]).toMatch(/^BOOT FAIL cleanup: failed \((plugins would not close|sync throw)\); .*NOT_VERIFIED$/)
      expect(x.exits).toEqual([BOOT_FAIL_EXIT])
    }
  })

  it('a stop that never resolves: cleanup unknown at its budget, exit 4 once, a late resolve changes nothing', async () => {
    let release!: () => void
    const x = fail(() => new Promise<void>((r) => { release = r }))
    const done = failBootLink(new Error('timeout'), x.f)
    await Promise.resolve()
    expect(x.timers.map((t) => t.ms)).toEqual([BOOT_FAIL_STOP_BUDGET_MS])
    expect(x.exits).toEqual([])
    x.timers[0].fn()
    await done
    expect(x.lines[1]).toMatch(/^BOOT FAIL cleanup: unknown \(stopServer did not resolve in 30s\); .*NOT_VERIFIED$/)
    expect(x.exits).toEqual([BOOT_FAIL_EXIT])
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(x.exits).toEqual([BOOT_FAIL_EXIT])
    expect(x.lines).toHaveLength(2)
  })
})

describe('both live boots use them', () => {
  for (const f of ['tests/e2e/companion-forward-live-e2e.test.ts', 'tests/e2e/leader-takeover-live-e2e.test.ts']) {
    it(f, () => {
      const text = read(f)
      const at = text.indexOf('await awaitLocalDaemonLink({\n  wsUrl: localDaemon.wsUrl,\n')
      expect(at).toBeGreaterThan(0)
      const call = text.slice(at, text.indexOf('}))', at) + 3)
      expect(call).toMatch(/connected: \(\) => dc\.getConnectedDaemonConnection\('__local__'\) !== null,/)
      expect(call).toMatch(/\}\)\.catch\(\(err\) => failBootLink\(err, \{\n  stop: \(\) => stopServer\(\),/)
      expect(call).toMatch(/exit: \(code\) => process\.exit\(code\),/)
      expect(call).not.toMatch(/budgetMs|stopBudgetMs|process\.exit\(0\)|process\.exit\(4\)/)
      // The failure path runs before the boot arms its signal handlers.
      expect(text.indexOf('armGracefulSignalExit()', at)).toBeGreaterThan(at)
      // No hand dial for '__local__' is left, and no wait that skips without a wsUrl.
      expect(text).not.toMatch(/getDirectDaemonConnection\('__local__'/)
      expect(text).not.toMatch(/localDaemon\.wsUrl &&/)
    })
  }
})
