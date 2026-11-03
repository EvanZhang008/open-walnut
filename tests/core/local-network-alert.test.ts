/**
 * The local network letter (src/core/hosts/local-network-alert.ts): one letter after two 'blocked'
 * checks at least a minute apart, never again in the same episode, archived once the network is
 * reachable, a restart in the middle neither sending twice nor forgetting to archive, the check's
 * clock, and where the server starts it. The probe is injected: nothing here touches a network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLocalNetworkAlert, localNetworkAlertOff, localNetworkLetter, runningLocalNetworkAlert, startLocalNetworkAlert,
  BLOCKED_MARK_STEP_MS, CONFIRM_MS, EPISODE_EVERY_MS, FIRST_CHECK_MS, IDLE_EVERY_MS, QUIET_CLOSE_MS, STALE_SIGHTING_MS,
  type LocalNetworkAlertDeps,
} from '../../src/core/hosts/local-network-alert.js'
import { letterTime } from '../../src/core/human-inbox/walnut-letters/local-network-blocked.js'
import type { LocalNetworkProbeResult, LocalNetworkVerdict } from '../../src/core/hosts/local-network-probe.js'
import { log } from '../../src/logging/index.js'

const ROOT = path.resolve(__dirname, '../..')
const result = (verdict: LocalNetworkVerdict): LocalNetworkProbeResult => ({
  verdict, gateway: '192.168.1.1', attempts: [], linkKnown: verdict === 'blocked' ? true : null,
})

describe('localNetworkLetter', () => {
  it('says what is wrong first, then the fix, the usual cause and when it was first seen', () => {
    const at = Date.UTC(2026, 10, 3, 9, 30)
    const l = localNetworkLetter(at)
    expect(l.subject).toBe('macOS is blocking Walnut from your local network')
    const paras = l.markdown.split('\n\n')
    expect(paras[0]).toMatch(/^Walnut cannot reach machines on this Mac's local network\./)
    expect(paras[0]).toContain('"No route to host"')
    expect(paras[0]).toContain('slower relay')
    expect(paras[1]).toContain('System Settings > Privacy & Security > Local Network')
    expect(paras[1]).toContain('If two Walnut entries are listed, turn on both.')
    expect(paras[2]).toContain('a copy of Walnut.app')
    expect(paras[2]).toContain('"Don\'t Allow"')
    expect(paras[3]).toContain(letterTime(at))
    expect(paras[3]).toContain('archives itself once Walnut reaches the local network again')
    expect(l.markdown).not.toMatch(/[\u2013\u2014]/)
  })

  it('writes in the letter language', () => {
    // Simplified Chinese test data, written as escapes.
    const l = localNetworkLetter(Date.UTC(2026, 10, 3, 9, 30), 'zh')
    expect(l.subject).toBe('macOS \u963b\u6b62\u4e86 Walnut \u8bbf\u95ee\u4f60\u7684\u5c40\u57df\u7f51')
    expect(l.markdown).toContain('\u7cfb\u7edf\u8bbe\u7f6e > \u9690\u79c1\u4e0e\u5b89\u5168\u6027 > \u672c\u5730\u7f51\u7edc')
  })

  it('shows the time as local YYYY-MM-DD HH:MM', () => {
    const d = new Date(2026, 10, 3, 7, 5)
    expect(letterTime(d.getTime())).toBe('2026-11-03 07:05')
  })
})

describe('createLocalNetworkAlert', () => {
  let dir: string
  let clock: number
  let net: LocalNetworkVerdict
  let probes: number
  let sent: Array<{ subject: string; markdown: string; opKey: string }>
  let archived: string[]
  let sendFails: boolean
  let timers: Array<{ fn: () => void; at: number; cleared: boolean; unrefd: boolean }>
  let deeps: boolean[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-network-alert-'))
    clock = 1_000_000
    net = 'reachable'
    probes = 0
    sent = []
    archived = []
    sendFails = false
    timers = []
    deeps = []
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  const statePath = () => path.join(dir, 'local', 'local-network-alert.json')
  const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8')) as { episode: Record<string, unknown> }
  function make(over: Partial<LocalNetworkAlertDeps> = {}) {
    return createLocalNetworkAlert({
      probe: async ({ deep }) => { probes++; deeps.push(deep); return result(net) },
      send: async (l) => {
        if (sendFails) throw new Error('store locked')
        sent.push(l)
        return `lt-${sent.length}`
      },
      archive: async ({ letterId, opKey }) => { archived.push(letterId ?? `op:${opKey}`) },
      statePath: statePath(),
      now: () => clock,
      setTimer: (fn, ms) => {
        const t = { fn, at: clock + ms, cleared: false, unrefd: false }
        timers.push(t)
        return Object.assign(t, { unref: () => { t.unrefd = true } }) as never
      },
      clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
      ...over,
    })
  }
  const live = () => timers.filter((t) => !t.cleared)
  /** Advance the fake clock and fire every timer now due. */
  async function advance(alert: ReturnType<typeof make>, ms: number) {
    clock += ms
    for (const t of timers.filter((x) => !x.cleared && x.at <= clock)) { t.cleared = true; t.fn() }
    await alert.episode()
  }

  it('one blocked check sends nothing; a second one a minute later sends ONE letter, and a third none', async () => {
    const alert = make()
    net = 'blocked'
    expect(await alert.check()).toBe('blocked')
    expect(sent).toHaveLength(0)
    expect(readState().episode).toMatchObject({ openedAt: 1_000_000, gateway: '192.168.1.1' })
    expect(readState().episode.letterId).toBeUndefined()

    clock += CONFIRM_MS
    await alert.check()
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('macOS is blocking Walnut from your local network')
    expect(sent[0].opKey).toMatch(/^local-network-blocked:/)
    expect(sent[0].markdown).toContain(letterTime(1_000_000))
    expect(readState().episode).toMatchObject({ letterId: 'lt-1', confirmedAt: 1_000_000 + CONFIRM_MS })

    for (let i = 0; i < 3; i++) { clock += EPISODE_EVERY_MS; await alert.check() }
    expect(sent).toHaveLength(1)
  })

  it('two blocked checks under a minute apart are not enough yet', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS - 1
    await alert.check()
    expect(sent).toHaveLength(0)
    clock += 1
    await alert.check()
    expect(sent).toHaveLength(1)
  })

  it("'unknown' keeps the state: it neither opens, confirms nor closes an episode", async () => {
    const alert = make()
    net = 'unknown'
    await alert.check()
    expect(await alert.episode()).toBeNull()
    expect(fs.existsSync(statePath())).toBe(false)
    net = 'blocked'
    await alert.check()
    net = 'unknown'
    clock += 5 * CONFIRM_MS
    await alert.check()
    expect(sent).toHaveLength(0)
    expect(await alert.episode()).not.toBeNull()
    net = 'blocked'
    await alert.check()
    expect(sent).toHaveLength(1)
    net = 'unknown'
    await alert.check()
    expect(archived).toEqual([])
  })

  it('reachable closes the episode and archives its letter', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    net = 'reachable'
    await alert.check()
    expect(archived).toEqual(['lt-1'])
    expect(await alert.episode()).toBeNull()
    expect(fs.existsSync(statePath())).toBe(false)
    // A new block later is a new episode, with its own letter.
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    expect(sent).toHaveLength(2)
    expect(sent[1].opKey).not.toBe(sent[0].opKey)
  })

  it('an archive that failed keeps the episode; the next reachable check archives it', async () => {
    let archiveFails = true
    const alert = make({
      archive: async ({ letterId, opKey }) => {
        if (archiveFails) throw new Error('store locked')
        archived.push(letterId ?? `op:${opKey}`)
      },
    })
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    net = 'reachable'
    await alert.check()
    expect(archived).toEqual([])
    expect((await alert.episode())?.letterId).toBe('lt-1')
    expect(readState().episode.letterId).toBe('lt-1')
    archiveFails = false
    await alert.check()
    expect(archived).toEqual(['lt-1'])
    expect(await alert.episode()).toBeNull()
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('a lone sighting with no check since (the server was down) starts over at the next blocked check', async () => {
    const first = make()
    net = 'blocked'
    await first.check()
    first.stop()
    clock += STALE_SIGHTING_MS + 1
    const second = make()
    await second.check()
    expect(sent).toHaveLength(0)
    expect((await second.episode())?.openedAt).toBe(clock)
    clock += CONFIRM_MS
    await second.check()
    expect(sent).toHaveLength(1)
  })

  it('a confirmed episode with no blocked check for a day closes and archives (a gateway that drops every port)', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    const lastBlocked = clock
    net = 'unknown'
    for (let i = 0; i < 3; i++) { clock += EPISODE_EVERY_MS; await alert.check() }
    clock = lastBlocked + QUIET_CLOSE_MS - 1
    await alert.check()
    expect(archived).toEqual([])
    expect(await alert.episode()).not.toBeNull()
    clock += 1
    await alert.check()
    expect(archived).toEqual(['lt-1'])
    expect(await alert.episode()).toBeNull()
    expect(fs.existsSync(statePath())).toBe(false)
    expect(live().map((t) => t.at - clock)).toEqual([IDLE_EVERY_MS])
  })

  it('the day counts from the latest blocked check, written at most every BLOCKED_MARK_STEP_MS', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    const writes = () => readState().episode.lastBlockedAt as number
    // Blocked for two days, checked every 2 minutes.
    let lastWritten = writes()
    let changes = 0
    for (let t = 0; t < 2 * QUIET_CLOSE_MS; t += 30 * EPISODE_EVERY_MS) {
      for (let i = 0; i < 30; i++) { clock += EPISODE_EVERY_MS; await alert.check() }
      if (writes() !== lastWritten) { changes++; lastWritten = writes() }
    }
    expect(changes).toBeGreaterThan(0)
    expect(clock - writes()).toBeLessThan(BLOCKED_MARK_STEP_MS)
    net = 'unknown'
    clock = writes() + QUIET_CLOSE_MS - 1
    await alert.check()
    expect(archived).toEqual([])
    clock += BLOCKED_MARK_STEP_MS
    await alert.check()
    expect(archived).toEqual(['lt-1'])
    expect(sent).toHaveLength(1)
  })

  it('after a restart two days later, the first unknown check closes the old episode', async () => {
    const first = make()
    net = 'blocked'
    await first.check()
    clock += CONFIRM_MS
    await first.check()
    first.stop()
    clock += 2 * QUIET_CLOSE_MS
    net = 'unknown'
    const second = make()
    await second.check()
    expect(archived).toEqual(['lt-1'])
    expect(await second.episode()).toBeNull()
  })

  it('asks for the deep probe only while an episode is open', async () => {
    const alert = make()
    await alert.check()
    net = 'blocked'
    await alert.check()
    await alert.check()
    net = 'reachable'
    await alert.check()
    await alert.check()
    expect(deeps).toEqual([false, false, true, true, false])
  })

  it('a reachable verdict from the deep proof closes the episode like any other', async () => {
    let proof = false
    const alert = make({
      probe: async () => (proof
        ? { ...result('reachable'), proof: { host: '192.168.1.23', port: 22, outcome: 'refused' } }
        : result('blocked')),
    })
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    proof = true
    await alert.check()
    expect(archived).toEqual(['lt-1'])
    expect(await alert.episode()).toBeNull()
  })

  it('a lone sighting followed only by unknowns goes stale: closed with nothing to archive, back to the idle clock', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    net = 'unknown'
    clock += STALE_SIGHTING_MS
    await alert.check()
    expect(await alert.episode()).not.toBeNull()
    clock += 1
    await alert.check()
    expect(await alert.episode()).toBeNull()
    expect(archived).toEqual([])
    expect(fs.existsSync(statePath())).toBe(false)
    expect(live().map((t) => t.at - clock)).toEqual([IDLE_EVERY_MS])
    net = 'blocked'
    await alert.check()
    expect(sent).toHaveLength(0)
    const restarted = clock
    expect((await alert.episode())?.openedAt).toBe(restarted)
    clock += CONFIRM_MS
    await alert.check()
    expect(sent).toHaveLength(1)
    // "First seen" is the sighting the letter counted from.
    expect(sent[0].markdown).toContain(letterTime(restarted))
  })

  it('stop() during a check in flight leaves no timer behind', async () => {
    const gate: { release?: () => void } = {}
    const alert = make({
      probe: () => new Promise<LocalNetworkProbeResult>((resolve) => { gate.release = () => resolve(result('blocked')) }),
    })
    const pending = alert.check()
    for (let i = 0; i < 100 && !gate.release; i++) await new Promise((r) => setTimeout(r, 5))
    expect(gate.release).toBeTypeOf('function')
    alert.stop()
    gate.release!()
    expect(await pending).toBeNull()
    expect(live()).toEqual([])
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('a block lifted before it was confirmed sends and archives nothing', async () => {
    const alert = make()
    net = 'blocked'
    await alert.check()
    net = 'reachable'
    clock += CONFIRM_MS
    await alert.check()
    expect(sent).toEqual([])
    expect(archived).toEqual([])
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('a restart mid-episode sends no second letter and still archives the first', async () => {
    const first = make()
    net = 'blocked'
    await first.check()
    clock += CONFIRM_MS
    await first.check()
    first.stop()

    const second = make()
    clock += FIRST_CHECK_MS
    await second.check()
    await second.check()
    expect(sent).toHaveLength(1)
    net = 'reachable'
    await second.check()
    expect(archived).toEqual(['lt-1'])
    expect(fs.existsSync(statePath())).toBe(false)
  })

  it('a send that failed (or a crash mid-send) goes again under the same op key, once', async () => {
    const first = make()
    net = 'blocked'
    await first.check()
    clock += CONFIRM_MS
    sendFails = true
    await first.check()
    expect(sent).toHaveLength(0)
    expect(readState().episode.confirmedAt).toBe(1_000_000 + CONFIRM_MS)
    const opKey = readState().episode.opKey
    first.stop()

    sendFails = false
    const second = make()
    await second.check()
    expect(sent).toHaveLength(1)
    expect(sent[0].opKey).toBe(opKey)
    await second.check()
    expect(sent).toHaveLength(1)
  })

  it('an episode confirmed but unsent at a restart is archived by its op key once reachable', async () => {
    const first = make()
    net = 'blocked'
    await first.check()
    clock += CONFIRM_MS
    sendFails = true
    await first.check()
    const opKey = readState().episode.opKey as string
    first.stop()
    const second = make()
    net = 'reachable'
    await second.check()
    expect(archived).toEqual([`op:${opKey}`])
  })

  it('checks 2 minutes after start, then every 10, every 2 while an episode is open; timers unref', async () => {
    const alert = make()
    alert.start()
    expect(live().map((t) => t.at - clock)).toEqual([FIRST_CHECK_MS])
    await advance(alert, FIRST_CHECK_MS - 1)
    expect(probes).toBe(0)
    await advance(alert, 1)
    expect(probes).toBe(1)
    expect(live().map((t) => t.at - clock)).toEqual([IDLE_EVERY_MS])

    net = 'blocked'
    await advance(alert, IDLE_EVERY_MS)
    expect(probes).toBe(2)
    expect(live().map((t) => t.at - clock)).toEqual([EPISODE_EVERY_MS])
    await advance(alert, EPISODE_EVERY_MS)
    expect(sent).toHaveLength(1)
    expect(live().map((t) => t.at - clock)).toEqual([EPISODE_EVERY_MS])

    net = 'reachable'
    await advance(alert, EPISODE_EVERY_MS)
    expect(archived).toEqual(['lt-1'])
    expect(live().map((t) => t.at - clock)).toEqual([IDLE_EVERY_MS])
    expect(timers.every((t) => t.unrefd)).toBe(true)

    alert.stop()
    expect(live()).toEqual([])
    await advance(alert, 10 * IDLE_EVERY_MS)
    expect(probes).toBe(4)
  })

  it('logs one line per verdict change, never per check', async () => {
    const info = vi.spyOn(log.session, 'info')
    const changes = () => info.mock.calls.filter(([msg]) => msg === 'local network verdict changed').length
    const alert = make()
    for (let i = 0; i < 3; i++) await alert.check()
    expect(changes()).toBe(1)
    net = 'unknown'
    await alert.check()
    await alert.check()
    expect(changes()).toBe(2)
    net = 'reachable'
    await alert.check()
    expect(changes()).toBe(3)
  })

  it('a probe that throws reads unknown and changes nothing', async () => {
    const alert = make({ probe: async () => { throw new Error('boom') } })
    expect(await alert.check()).toBe('unknown')
    expect(await alert.episode()).toBeNull()
  })

  it('sends in the letter language', async () => {
    const alert = make({ language: async () => 'zh' })
    net = 'blocked'
    await alert.check()
    clock += CONFIRM_MS
    await alert.check()
    expect(sent[0].subject).toBe('macOS \u963b\u6b62\u4e86 Walnut \u8bbf\u95ee\u4f60\u7684\u5c40\u57df\u7f51')
  })
})

describe('where it runs', () => {
  it.each<[string, Parameters<typeof localNetworkAlertOff>[0], string | null]>([
    ['the real Mac server', { platform: 'darwin', enabled: true, env: {}, isolated: false }, null],
    ['Linux', { platform: 'linux', enabled: true, env: {}, isolated: false }, 'not macOS'],
    ['Windows', { platform: 'win32', enabled: true, env: { WALNUT_LOCAL_NETWORK_LETTER: '1' }, isolated: false }, 'not macOS'],
    ['the host fixture', { platform: 'darwin', enabled: false, env: {}, isolated: false }, 'host fixture'],
    ['an isolated server', { platform: 'darwin', enabled: true, env: {}, isolated: true }, 'isolated server'],
    ['an isolated server that opted in', { platform: 'darwin', enabled: true, env: { WALNUT_LOCAL_NETWORK_LETTER: '1' }, isolated: true }, null],
    ['turned off', { platform: 'darwin', enabled: true, env: { WALNUT_LOCAL_NETWORK_LETTER: '0' }, isolated: false }, 'turned off (WALNUT_LOCAL_NETWORK_LETTER=0)'],
  ])('%s', (_name, input, want) => {
    expect(localNetworkAlertOff(input)).toBe(want)
  })

  it('off macOS it never checks', async () => {
    vi.useFakeTimers()
    try {
      const probe = vi.fn(async () => result('blocked'))
      const stop = await startLocalNetworkAlert({ platform: 'linux', isolated: false, deps: { probe } })
      expect(runningLocalNetworkAlert()).toBeNull()
      await vi.advanceTimersByTimeAsync(2 * IDLE_EVERY_MS)
      expect(probe).not.toHaveBeenCalled()
      stop()
    } finally { vi.useRealTimers() }
  })

  it('the test runner is an isolated server: off without asking', async () => {
    const probe = vi.fn(async () => result('blocked'))
    const stop = await startLocalNetworkAlert({ platform: 'darwin', deps: { probe } })
    expect(runningLocalNetworkAlert()).toBeNull()
    stop()
  })

  it('server.ts starts it right beside the sign-in letter, with the same gating', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    const block = src.indexOf("if (bootPolicy('host-wiring'))")
    const auth = src.indexOf('await startHostAuthAlert({')
    const mine = src.indexOf('await startLocalNetworkAlert({ enabled: !hostFixtureMode() })')
    expect(block).toBeGreaterThan(0)
    expect(auth).toBeGreaterThan(block)
    expect(mine).toBeGreaterThan(auth)
    expect(src.slice(auth, mine).split('\n').length).toBeLessThan(6)
    expect(src.slice(auth, src.indexOf('\n', auth))).toContain('enabled: !hostFixtureMode()')
    // Its stop joins the host wiring's teardown.
    expect(src.slice(mine, mine + 400)).toMatch(/unsubscribeHostPhase = \(\) => \{ offBeforeLocalNetwork\?\.\(\); offLocalNetworkAlert\(\) \}/)
    // Started nowhere else.
    expect(src.split('startLocalNetworkAlert(').length - 1).toBe(1)
  })
})
