/**
 * The at-rest decision says which way it went (src/providers/host-resume.ts resumeHostOf): with the
 * switch on for a legacy session's host, every delivery that does not ask the host logs one line
 * naming why (NoResumeHost); with the switch off for that host, or for every host, it is quiet, and
 * off for every host it reads no row.
 *
 * The incident this guards (2026-11-23): a host turned on whose running service was a build from
 * before session-resume-v1 kept a stopped session legacy on every send with no line at all, so the
 * leader's log could not tell an older host from a bug.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ row: null as { host: string | null; judgedByHost: boolean } | null, reads: 0 }))
vi.mock('../../src/core/session-db.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionJudgeInStore: vi.fn(() => { store.reads++; return store.row }),
}))

import { log } from '../../src/logging/index.js'
import { resumeHostOf, _holdLegacyForTesting, _resetHostResumeForTesting, type NoResumeHost } from '../../src/providers/host-resume.js'
import { _setHostResumesForTesting, _setHostSwitchForTesting, forgetHostResumes } from '../../src/core/session-channel/resume-hosts.js'
import { _resetJudgeOfForTesting, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'

const SID = 'sid-decision-log'
const HOST = 'devbox-a'
let info: ReturnType<typeof vi.spyOn>

/** The decision lines resumeHostOf wrote. */
const lines = () => info.mock.calls.filter((c) => String(c[0]).startsWith('host resume:')).map((c) => c[1] as Record<string, unknown>)

beforeEach(() => {
  _resetHostResumeForTesting()
  _resetJudgeOfForTesting()
  forgetHostResumes()
  store.row = { host: HOST, judgedByHost: false }
  store.reads = 0
  // The host as the incident had it, but new enough: switch on, linked and judging, takes a resume.
  _setHostSwitchForTesting((h) => h === HOST)
  setHostJudgeProbe((h) => h === HOST)
  _setHostResumesForTesting(HOST, true)
  info = vi.spyOn(log.session, 'info')
})
afterEach(() => {
  info.mockRestore()
  forgetHostResumes()
  _resetJudgeOfForTesting()
})

const REASONS: Record<NoResumeHost, () => void> = {
  held_legacy: () => _holdLegacyForTesting(SID),
  // The incident: the host's running service names session-judge-v1 but not session-resume-v1.
  host_takes_no_resume: () => _setHostResumesForTesting(HOST, false),
  host_not_judging: () => setHostJudgeProbe(() => false),
}

describe('with the switch on for the session\'s host', () => {
  it.each(Object.keys(REASONS) as NoResumeHost[])('%s: stays legacy with one line naming why', (why) => {
    REASONS[why]()
    expect(resumeHostOf(SID)).toBeNull()
    expect(lines()).toEqual([{ sessionId: SID, host: HOST, why }])
  })

  it('a host that takes the resume is named, and the hand-over (resumeAtRestOnHost) logs its own outcome', () => {
    expect(resumeHostOf(SID)).toBe(HOST)
    expect(lines()).toEqual([])
  })

  it('a held session is asked about again once its hold ran out', () => {
    vi.useFakeTimers()
    try {
      _holdLegacyForTesting(SID)
      vi.advanceTimersByTime(10 * 60_000 + 1)
      expect(resumeHostOf(SID)).toBe(HOST)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each<[string, typeof store.row]>([
    ['no row', null],
    ['a host-judged session (its own route)', { host: HOST, judgedByHost: true }],
    ['a session of this machine', { host: '__local__', judgedByHost: false }],
    ['a session with no host', { host: null, judgedByHost: false }],
  ])('%s is no candidate: null, no line', (_name, row) => {
    store.row = row
    expect(resumeHostOf(SID)).toBeNull()
    expect(lines()).toEqual([])
  })
})

describe('with the switch off', () => {
  it('off for the session\'s host (on for another): null, no line', () => {
    _setHostSwitchForTesting((h) => h === 'devbox-b')
    _setHostResumesForTesting(HOST, false)
    expect(resumeHostOf(SID)).toBeNull()
    expect(lines()).toEqual([])
  })

  it('off for every host: null, no line, and no row is read', () => {
    _setHostSwitchForTesting(null)
    expect(resumeHostOf(SID)).toBeNull()
    expect(lines()).toEqual([])
    expect(store.reads).toBe(0)
  })
})

describe('ratchet', () => {
  it('every NoResumeHost reason in the source has a case here', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/providers/host-resume.ts'), 'utf8')
    const union = /export type NoResumeHost =([^\n]+)/.exec(src)?.[1] ?? ''
    const named = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(named.length).toBeGreaterThan(0)
    expect(Object.keys(REASONS).sort()).toEqual(named)
  })
})
