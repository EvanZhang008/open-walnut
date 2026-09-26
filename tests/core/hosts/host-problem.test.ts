/**
 * The shared host problem model: one sentence per host problem on every surface
 * (banner, picker, Settings, error bar, the server's 409). Pure table tests.
 */
import { describe, it, expect } from 'vitest'
import {
  hostFailureHeadline, hostProblemOf, hostDotOf, hostActionsFor, joinLabels, credentialGroupHeadline,
  formatRetryIn, retryCountdownText, middleTruncatePath, hostGateBody, hostReadySentence,
  autofixProgressText, sameResultReceipt, firstSentence, listingProblemOf, READINESS_ANSWER_GRACE_MS,
  BANNER_READINESS_KINDS, BLOCKING_READINESS_KINDS, bannerReadinessProblem,
  type HostStatusInput,
} from '../../../src/core/hosts/host-problem.js'
import { PREFLIGHT_TIMEOUT_MS } from '../../../src/core/hosts/host-readiness.js'

const L = 'Dev box'
const NOW = 1_900_000_000_000

function st(o: Partial<HostStatusInput> = {}): HostStatusInput {
  return { host: 'devbox', label: L, hostname: 'devbox.example.com', connected: false, phase: 'idle', at: NOW, ...o }
}
const outdated = { kind: 'claude_outdated', message: 'Claude Code on Dev box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer. Update it.', commands: ['claude update'] }
function ready(o: Partial<HostStatusInput> = {}, problems = [outdated], checkedAt = NOW): HostStatusInput {
  return st({ connected: true, phase: 'connected', connectedAt: NOW - 60_000, readiness: { problems, checkedAt, claude: { version: '2.1.220', minVersion: '2.1.280' } }, ...o })
}

describe('hostFailureHeadline: one headline per kind (spec 2.1)', () => {
  it.each([
    ['auth', `Could not connect to ${L}`], ['host_key', `Could not connect to ${L}`], ['dns', `Could not connect to ${L}`],
    ['refused', `Could not connect to ${L}`], ['unreachable', `Could not connect to ${L}`], ['proxy', `Could not connect to ${L}`],
    ['shell_noise', `Could not connect to ${L}`], ['unknown', `Could not connect to ${L}`], [undefined, `Could not connect to ${L}`],
    ['cert_expired', `Could not connect to ${L}: SSH certificate expired`],
    ['agent_missing', `Could not connect to ${L}: no SSH agent key`],
    ['timeout', `Connecting to ${L} timed out`],
    ['runtime', `${L} has no runtime for the session daemon`],
    ['daemon', `The session daemon on ${L} did not start`],
    ['listing', `Could not list this folder on ${L}`],
  ])('%s', (kind, want) => {
    expect(hostFailureHeadline(kind, L)).toBe(want)
  })
  it('listing names the path; the give-up headline wins over any kind', () => {
    expect(hostFailureHeadline('listing', L, { path: '/srv/data' })).toBe(`Could not list /srv/data on ${L}`)
    expect(hostFailureHeadline('timeout', L, { giveUp: true })).toBe(`Still connecting to ${L} after several minutes`)
  })
  it('credential group rows join labels', () => {
    expect(joinLabels([])).toBe('')
    expect(joinLabels(['A'])).toBe('A')
    expect(joinLabels(['A', 'B'])).toBe('A and B')
    expect(joinLabels(['A', 'B', 'C'])).toBe('A, B and C')
    expect(credentialGroupHeadline(['Dev box', 'Build box'], 'cert_expired'))
      .toBe('Could not connect to Dev box and Build box: SSH certificate expired')
  })
})

describe('C86: a long path is cut in the middle, keeping the first and last segments', () => {
  it('truncates with U+2026', () => {
    const out = middleTruncatePath('/srv/a/b/c/d/e/f/g/data')
    expect(out).toBe('/srv/…/g/data')
    expect(hostFailureHeadline('listing', L, { path: '/srv/a/b/c/d/e/f/g/data' })).toBe(`Could not list /srv/…/g/data on ${L}`)
  })
  it('leaves short paths alone and keeps only the last segment when two do not fit', () => {
    expect(middleTruncatePath('/srv/data')).toBe('/srv/data')
    expect(middleTruncatePath('~/work/app')).toBe('~/work/app')
    const long = `/home/${'x'.repeat(20)}/${'y'.repeat(30)}/final`
    const out = middleTruncatePath(long)
    expect(out.startsWith('/home/…/')).toBe(true)
    expect(out.endsWith('/final')).toBe(true)
  })
})

