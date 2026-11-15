/**
 * HoldNews (src/providers/daemon-hold-news.ts): a daemon-update hold asked again every minute
 * is a warning once, then info, and a warning again only after HOLD_REWARN_MS or on a change.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HoldNews, HOLD_REWARN_MS, holdLog } from '../../src/providers/daemon-hold-news.js'
import { log } from '../../src/logging/index.js'

describe('HoldNews', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('says the same hold once per HOLD_REWARN_MS, counts set aside', () => {
    const n = new HoldNews()
    const t0 = 1_000_000
    expect(n.isNews('b2', '1 host_exec run on the host would end with the daemon', t0)).toBe(true)
    // The minute recheck, for half an hour: not news, even when the count changes.
    for (let m = 1; m < 30; m += 1) {
      expect(n.isNews('b2', '1 host_exec run on the host would end with the daemon', t0 + m * 60_000)).toBe(false)
      expect(n.isNews('b2', `${m % 3 + 2} host_exec runs on the host would end with the daemon`, t0 + m * 60_000 + 1)).toBe(m === 1)
    }
    expect(n.isNews('b2', '1 host_exec run on the host would end with the daemon', t0 + HOLD_REWARN_MS)).toBe(true)
  })

  it('a new build or a new kind of reason is news; alternating holds are each news once', () => {
    const n = new HoldNews()
    expect(n.isNews('b2', 'ACP turns open', 0)).toBe(true)
    expect(n.isNews('b2', 'probation', 1)).toBe(true)
    expect(n.isNews('b2', 'ACP turns open', 2)).toBe(false)
    expect(n.isNews('b2', 'probation', 3)).toBe(false)
    expect(n.isNews('b3', 'ACP turns open', 4)).toBe(true)
  })

  it('holdLog warns on news and logs the repeats at info', () => {
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(log.session, 'info').mockImplementation(() => {})
    const n = new HoldNews()
    for (let i = 0; i < 30; i += 1) holdLog(n, 'b2', '1 host_exec run', 'upgrade DEFERRED (host_exec runs)', { i })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(29)
  })
})

describe('HoldNews.forget', () => {
  it('a hold that ended is news again when it starts over', () => {
    const n = new HoldNews()
    expect(n.isNews('b2', '1 host_exec run', 0)).toBe(true)
    expect(n.isNews('b2', 'ACP turns open', 1)).toBe(true)
    n.forget(/host_exec/)
    expect(n.isNews('b2', '1 host_exec run', 2)).toBe(true)
    expect(n.isNews('b2', 'ACP turns open', 3)).toBe(false)
  })
})

describe('HoldNews(rewarnMs)', () => {
  it('Infinity says a steady hold once per build, however long it lasts', () => {
    const n = new HoldNews(Number.POSITIVE_INFINITY)
    expect(n.isNews('b2', 'held by the host setting', 0)).toBe(true)
    expect(n.isNews('b2', 'held by the host setting', 10 * 24 * 60 * 60_000)).toBe(false)
    expect(n.isNews('b3', 'held by the host setting', 10 * 24 * 60 * 60_000 + 1)).toBe(true)
  })
})
