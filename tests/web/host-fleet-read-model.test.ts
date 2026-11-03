/**
 * How old the Overview's cards are, in words (web/src/components/settings/sections/host-fleet-read-model.ts):
 * "read N min ago", the card a host never read leaves out while its first read runs, the
 * line a failed read adds while the older card stays, and a card a button answered.
 */
import { describe, expect, it } from 'vitest'
import {
  FOLLOW_READ_MS, followRead, isRead, markRefreshing, neverRead, newestRead, readAgo, readFailure, readLabel, replaceCard, shownHosts,
} from '../../web/src/components/settings/sections/host-fleet-read-model'
import { fleetSummary, problemsOf } from '../../web/src/components/settings/sections/host-fleet-dashboard-model'
import { statusKind } from '../../web/src/components/settings/sections/host-fleet-model'
import type { FleetHost } from '../../web/src/api/hosts-fleet'

const NOW = Date.UTC(2026, 10, 3, 12)
const MIN = 60_000

function host(over: Partial<FleetHost> = {}): FleetHost {
  return {
    host: 'devbox', label: 'Dev box', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 20 * MIN, rttMs: 38, error: null },
    system: null, now: null, history: null, sessions: { running: 4 }, spend: null, server: null, daemon: null,
    placement: { score: 1, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    readAt: NOW - 12 * MIN, refreshing: false, readError: null, readFailedAt: null,
    ...over,
  }
}

