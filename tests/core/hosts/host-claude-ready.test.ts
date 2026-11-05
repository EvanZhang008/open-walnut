/**
 * Walnut never picks, on its own, a host that cannot start a Claude Code session, and a host
 * nothing uses for sessions takes no attention card (2026-11-05: a fleet Mac with no Claude
 * Code was the first card in System attention, and placement scored it like any other host).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeSessionBlocker, claudeUnusableProblem, clearHostReadiness, getHostReadiness, setHostReadinessForTest,
} from '../../../src/core/hosts/host-readiness.js'
import { READINESS_PROBLEM_KINDS } from '../../../src/core/hosts/host-readiness-problems.js'
import { markCheckFailed } from '../../../src/core/hosts/host-readiness-store.js'
import { BANNER_READINESS_KINDS, BLOCKING_READINESS_KINDS } from '../../../src/core/hosts/host-problem.js'
import { _setHostsUsedForSessions } from '../../../src/core/hosts/host-session-use.js'
import { hostEnginesAvailability } from '../../../src/core/agents/host-engines.js'
import type { HostPreflightResult } from '../../../src/providers/host-runtime-types.js'

const ctx = { hostLabel: 'Fleet Mac', sshTarget: 'fleet.example.invalid' }
const base = (claude: Partial<HostPreflightResult['claude']>): HostPreflightResult => ({
  ok: true,
  claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '2.1.300', auth: 'ok', ...claude },
  compiler: { found: true, name: 'cc' }, dtach: { found: true }, platform: 'darwin', arch: 'x64',
} as HostPreflightResult)

afterEach(() => { clearHostReadiness(); _setHostsUsedForSessions(null) })

describe('a host Walnut may pick for a Claude Code session', () => {
  it('this Mac is never judged here, and a remote host not checked yet is not picked', () => {
    expect(claudeSessionBlocker('__local__')).toBeNull()
    expect(claudeSessionBlocker('fleet')).toBe('Walnut has not checked Claude Code on fleet yet')
  })

  it('a ready host is picked; one that is missing, needs node, broken, signed out, too old or could not be read is not', () => {
    setHostReadinessForTest('fleet', base({}), ctx)
    expect(claudeSessionBlocker('fleet')).toBeNull()
    setHostReadinessForTest('fleet', base({ version: '2.1.300' }), { ...ctx, floor: { minVersion: '2.1.280', model: 'Opus 5.5' } })
    expect(claudeSessionBlocker('fleet')).toBeNull()
    const cases: Array<[Partial<HostPreflightResult['claude']>, RegExp, object?]> = [
      [{ found: false, path: undefined, version: undefined }, /^Claude Code is not installed on Fleet Mac$/],
      [{ kind: 'npm', needsNode: true, nodeFound: false }, /no working Node\.js was found/],
      [{ error: 'exited with code 1' }, /^Claude Code did not start on Fleet Mac: exited with code 1$/],
      [{ auth: 'not-logged-in' }, /^Claude Code on Fleet Mac is not signed in/],
      [{ version: '2.1.200' }, /2\.1\.200/, { floor: { minVersion: '2.1.280', model: 'Opus 5.5' } }],
      [{ unknown: 'the login shell timed out' }, /^Walnut could not tell whether Claude Code runs on fleet$/],
      // Only a yes counts: a sign-in or version probe that gave no answer (or an older daemon
      // that does not report one) keeps the host out of automatic placement too.
      [{ auth: 'unknown', authDetail: 'claude auth status gave no answer' }, /^Walnut could not tell whether Claude Code on fleet is signed in$/],
      [{ auth: undefined }, /is signed in$/],
      [{ version: undefined }, /^Walnut could not read which Claude Code fleet runs$/],
      [{ version: undefined }, /^Walnut could not read which Claude Code fleet runs$/, { floor: { minVersion: '2.1.280', model: 'Opus 5.5' } }],
    ]
    for (const [claude, why, extra] of cases) {
      setHostReadinessForTest('fleet', base(claude), { ...ctx, ...(extra ?? {}) })
      expect(claudeSessionBlocker('fleet'), JSON.stringify(claude)).toMatch(why)
    }
  })

  it('a re-check that failed keeps the host out, though the answer before it was ready', () => {
    setHostReadinessForTest('fleet', base({}), ctx)
    markCheckFailed('fleet', 'the host gave no usable answer', Date.now())
    expect(claudeSessionBlocker('fleet')).toBe("Walnut's last check of Claude Code on fleet did not answer")
  })

  it('every readiness kind is sorted: it refuses a Claude Code start (placement skips the host) or it does not', () => {
    // A new kind fails here until it is put on one side; one that stops a session belongs in
    // BLOCKING_READINESS_KINDS, which keeps Walnut from picking the host by itself.
    const doesNotStopASession: Record<string, string> = {
      compiler_missing: 'only the terminal needs a compiler, for dtach',
      dtach_missing: 'only the terminal needs dtach',
      daemon_dir_fallback: 'the daemon runs from another folder, sessions start',
      disk_low: 'placement reads free disk itself',
    }
    for (const kind of READINESS_PROBLEM_KINDS) {
      const blocking = BLOCKING_READINESS_KINDS.includes(kind)
      expect(blocking !== Object.hasOwn(doesNotStopASession, kind), `${kind} must be on exactly one side`).toBe(true)
    }
    // Every kind that takes an attention card is one placement refuses.
    for (const kind of BANNER_READINESS_KINDS) expect(BLOCKING_READINESS_KINDS).toContain(kind)
  })
})

describe('the readiness every surface reads', () => {
  it('carries whether anything uses the host for sessions, once that is known', () => {
    setHostReadinessForTest('fleet', base({ found: false }), ctx)
    expect(getHostReadiness('fleet')!.usedForSessions).toBeUndefined()
    _setHostsUsedForSessions(['clouddev'])
    expect(getHostReadiness('fleet')!.usedForSessions).toBe(false)
    _setHostsUsedForSessions(['fleet'])
    expect(getHostReadiness('fleet')!.usedForSessions).toBe(true)
  })
})

describe('the engines a remote host runs', () => {
  it('reads Claude Code from the host\'s own check, not as always installed', async () => {
    // No open connection and no dial: only the stored check speaks.
    expect((await hostEnginesAvailability('fleet', { dial: false })).claude).toBeUndefined()
    setHostReadinessForTest('fleet', base({ found: false, version: undefined }), ctx)
    expect(claudeUnusableProblem('fleet')?.kind).toBe('claude_missing')
    expect((await hostEnginesAvailability('fleet', { dial: false })).claude)
      .toEqual({ installed: false, version: null, reason: 'Claude Code is not installed on Fleet Mac' })
    // Signed out is still installed: Start says so and may go ahead.
    setHostReadinessForTest('fleet', base({ auth: 'not-logged-in' }), ctx)
    expect((await hostEnginesAvailability('fleet', { dial: false })).claude).toEqual({ installed: true, version: '2.1.300', reason: null })
    // A check that could not tell is no answer, never "installed" (nor "not installed").
    setHostReadinessForTest('fleet', base({ found: false, unknown: 'the login shell did not answer in time' }), ctx)
    expect((await hostEnginesAvailability('fleet', { dial: false })).claude).toBeUndefined()
  })
})
