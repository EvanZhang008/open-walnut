/**
 * Where a host server sends a browser (src/host-server/route.ts), by its
 * daemon's view alone: the leader while the leader book says it leads and the
 * daemon hears it, the companion while it is linked instead, else this server alone.
 */
import { describe, it, expect } from 'vitest'
import { chooseRoute, leaderAnswers, LEADER_QUIET_MS, VIEW_STALE_MS, type RouteInput } from '../../src/host-server/route.js'
import type { FollowerView } from '../../src/host-server/daemon-link.js'

const NOW = 1_000_000

function view(over: Partial<FollowerView> = {}, at = NOW): { view: FollowerView; at: number } {
  return {
    at,
    view: {
      walnutId: 'w1', home: '/h', epoch: 1, holder: 'primary', backup: true, primaryConnected: true,
      primaryHeardAgoMs: 100, takeoverMs: 60_000,
      bridge: { connected: true, companion: 'https://companion.example' },
      settings: {},
      ...over,
    },
  }
}

function input(over: Partial<RouteInput>): RouteInput {
  return { view: view(), now: NOW, suspect: {}, ...over }
}

describe('chooseRoute', () => {
  it('goes to the Mac while it leads and its daemon hears it', () => {
    expect(chooseRoute(input({}))).toEqual({ kind: 'leader' })
    expect(leaderAnswers(input({}))).toEqual({ answers: true, why: 'answers' })
  })

  it('goes to the companion while the Mac is quiet, gone or suspect, or the companion leads', () => {
    const companion = { kind: 'companion', origin: 'https://companion.example' }
    expect(chooseRoute(input({ view: view({ primaryConnected: false }) }))).toEqual(companion)
    expect(chooseRoute(input({ view: view({ primaryHeardAgoMs: LEADER_QUIET_MS + 1 }) }))).toEqual(companion)
    // Quiet counts the age of the answer too.
    expect(chooseRoute(input({ view: view({ primaryHeardAgoMs: LEADER_QUIET_MS - 1_000 }, NOW - 2_000) }))).toEqual(companion)
    expect(leaderAnswers(input({ view: view({ primaryConnected: false }) })).why).toBe('mac-away')
    expect(chooseRoute(input({ suspect: { leader: NOW + 1 } }))).toEqual(companion)
    expect(leaderAnswers(input({ suspect: { leader: NOW + 1 } })).why).toBe('unreachable')
    // The leader book says the companion leads: even a Mac the daemon hears is not asked.
    expect(chooseRoute(input({ view: view({ holder: 'backup' }) }))).toEqual(companion)
    expect(leaderAnswers(input({ view: view({ holder: 'backup' }) })).why).toBe('companion-leads')
  })

  it('a suspect mark runs out', () => {
    expect(chooseRoute(input({ suspect: { leader: NOW } }))).toEqual({ kind: 'leader' })
  })

  it('is alone when neither answers, and says why', () => {
    const away = view({ primaryConnected: false })
    expect(chooseRoute(input({ view: away, suspect: { companion: NOW + 1 } }))).toEqual({ kind: 'alone', why: 'nobody-answers' })
    expect(chooseRoute(input({ view: view({ primaryConnected: false, bridge: { connected: false, companion: 'https://c' } }) }))).toEqual({ kind: 'alone', why: 'nobody-answers' })
    expect(chooseRoute(input({ view: view({ primaryConnected: false, bridge: { connected: false, companion: null } }) }))).toEqual({ kind: 'alone', why: 'mac-away' })
    expect(chooseRoute(input({ view: null }))).toEqual({ kind: 'alone', why: 'no-daemon' })
    // A daemon answer that stopped coming says nothing.
    expect(chooseRoute(input({ view: view({}, NOW - VIEW_STALE_MS - 1) }))).toEqual({ kind: 'alone', why: 'no-daemon' })
  })
})