describe('hostProblemOf: one problem per host, by priority', () => {
  it('off beats everything, including an old server that reports ephemeral as failed', () => {
    expect(hostProblemOf(st({ phase: 'off' }))).toEqual({ type: 'off' })
    expect(hostProblemOf(st({ phase: 'failed', kind: 'ephemeral', error: 'x' }))).toEqual({ type: 'off' })
  })
  it('a failed connect carries headline, verbatim hint, raw summary, retryable and a real retryAt', () => {
    const p = hostProblemOf(st({ phase: 'failed', kind: 'cert_expired', error: 'ssh: cert expired', hint: 'Run login.', retryable: false, retryAt: NOW + 5000 }))
    expect(p).toEqual({
      type: 'connect', kind: 'cert_expired', headline: `Could not connect to ${L}: SSH certificate expired`,
      hint: 'Run login.', summary: 'ssh: cert expired', retryable: false, retryAt: NOW + 5000, dismissKey: 'devbox|connect',
    })
    const q = hostProblemOf(st({ phase: 'failed', error: 'boom' }))
    expect(q).toMatchObject({ type: 'connect', kind: 'unknown', retryable: true, hint: '' })
    expect(q).not.toHaveProperty('retryAt')
  })
  it('reconnecting carries the last failure and the server start time', () => {
    expect(hostProblemOf(st({ phase: 'reconnecting', lastKind: 'timeout', lastHint: 'VPN?', reconnectSince: NOW - 9000 })))
      .toEqual({ type: 'reconnecting', kind: 'timeout', headline: `Connecting to ${L} timed out`, hint: 'VPN?', since: NOW - 9000 })
    expect(hostProblemOf(st({ phase: 'reconnecting', attemptStartedAt: NOW - 1 }))).toEqual({ type: 'reconnecting', since: NOW - 1 })
  })
  it('readiness: only blocking kinds, only answers from this connection', () => {
    const p = hostProblemOf(ready())
    expect(p).toEqual({ type: 'readiness', problem: outdated, blocking: true, dismissKey: 'devbox|claude_outdated|2.1.280' })
    const nonBlocking = { kind: 'compiler_missing', message: 'No C compiler on Dev box.', commands: [] }
    expect(hostProblemOf(ready({}, [nonBlocking]))).toBeNull()
    expect(hostProblemOf(ready({}, [outdated], NOW - 120_000))).toBeNull()
    expect(hostProblemOf(ready({ readiness: undefined }))).toBeNull()
  })
  it('banner surface: only BANNER_READINESS_KINDS, so a version floor (claude_outdated) is never a banner problem', () => {
    expect(BANNER_READINESS_KINDS).toEqual(['claude_missing', 'claude_needs_node', 'claude_error', 'claude_not_logged_in'])
    expect(BLOCKING_READINESS_KINDS.filter((k) => !BANNER_READINESS_KINDS.includes(k))).toEqual(['claude_outdated'])
    const signedOut = { kind: 'claude_not_logged_in', message: 'Claude Code on Dev box is not signed in.', commands: ['ssh -t alice@devbox.example.com claude'] }
    // Outdated alone: still the readiness problem everywhere else, nothing for the banner.
    expect(bannerReadinessProblem(ready())).toBeUndefined()
    expect(hostProblemOf(ready(), { surface: 'banner' })).toBeNull()
    expect(hostProblemOf(ready())).toMatchObject({ type: 'readiness', problem: { kind: 'claude_outdated' } })
    // Outdated first, signed out second: the banner takes the first BANNER kind, the rest the first blocking one.
    const both = ready({}, [outdated, signedOut])
    expect(bannerReadinessProblem(both)).toBe(signedOut)
    expect(hostProblemOf(both, { surface: 'banner' }))
      .toEqual({ type: 'readiness', problem: signedOut, blocking: true, dismissKey: 'devbox|claude_not_logged_in|2.1.280' })
    expect(hostProblemOf(both)).toEqual({ type: 'readiness', problem: outdated, blocking: true, dismissKey: 'devbox|claude_outdated|2.1.280' })
    for (const kind of BANNER_READINESS_KINDS) {
      expect(bannerReadinessProblem(ready({}, [{ kind, message: 'x', commands: [] }]))?.kind).toBe(kind)
    }
    // Only the readiness step narrows: the same freshness rule, and connect / off problems are unchanged.
    expect(hostProblemOf(ready({}, [signedOut], NOW - 120_000), { surface: 'banner' })).toBeNull()
    expect(hostProblemOf(st({ phase: 'failed', kind: 'auth' }), { surface: 'banner' })).toMatchObject({ type: 'connect', kind: 'auth' })
    expect(hostProblemOf(st({ phase: 'off' }), { surface: 'banner' })).toEqual({ type: 'off' })
    expect(bannerReadinessProblem(undefined)).toBeUndefined()
  })
  it('the dismiss key falls back to the claude version, then empty', () => {
    const s = ready()
    s.readiness!.claude = { version: '2.1.220' }
    expect(hostProblemOf(s)).toMatchObject({ dismissKey: 'devbox|claude_outdated|2.1.220' })
    s.readiness!.claude = undefined
    expect(hostProblemOf(s)).toMatchObject({ dismissKey: 'devbox|claude_outdated|' })
  })
  it('healthy, connecting, removed and missing hosts have no problem', () => {
    expect(hostProblemOf(ready({}, []))).toBeNull()
    expect(hostProblemOf(st({ phase: 'ssh' }))).toBeNull()
    expect(hostProblemOf(st({ phase: 'failed', removed: true }))).toBeNull()
    expect(hostProblemOf(undefined)).toBeNull()
  })
  it('listing problems come from list-dirs, never from a status', () => {
    expect(listingProblemOf({ kind: 'listing', message: 'EACCES', hint: 'Check it.' }, L, '/srv/data'))
      .toEqual({ type: 'listing', headline: `Could not list /srv/data on ${L}`, hint: 'Check it.', summary: 'EACCES' })
    expect(listingProblemOf({ kind: 'auth', message: 'x', hint: 'y' }, L)).toBeNull()
  })
})

