/**
 * Who speaks for a host or Claude Code problem now that no card on the page
 * carries it (host-attention.ts, useAttentionDots.ts, 2026-11-16):
 *   landing    the panel opens on Needs Action, else All (which leads with the problems)
 *   bell       bellDotReason + bellPresentation over every input the bell reads
 *   local      localNoticeShows: outdated never shows; a dismissal for this state hides it
 *   pane       the remote hosts pane silences the rail dot (the user is looking at the rows)
 *   dots       a host problem lights the rail and the bell on every page, Home included
 *   model      the rail's boolean runs the problem-row model: dismissed rows and
 *              young reconnects light nothing
 */
import { describe, expect, it } from 'vitest'
import {
  bellDotReason, bellPresentation, hostAttentionOf, landingSectionFor, onRemoteHostsPane, railDotShows, type BellReason,
} from '../../web/src/utils/host-attention'
import { localNoticeShows } from '../../web/src/utils/local-claude-banner'
import { attentionDotsOf } from '../../web/src/hooks/useAttentionDots'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import type { LocalClaudeStatus } from '../../web/src/api/local-claude'
import type { HostStatusInput } from '../../src/core/hosts/host-problem'

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
      // Quiet (Do Not Disturb): no dot and no count, in the marks or the name, whatever waits.
      if (quiet) {
        expect(p, cell).toEqual({ ariaLabel: 'Notifications. Quiet until 9:00', title: 'Quiet until 9:00', dot: false, cornerDot: false, dotKind: null })
        continue
      }
      expect(p.dot, cell).toBe(count === 0 && (reason !== null || hasIssues))
      expect(p.cornerDot, cell).toBe(count > 0 && reason !== null)
      if (reason === null) {
        expect(p.ariaLabel, cell).toBe('Notifications')
        expect(p.title, cell).toBe(collapsed ? 'Notifications' : undefined)
        continue
      }
      const name = count > 0 ? `Notifications, ${count} waiting; ${SENTENCE[reason]}` : `Notifications: ${SENTENCE[reason]}`
      expect(p.ariaLabel, cell).toBe(name)
      // The tooltip is the name, collapsed or not.
      expect(p.title, cell).toBe(name)
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

  it('a host or local reason wears the attention look; the git sync dot alone keeps the system look (N9, N16)', () => {
    const base = { attentionCount: 0, quiet: false, quietLabel: '', collapsed: false }
    expect(bellPresentation({ ...base, reason: 'hosts', hasIssues: true }).dotKind).toBe('attention')
    expect(bellPresentation({ ...base, reason: 'local', hasIssues: false }).dotKind).toBe('attention')
    expect(bellPresentation({ ...base, reason: null, hasIssues: true }).dotKind).toBe('system')
    expect(bellPresentation({ ...base, reason: null, hasIssues: false }).dotKind).toBe(null)
    expect(bellPresentation({ ...base, attentionCount: 2, reason: 'hosts', hasIssues: false })).toMatchObject({ cornerDot: true, dotKind: 'attention' })
  })
})

const claude = { found: true, version: '2.1.258', minVersion: '2.1.280', kind: 'native', auth: 'ok', versionOk: true, installMethod: 'native' }
const withLocal = (problems: LocalClaudeStatus['problems'], extra: Partial<SystemHealth> = {}): SystemHealth =>
  ({ hasReadyProvider: true, claudeCliAvailable: true, localClaude: { checkedAt: 1, claude, problems } as LocalClaudeStatus, ...extra }) as SystemHealth
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258; this model needs 2.1.280 or newer.', commands: ['claude update'] }
const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }
const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['install'] }

describe('localNoticeShows (the panel row and the bell share it; C50)', () => {
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

describe('the rail dot and the bell reason (no card covers a host problem any more)', () => {
  it('railDotShows: on for a host problem on every route but the remote hosts pane', () => {
    for (const pathname of ['/', '/notes', '/settings']) expect(railDotShows(true, pathname)).toBe(true)
    expect(railDotShows(true, '/settings', '#remote-hosts')).toBe(false)
    expect(railDotShows(true, '/settings', '#rh-host-netbox')).toBe(false)
    expect(railDotShows(true, '/settings', '#engines')).toBe(true)
    expect(railDotShows(false, '/')).toBe(false)
    expect(railDotShows(false, '/settings')).toBe(false)
  })

  it('attentionDotsOf: Home lights both marks for a host problem; the remote hosts pane keeps only the local reason', () => {
    const dots = (hostOn: boolean, localOn: boolean, pathname = '/', hash = '') => attentionDotsOf({ hostOn, localOn, pathname, hash })
    expect(dots(true, false)).toEqual({ railSettingsDot: true, bellReason: 'hosts' })
    expect(dots(true, false, '/notes')).toEqual({ railSettingsDot: true, bellReason: 'hosts' })
    expect(dots(false, true)).toEqual({ railSettingsDot: false, bellReason: 'local' })
    expect(dots(true, true)).toEqual({ railSettingsDot: true, bellReason: 'both' })
    expect(dots(true, true, '/settings', '#rh-host-netbox')).toEqual({ railSettingsDot: false, bellReason: 'local' })
    expect(dots(false, false)).toEqual({ railSettingsDot: false, bellReason: null })
  })
})

describe('hostAttentionOf runs the problem-row model', () => {
  const NOW = 1_000_000_000
  const failed = (host: string, label: string): HostStatusInput & { label: string } => ({
    host, label, connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: connect failed', hint: 'Check the network, then Retry.',
    retryable: true, at: NOW,
  })

  it('a dismissed row lights nothing', () => {
    const s = [failed('netbox', 'Net box')]
    expect(hostAttentionOf({ statuses: s, dismissed: new Set(), now: NOW }).on).toBe(true)
    expect(hostAttentionOf({ statuses: s, dismissed: new Set(['netbox|connect']), now: NOW }).on).toBe(false)
  })

  it('a reconnect with a cause flips on at 2 minutes, and says when (no new frame needed)', () => {
    const s: HostStatusInput & { label: string } = { host: 'devbox', label: 'Dev box', connected: false, phase: 'reconnecting', lastKind: 'timeout', reconnectSince: NOW - 60_000, at: NOW }
    expect(hostAttentionOf({ statuses: [s], dismissed: new Set(), now: NOW })).toEqual({ on: false, wakeAt: NOW + 60_000 })
    expect(hostAttentionOf({ statuses: [s], dismissed: new Set(), now: NOW + 60_001 }).on).toBe(true)
  })
})
