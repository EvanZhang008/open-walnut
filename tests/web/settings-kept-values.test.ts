/**
 * Settings keeps a value it showed until a newer one arrives (2026-11-04 rule): a
 * failed read, a server that does not answer now or a restart says so beside the
 * last known value, never instead of it. The pure parts of three rows: Keep awake's
 * status, "Walnut on this host" (a host's Details), and the cloud companion's Updates row.
 */
import { describe, expect, it } from 'vitest'
import { KEEP_AWAKE_UNREAD, keepAwakeAfterRead, keepAwakeWithState, type KeepAwakeStatus } from '../../web/src/components/settings/sections/AdvancedSection.js'
import { describeHostServer, type HostServerEntry, type HostServerView } from '../../web/src/components/settings/sections/host-servers-status.js'
import { companionUpdatesSentence } from '../../web/src/components/settings/sections/cloud/companion-updates-copy.js'
import type { CompanionBuildView } from '../../web/src/api/companion-build.js'

const NOW = Date.parse('2026-11-04T12:00:00Z')

describe('keepAwakeAfterRead', () => {
  const status = { state: { holding: true }, sudoSetupCommand: 'x' } as unknown as KeepAwakeStatus
  it('a failed refresh keeps the status it showed and marks the failure', () => {
    const shown = keepAwakeAfterRead(KEEP_AWAKE_UNREAD, { ok: status }, NOW)
    const failed = keepAwakeAfterRead(shown, { failed: true }, NOW + 1)
    expect(failed.status).toBe(status)
    expect(failed.failedAt).toBe(NOW + 1)
    // The next read that works clears the failure.
    expect(keepAwakeAfterRead(failed, { ok: status }, NOW + 2)).toEqual({ status, failedAt: null })
  })
  it('a fresh state from the one-click setup clears an earlier failure', () => {
    const failed = keepAwakeAfterRead(keepAwakeAfterRead(KEEP_AWAKE_UNREAD, { ok: status }, NOW), { failed: true }, NOW + 1)
    expect(failed.failedAt).toBe(NOW + 1)
    const fresh = { ...status.state, setupDone: true }
    const after = keepAwakeWithState(failed, fresh)
    expect(after.failedAt).toBeNull()
    expect(after.status?.state).toEqual(fresh)
    expect(after.status?.sudoSetupCommand).toBe('x')
  })
  it('with nothing known yet a failure stays hidden (the route is absent off macOS)', () => {
    expect(keepAwakeAfterRead(KEEP_AWAKE_UNREAD, { failed: true }, NOW)).toEqual({ status: null, failedAt: null })
  })
})

describe('describeHostServer with a kept report', () => {
  const entry = (view: Partial<HostServerView>): HostServerEntry => ({
    hostKey: 'devbox', label: 'Dev box',
    settings: { enabled: true, expose: { enabled: true, provider: 'acme', options: {} } },
    view: { hostKey: 'devbox', enabled: true, phase: 'off', since: 0, ...view },
  })
  const lastReport = { version: '0.6.7', commit: 'abc1234', expose: { enabled: true, provider: 'acme', state: 'connected' as const, since: 0, url: 'https://devbox.example.net' } }
  it('says the build and address it last reported, and how long ago, beside "not answering now"', () => {
    const line = describeHostServer(entry({ phase: 'starting', message: 'Waiting for the server on the host to answer.', server: null, lastReport, lastReportAt: NOW - 5 * 60_000 }), NOW)
    expect(line.text).toBe('Waiting for the server on the host to answer. Last answered 5 min ago: Walnut 0.6.7 (abc1234), at devbox.example.net.')
    expect(describeHostServer(entry({ phase: 'error', message: 'It stopped.', lastReport, lastReportAt: NOW - 2 * 3_600_000 }), NOW).text)
      .toContain('Last answered 2 h ago')
  })
  it('running shows the live report only, and an older server (no lastReport) reads as before', () => {
    expect(describeHostServer(entry({ phase: 'running', server: { route: { kind: 'leader' } }, lastReport, lastReportAt: NOW }), NOW).text)
      .toBe('Running. A browser there reaches this Mac.')
    expect(describeHostServer(entry({ phase: 'starting', message: 'Waiting.' }), NOW).text).toBe('Waiting.')
  })
})

describe('companionUpdatesSentence with the build last seen', () => {
  const v = (over: Partial<CompanionBuildView>): CompanionBuildView => ({
    state: 'checking', mine: '0.6.14-5408d5875', theirs: null, autoUpdate: true, at: 0, ...over,
  })
  it('after a restart, checking shows the build last seen and its age instead of only "checking"', () => {
    expect(companionUpdatesSentence(v({ lastSeen: { theirs: '0.6.14-5408d5875', at: NOW - 3 * 60_000 } }), NOW))
      .toBe("Last seen running 0.6.14-5408d5875 (this Mac's build), 3 min ago; checking again.")
    expect(companionUpdatesSentence(v({ mine: null, lastSeen: { theirs: '0.6.13-1111111', at: NOW - 3 * 60_000 } }), NOW))
      .toBe('Last seen running 0.6.13-1111111, 3 min ago; checking again.')
  })
  it('a look that could not reach it keeps the build last seen beside the failure', () => {
    expect(companionUpdatesSentence(v({ state: 'unreachable', lastSeen: { theirs: '0.6.13-1111111', at: NOW - 10 * 60_000 } }), NOW))
      .toBe('Could not reach the companion just now; last seen running 0.6.13-1111111, 10 min ago. Walnut tries again in a few minutes.')
  })
  it('with nothing seen yet it reads as before', () => {
    expect(companionUpdatesSentence(v({}), NOW)).toBe('Checking which build the companion runs.')
  })
})