describe('hostDotOf: shape + title (spec 4.1)', () => {
  const now = NOW
  it.each([
    ['off', st({ phase: 'off' }), 'off', `${L}: Off on this test server`],
    ['failed', st({ phase: 'failed', kind: 'timeout' }), 'failed', `${L}: Connecting to ${L} timed out`],
    ['reconnecting', st({ phase: 'reconnecting' }), 'connecting', `${L}: Reconnecting`],
    ['connecting', st({ phase: 'ssh' }), 'connecting', `${L}: Connecting`],
    ['warn', ready(), 'warn', `${L}: Claude Code on Dev box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.`],
    ['connected', ready({}, []), 'connected', `${L}: Connected`],
  ])('%s', (_n, s, kind, title) => {
    expect(hostDotOf(s, { now })).toEqual({ kind, title })
  })
  it('checking while a fresh connection has no readiness answer, connected after the grace', () => {
    const fresh = st({ connected: true, phase: 'connected', connectedAt: now - 3000 })
    expect(hostDotOf(fresh, { now })).toEqual({ kind: 'checking', title: `${L}: Checking Claude Code` })
    const stale = ready({ connectedAt: now - 3000 }, [outdated], now - 60_000)
    expect(hostDotOf(stale, { now }).kind).toBe('checking')
    expect(hostDotOf(fresh, { now: now - 3000 + READINESS_ANSWER_GRACE_MS + 1 }).kind).toBe('connected')
  })
  it('unknown while the store is hydrating', () => {
    expect(hostDotOf(undefined, { now, hydrating: true, label: L })).toEqual({ kind: 'unknown', title: `${L}: Checking...` })
  })
  it('ratchet: the grace is the server preflight deadline plus 5s', () => {
    expect(READINESS_ANSWER_GRACE_MS).toBe(PREFLIGHT_TIMEOUT_MS + 5000)
  })
})

