/**
 * The attention banner's owner store and the dots that speak when no card on
 * the page does (banner placement slice, spec 2.1 + 3; C40, C50, C60):
 *   store      placement writes are synchronous and notify (the panel never holds the card)
 *   landing    the panel opens on Needs Action, else System for a bell reason, else All
 *   bell       bellDotReason + bellPresentation over every input the bell reads
 *   local      localNoticeShows is the card's own rule; outdated never shows
 *   pane       the remote hosts pane silences the host reason
 *   dots       which card covers which reason (C15, C16, C18, C68)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetHostBannerPlacementForTests, bellDotReason, bellPresentation, getHostBannerPlacement,
  landingSectionFor, onRemoteHostsPane, setHostBannerPlacement, subscribeHostBannerOwner, type BellReason,
} from '../../web/src/utils/host-banner-placement'
import { localNoticeShows } from '../../web/src/utils/local-claude-banner'
import { attentionDotsOf } from '../../web/src/hooks/useAttentionDots'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import type { LocalClaudeStatus } from '../../web/src/api/local-claude'

beforeEach(() => { __resetHostBannerPlacementForTests() })

describe('owner store', () => {
  it('starts at the slot; writes notify synchronously, repeats do not', () => {
    expect(getHostBannerPlacement()).toBe('slot')
    let calls = 0
    const stop = subscribeHostBannerOwner(() => { calls++ })
    setHostBannerPlacement('tasks')
    expect(calls).toBe(1)
    expect(getHostBannerPlacement()).toBe('tasks')
    setHostBannerPlacement('tasks')
    expect(calls).toBe(1)
    setHostBannerPlacement('draft')
    expect(calls).toBe(2)
    stop()
    setHostBannerPlacement('none')
    expect(calls).toBe(2)
  })
})

describe('landing section', () => {
  it('Needs Action while a decision waits, otherwise All (which leads with what is broken)', () => {
    expect(landingSectionFor(1)).toBe('action')
    expect(landingSectionFor(3)).toBe('action')
    expect(landingSectionFor(0)).toBe('all')
  })
})

const SENTENCE: Record<Exclude<BellReason, null>, string> = {
  hosts: 'remote hosts need attention',
  local: 'Claude Code needs attention',
  both: 'Claude Code and remote hosts need attention',
}

describe('bell dot reason and presentation (C60 full table)', () => {
  const bools = [false, true]
  it('every cell: reason, single dot, corner dot, name and title', () => {
    for (const host of bools) for (const local of bools) for (const count of [0, 1]) for (const hasIssues of bools) for (const quiet of bools) for (const collapsed of bools) {
      const reason = bellDotReason(host, local)
      expect(reason).toBe(host && local ? 'both' : host ? 'hosts' : local ? 'local' : null)
      const p = bellPresentation({ reason, attentionCount: count, hasIssues, quiet, quietLabel: 'Quiet until 9:00', collapsed })
      const cell = JSON.stringify({ host, local, count, hasIssues, quiet, collapsed })
      expect(p.dot, cell).toBe(count === 0 && (reason !== null || hasIssues))
      expect(p.cornerDot, cell).toBe(count > 0 && reason !== null)
      if (reason === null) {
        expect(p.ariaLabel, cell).toBe('Notifications')
        expect(p.title, cell).toBe(quiet ? 'Quiet until 9:00' : collapsed ? 'Notifications' : undefined)
        continue
      }
      const name = count > 0 ? `Notifications, ${count} waiting; ${SENTENCE[reason]}` : `Notifications: ${SENTENCE[reason]}`
      expect(p.ariaLabel, cell).toBe(name)
      // Non-quiet: the tooltip is the name, collapsed or not. Quiet: the quiet label first.
      expect(p.title, cell).toBe(quiet ? `Quiet until 9:00; ${name}` : name)
    }
  })

  it('the last host row dismissed while the older system dot is on: dot stays, the name no longer says hosts', () => {
    const p = bellPresentation({ reason: bellDotReason(false, false), attentionCount: 0, hasIssues: true, quiet: false, quietLabel: '', collapsed: false })
    // The dot that stays is the older system one, drawn in its own look (not the host warn look).
    expect(p).toEqual({ ariaLabel: 'Notifications', title: undefined, dot: true, cornerDot: false, dotKind: 'system' })
  })

  it('a waiting ask with a host reason: the count plus the corner dot', () => {
    const p = bellPresentation({ reason: 'hosts', attentionCount: 1, hasIssues: false, quiet: false, quietLabel: '', collapsed: false })
    expect(p).toEqual({
      ariaLabel: 'Notifications, 1 waiting; remote hosts need attention',
      title: 'Notifications, 1 waiting; remote hosts need attention', dot: false, cornerDot: true, dotKind: 'attention',
    })
  })
})

const claude = { found: true, version: '2.1.258', minVersion: '2.1.280', kind: 'native', auth: 'ok', versionOk: true, installMethod: 'native' }
const withLocal = (problems: LocalClaudeStatus['problems'], extra: Partial<SystemHealth> = {}): SystemHealth =>
  ({ hasReadyProvider: true, claudeCliAvailable: true, localClaude: { checkedAt: 1, claude, problems } as LocalClaudeStatus, ...extra }) as SystemHealth
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258; this model needs 2.1.280 or newer.', commands: ['claude update'] }
const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }
const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['install'] }

describe('localNoticeShows (the card and the bell share it; C50)', () => {
  it('unknown or loading health says nothing', () => {
    expect(localNoticeShows(undefined, [])).toBeNull()
    expect(localNoticeShows({} as SystemHealth, [])).toBeNull()
    expect(localNoticeShows(withLocal([SIGN_IN]), [], true)).toBeNull()
  })

  it('outdated never takes a section; sign-in and install do', () => {
    expect(localNoticeShows(withLocal([OUTDATED]), [])).toBeNull()
    expect(localNoticeShows(withLocal([SIGN_IN]), [])).toBe('sign-in')
    expect(localNoticeShows(withLocal([MISSING], { claudeCliAvailable: false }), [])).toBe('install')
    expect(localNoticeShows(withLocal([]), [])).toBeNull()
  })

  it('no provider or no CLI reads as install', () => {
    expect(localNoticeShows(withLocal([], { hasReadyProvider: false }), [])).toBe('install')
    expect(localNoticeShows(withLocal([], { claudeCliAvailable: false }), [])).toBe('install')
  })

  it('a dismissal for this state and version hides it; another version does not', () => {
    expect(localNoticeShows(withLocal([SIGN_IN]), ['sign-in:2.1.258'])).toBeNull()
    expect(localNoticeShows(withLocal([SIGN_IN]), ['sign-in:2.1.200'])).toBe('sign-in')
    expect(localNoticeShows(withLocal([SIGN_IN]), ['sign-in'])).toBeNull()
    expect(localNoticeShows(withLocal([MISSING], { claudeCliAvailable: false }), ['install:2.1.280'])).toBeNull()
  })
})

describe('onRemoteHostsPane', () => {
  it('Settings > Remote hosts, or one host row there; nothing else', () => {
    expect(onRemoteHostsPane('/settings', '#remote-hosts')).toBe(true)
    expect(onRemoteHostsPane('/settings', '#rh-host-netbox')).toBe(true)
    expect(onRemoteHostsPane('/settings', '')).toBe(false)
    expect(onRemoteHostsPane('/settings', '#engines')).toBe(false)
    expect(onRemoteHostsPane('/', '#remote-hosts')).toBe(false)
    expect(onRemoteHostsPane('/notes', '#rh-host-netbox')).toBe(false)
  })
})

describe('attentionDotsOf: which in-page card covers which reason', () => {
  const dots = (hostOn: boolean, localOn: boolean, where: 'tasks' | 'slot' | 'draft' | 'none', pathname = '/', hash = '') =>
    attentionDotsOf({ hostOn, localOn, where, pathname, hash })
  it('hosts: covered by any in-page card on Home, uncovered elsewhere or with none (C15, C16)', () => {
    for (const w of ['tasks', 'slot', 'draft'] as const) expect(dots(true, false, w)).toEqual({ railSettingsDot: false, bellReason: null })
    expect(dots(true, false, 'none')).toEqual({ railSettingsDot: true, bellReason: 'hosts' })
    expect(dots(true, false, 'tasks', '/notes')).toEqual({ railSettingsDot: true, bellReason: 'hosts' })
    expect(dots(true, true, 'none', '/settings', '#rh-host-netbox')).toEqual({ railSettingsDot: false, bellReason: 'local' })
  })
  it('local: only the task panel and slot cards carry it; the draft card has no local section (C18)', () => {
    expect(dots(false, true, 'tasks').bellReason).toBeNull()
    expect(dots(false, true, 'slot').bellReason).toBeNull()
    expect(dots(false, true, 'draft').bellReason).toBe('local')
    expect(dots(false, true, 'none').bellReason).toBe('local')
    expect(dots(true, true, 'draft')).toEqual({ railSettingsDot: false, bellReason: 'local' })
    expect(dots(true, true, 'none', '/notes')).toEqual({ railSettingsDot: true, bellReason: 'both' })
  })
})