describe('readAgo', () => {
  it('says minutes under an hour, hours under two days, then days', () => {
    expect(readAgo(NOW, NOW)).toBe('just now')
    expect(readAgo(NOW - 59_000, NOW)).toBe('just now')
    expect(readAgo(NOW - 60_000, NOW)).toBe('1 min ago')
    expect(readAgo(NOW - 12 * MIN, NOW)).toBe('12 min ago')
    expect(readAgo(NOW - 59 * MIN, NOW)).toBe('59 min ago')
    expect(readAgo(NOW - 60 * MIN, NOW)).toBe('1 h ago')
    expect(readAgo(NOW - 47 * 60 * MIN, NOW)).toBe('47 h ago')
    expect(readAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 d ago')
    // A clock a little ahead of this one never reads as the future.
    expect(readAgo(NOW + 5_000, NOW)).toBe('just now')
  })
})

describe('the first read and what is drawn', () => {
  it('a host never read is left out while its first read runs, and drawn when none runs', () => {
    const list = [host({ host: 'a' }), host({ host: 'b', readAt: null, refreshing: true }), host({ host: 'c', readAt: null })]
    expect(shownHosts(list).map((h) => h.host)).toEqual(['a', 'c'])
    expect(neverRead(list)).toEqual(['c'])
  })

  it('a host whose reads only ever failed keeps its card while it is read again, and is not read on its own', () => {
    const failed = host({ host: 'f', readAt: null, readError: 'ssh: connection reset', refreshing: true })
    expect(shownHosts([failed]).map((h) => h.host)).toEqual(['f'])
    expect(neverRead([{ ...failed, refreshing: false }])).toEqual([])
  })

  it('a card from a live read or an older server (no readAt at all) counts as read', () => {
    const live = host({ readAt: undefined, refreshing: undefined, readError: undefined })
    expect(isRead(live)).toBe(true)
    expect(neverRead([live])).toEqual([])
    expect(readLabel(live, NOW)).toBeNull()
  })

  it('the newest read is the summary\'s time; none read is null', () => {
    expect(newestRead([host({ readAt: NOW - 30 * MIN }), host({ readAt: NOW - 2 * MIN }), host({ readAt: null })])).toBe(NOW - 2 * MIN)
    expect(newestRead([host({ readAt: null }), host({ readAt: undefined })])).toBeNull()
  })
})

describe('a card\'s own line', () => {
  it('its read running, not read yet, or how old it is', () => {
    expect(readLabel(host({ refreshing: true }), NOW)).toBe('Refreshing...')
    expect(readLabel(host({ readAt: null }), NOW)).toBe('Not read yet')
    expect(readLabel(host(), NOW)).toBe('Read 12 min ago')
  })

  it('a failed read says why and how old what it shows is', () => {
    expect(readFailure(host(), NOW)).toBeNull()
    expect(readFailure(host({ readError: 'ssh: connection reset.' }), NOW)).toBe('Could not read it: ssh: connection reset. Showing what it read 12 min ago.')
    expect(readFailure(host({ readAt: null, readError: 'it did not answer in 25 s' }), NOW)).toBe('Could not read it: it did not answer in 25 s.')
  })
})

describe('changes the page makes itself', () => {
  it('a read started here marks its hosts before the server says so; every host with none named', () => {
    const list = [host({ host: 'a' }), host({ host: 'b' })]
    expect(markRefreshing(list, ['b']).map((h) => h.refreshing)).toEqual([false, true])
    expect(markRefreshing(list, null).map((h) => h.refreshing)).toEqual([true, true])
    expect(list.map((h) => h.refreshing)).toEqual([false, false]) // never in place
  })

  it('a card a button answered replaces its host only, and reads as just read when it says nothing', () => {
    const list = [host({ host: 'a' }), host({ host: 'b', readError: 'old failure' })]
    const answered = host({ host: 'b', readAt: undefined, refreshing: undefined, readError: undefined, label: 'B fixed' })
    const next = replaceCard(list, answered, NOW)
    expect(next[0]).toBe(list[0])
    expect(next[1]).toMatchObject({ label: 'B fixed', readAt: NOW, refreshing: false, readError: null })
  })
})

describe('following a read the server says runs', () => {
  it('for a while from when this page first saw it, also when that is late; never forever', () => {
    expect(followRead(null, false, NOW)).toEqual({ since: null, poll: false })
    // Another window pressed Refresh long after this page opened: followed from now.
    const first = followRead(null, true, NOW + 10 * MIN)
    expect(first).toEqual({ since: NOW + 10 * MIN, poll: true })
    expect(followRead(first.since, true, NOW + 10 * MIN + FOLLOW_READ_MS - 1).poll).toBe(true)
    // A server that never says it ended: the page stops asking (and shows no "Refreshing...").
    expect(followRead(first.since, true, NOW + 10 * MIN + FOLLOW_READ_MS)).toEqual({ since: NOW + 10 * MIN, poll: false })
    // It ended: the next one starts its own window.
    expect(followRead(first.since, false, NOW + 20 * MIN).since).toBeNull()
  })
})

describe('an old cached card is no host to look at', () => {
  const old = (over: Partial<FleetHost> = {}) => host({
    now: { cpus: 8, cpuUtil: 0.2, load: [1, 1, 1], memTotalBytes: 16, memAvailBytes: 8, uptimeSec: 100, bootedAt: 0, linked: true, at: NOW - 3 * 60 * MIN, stale: true },
    readAt: NOW - 3 * 60 * MIN, ...over,
  })

  it('stale only for its age: no stale line, no warning dot, not counted', () => {
    expect(problemsOf(old(), NOW).map((p) => p.key)).not.toContain('stale')
    expect(statusKind(old())).toBe('connected')
    expect(fleetSummary([old(), old({ host: 'b' })], NOW).problems).toBe(0)
  })

  it('stale because the host did not answer (a live read, or a cached read that failed): it says so', () => {
    const failed = old({ readError: 'it did not answer in 25 s' })
    expect(problemsOf(failed, NOW).map((p) => p.key)).toContain('stale')
    expect(statusKind(failed)).toBe('warn')
    const live = old({ readAt: undefined, readError: undefined })
    expect(problemsOf(live, NOW).map((p) => p.key)).toContain('stale')
    expect(statusKind(live)).toBe('warn')
  })
})