describe('hostActionsFor: no fake buttons (spec 2.2)', () => {
  const connect = hostProblemOf(st({ phase: 'failed', kind: 'unreachable', retryable: true }))
  const standing = hostProblemOf(st({ phase: 'failed', kind: 'auth', retryable: false }))
  const readiness = hostProblemOf(ready())
  const recon = hostProblemOf(st({ phase: 'reconnecting', lastKind: 'timeout', reconnectSince: NOW }))
  it('connect: Retry everywhere; Open Settings second when retrying alone cannot help (not in Settings)', () => {
    for (const surface of ['banner', 'picker', 'errorbar', 'settings'] as const) {
      expect(hostActionsFor(connect, { surface })).toEqual(['retry'])
    }
    expect(hostActionsFor(standing, { surface: 'banner' })).toEqual(['retry', 'openSettings'])
    expect(hostActionsFor(standing, { surface: 'picker' })).toEqual(['retry', 'openSettings'])
    expect(hostActionsFor(standing, { surface: 'settings' })).toEqual(['retry'])
  })
  it('reconnecting: Connect now in Settings; a banner row only after 2 minutes with a cause', () => {
    expect(hostActionsFor(recon, { surface: 'settings' })).toEqual(['connectNow'])
    expect(hostActionsFor(recon, { surface: 'picker' })).toEqual([])
    expect(hostActionsFor(recon, { surface: 'banner', reconnectAgeMs: 60_000 })).toEqual([])
    expect(hostActionsFor(recon, { surface: 'banner', reconnectAgeMs: 120_000 })).toEqual(['connectNow'])
  })
  it('readiness with and without an autofix, and the error bar override', () => {
    expect(hostActionsFor(readiness, { surface: 'banner', autofixable: true })).toEqual(['update', 'checkAgain'])
    expect(hostActionsFor(readiness, { surface: 'settings', autofixable: 'install' })).toEqual(['install', 'checkAgain'])
    expect(hostActionsFor(readiness, { surface: 'picker', autofixable: true })).toEqual(['checkAgain', 'openSettings'])
    expect(hostActionsFor(readiness, { surface: 'banner' })).toEqual(['checkAgain', 'openSettings'])
    expect(hostActionsFor(readiness, { surface: 'settings' })).toEqual(['checkAgain'])
    expect(hostActionsFor(readiness, { surface: 'errorbar', allowOverride: true })).toEqual(['checkAgain', 'startAnyway', 'openSettings'])
    expect(hostActionsFor(readiness, { surface: 'errorbar' })).toEqual(['checkAgain', 'openSettings'])
  })
  it('listing retries only in the picker; off and null have nothing', () => {
    const listing = listingProblemOf({ kind: 'listing', message: '', hint: '' }, L)
    expect(hostActionsFor(listing, { surface: 'picker' })).toEqual(['retry'])
    expect(hostActionsFor(listing, { surface: 'banner' })).toEqual([])
    expect(hostActionsFor({ type: 'off' }, { surface: 'picker' })).toEqual([])
    expect(hostActionsFor(null, { surface: 'banner' })).toEqual([])
  })
  it('a replica never dials or fixes; Check again (relayed) and Open Settings stay', () => {
    expect(hostActionsFor(standing, { surface: 'banner', replica: true })).toEqual(['openSettings'])
    expect(hostActionsFor(connect, { surface: 'settings', replica: true })).toEqual([])
    expect(hostActionsFor(recon, { surface: 'settings', replica: true })).toEqual([])
    expect(hostActionsFor(readiness, { surface: 'banner', replica: true, autofixable: true })).toEqual(['checkAgain'])
  })
})

describe('C60: countdown formats and the stale line', () => {
  it('three formats', () => {
    expect(formatRetryIn(42_000)).toBe('42s')
    expect(formatRetryIn(192_000)).toBe('3m 12s')
    expect(formatRetryIn(3_600_000)).toBe('1h 0m')
    expect(formatRetryIn(400)).toBe('1s')
  })
  it('counts down, then Trying again..., then nothing 31s later without a newer frame', () => {
    const at = NOW + 192_000
    expect(retryCountdownText(at, NOW)).toBe('Walnut tries again in 3m 12s')
    expect(retryCountdownText(at, at)).toBe('Trying again...')
    expect(retryCountdownText(at, at + 10_000)).toBe('Trying again...')
    expect(retryCountdownText(at, at + 31_000)).toBeNull()
    expect(retryCountdownText(at, at + 31_000, at + 2_000)).toBe('Trying again...')
    expect(retryCountdownText(undefined, NOW)).toBeNull()
  })
})

describe('C75: the Start refusal body', () => {
  it('headline and hint are separate fields; error joins them once', () => {
    const b = hostGateBody({ code: 'host_unreachable', host: 'devbox', kind: 'timeout', headline: `Connecting to ${L} timed out`, hint: 'Retry in a moment.' })
    expect(b).toEqual({ error: `Connecting to ${L} timed out. Retry in a moment.`, code: 'host_unreachable', kind: 'timeout', host: 'devbox', headline: `Connecting to ${L} timed out`, hint: 'Retry in a moment.' })
  })
  it('no hint: no dangling ". "; a sentence headline keeps its single period', () => {
    const b = hostGateBody({ code: 'host_unreachable', host: 'devbox', headline: `Could not connect to ${L}`, hint: '' })
    expect(b.error).toBe(`Could not connect to ${L}`)
    expect(b.error.endsWith('.')).toBe(false)
    const r = hostGateBody({ code: 'host_not_ready', host: 'devbox', kind: 'claude_outdated', headline: outdated.message, allowOverride: true })
    expect(r.error).toBe(outdated.message)
    expect(r.error.endsWith('..')).toBe(false)
    expect(r.allowOverride).toBe(true)
    const s = hostGateBody({ code: 'host_not_ready', host: 'devbox', headline: 'Claude Code is not installed on Dev box.', hint: 'Install it.' })
    expect(s.error).toBe('Claude Code is not installed on Dev box. Install it.')
    expect(hostGateBody({ code: 'host_off', host: 'devbox', headline: 'x' })).not.toHaveProperty('allowOverride')
  })
})

describe('success, progress and receipts', () => {
  it('one success sentence', () => {
    expect(hostReadySentence(L, '2.1.281')).toBe('✓ Dev box is ready (Claude Code 2.1.281)')
    expect(hostReadySentence(L)).toBe('✓ Dev box is ready')
  })
  it('autofix progress: plain, then the elapsed time after 5s, then Still ... with Check again after 3 minutes', () => {
    expect(autofixProgressText('update', L, NOW, NOW + 2000)).toEqual({ text: 'Updating Claude Code on Dev box...', base: 'Updating Claude Code on Dev box...', elapsed: '', showCheckAgain: false })
    expect(autofixProgressText('update', L, NOW, NOW + 42_000).text).toBe('Updating Claude Code on Dev box... 42s')
    expect(autofixProgressText('install', L, NOW, NOW + 185_000)).toMatchObject({ text: 'Still installing Claude Code on Dev box... 3m 5s', showCheckAgain: true })
  })
  it('same result receipts', () => {
    const f1 = st({ phase: 'failed', kind: 'timeout', at: NOW })
    const f2 = st({ phase: 'failed', kind: 'timeout', at: NOW + 1 })
    expect(sameResultReceipt(f1, f2, 'connect')).toBe('Tried again just now: same result')
    expect(sameResultReceipt(f1, st({ phase: 'failed', kind: 'auth' }), 'connect')).toBeNull()
    expect(sameResultReceipt(f1, ready({}, []), 'connect')).toBeNull()
    expect(sameResultReceipt(ready(), ready(), 'readiness')).toBe('Checked just now: still 2.1.220')
    const newer = ready()
    newer.readiness!.claude = { version: '2.1.230', minVersion: '2.1.280' }
    expect(sameResultReceipt(ready(), newer, 'readiness')).toBeNull()
  })
  it('firstSentence ignores version dots and code', () => {
    expect(firstSentence(outdated.message)).toBe('Claude Code on Dev box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.')
    expect(firstSentence('Run `a. b` now. Then more.')).toBe('Run `a. b` now.')
    expect(firstSentence('No period')).toBe('No period')
  })
})

describe('C45: the model has no dashes and no node imports', () => {
  it('source check', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../../src/core/hosts/host-problem.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/[\u2013\u2014]/)
    expect(src).not.toMatch(/^import\s/m)
    expect(src.split('\n').length).toBeLessThan(500)
  })
})
