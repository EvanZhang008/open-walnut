/**
 * A host's launcher on the server (src/core/hosts/host-launcher.ts) and what its daemon sends in hello
 * (src/providers/service-launcher-beat.ts): the facts checked field by field, the card's words, the
 * Walnut Health item of a put-back, and the Settings row (web host-fleet-model.ts launcherWords).
 */
import { describe, expect, it } from 'vitest'
import { fleetLauncher, launcherRollbackItem, launcherVersionWords } from '../../../src/core/hosts/host-launcher.js'
import { launcherFactsFrom, parseLauncherFacts } from '../../../src/providers/service-launcher-beat.js'
import { launcherWords } from '../../../web/src/components/settings/sections/host-fleet-model'

const V = (c: string) => `/home/u/.local/share/open-walnut/daemon/versions/${c.repeat(64)}/daemon`

describe('the launcher facts', () => {
  it('reads the launcher state and its last put-back, and nothing from a state that does not hold together', () => {
    const facts = parseLauncherFacts(`current=${V('b')}\ngood=${V('a')}\nphase=probation\nsince=100\nbuild=walnut-daemon-bbbb\n`, `at=90\nfrom=${V('c')}\nto=${V('a')}\nreason=not ready\n`)
    expect(facts).toEqual({ current: V('b'), good: V('a'), phase: 'probation', since: 100, build: 'walnut-daemon-bbbb', rollback: { at: 90, from: V('c'), to: V('a'), reason: 'not ready' } })
    expect(parseLauncherFacts('current=relative\nphase=committed\n')).toBeNull()
    expect(parseLauncherFacts(`current=${V('b')}\nphase=dancing\n`)).toBeNull()
  })

  it('takes a host\'s hello facts only when each field is sane', () => {
    expect(launcherFactsFrom({ current: V('b'), good: V('a'), phase: 'committed', since: 5 })).toMatchObject({ current: V('b'), phase: 'committed' })
    expect(launcherFactsFrom({ current: V('b'), phase: 'committed', rollback: { at: 1, from: V('c'), reason: 'x\u0000y' } })?.rollback).toBeUndefined()
    expect(launcherFactsFrom({ current: 'nope', phase: 'committed' })).toBeNull()
    expect(launcherFactsFrom('text')).toBeNull()
  })
})

describe('the card and Walnut Health', () => {
  it('names a version by its build, else the start of its version dir', () => {
    expect(launcherVersionWords(V('b'), 'walnut-daemon-1234abcd')).toBe('build 1234abcd')
    expect(launcherVersionWords(V('b'))).toBe(`version ${'b'.repeat(12)}`)
  })

  it('a put-back is one warning in Walnut Health, keyed by host and time, never a needs-you', () => {
    const item = launcherRollbackItem('devbox', 'Dev box', { current: V('a'), good: V('a'), phase: 'committed', since: 1, rollback: { at: 1_795_000_000, from: V('c'), to: V('a'), build: 'walnut-daemon-cccc', reason: 'the new version was not ready within 90 s' } })!
    expect(item).toMatchObject({ kind: 'operation-error', severity: 'warning', dedupKey: 'host-launcher-rollback:devbox:1795000000', host: 'devbox' })
    expect(item.title).toBe('Walnut on Dev box went back to its previous version')
    expect(item.body).toContain('build cccc did not hold: the new version was not ready within 90 s')
    expect(item).not.toHaveProperty('needsYou')
    expect(launcherRollbackItem('devbox', 'Dev box', { current: V('a'), good: V('a'), phase: 'committed', since: 1 })).toBeNull()
  })

  it('the Session helper row says a probation and a recent put-back, and only the tooltip an old one', () => {
    const now = 1_795_000_000_000
    const watching = fleetLauncher({ current: V('b'), good: V('a'), phase: 'probation', since: now / 1000 - 60, build: 'walnut-daemon-bbbb' })!
    expect(launcherWords(watching, now).value).toMatch(/^watching build bbbb until .* \(goes back to version a{12} if it fails\)$/)
    const back = fleetLauncher({ current: V('a'), good: V('a'), phase: 'committed', since: 1, rollback: { at: now / 1000 - 3600, from: V('c'), to: V('a'), reason: 'crashed twice' } })!
    expect(launcherWords(back, now).value).toMatch(/^went back from version c{12} /)
    expect(launcherWords(back, now + 2 * 86_400_000).value).toBeNull()
    expect(launcherWords(back, now + 2 * 86_400_000).title).toContain('crashed twice')
    expect(launcherWords(null, now)).toEqual({ value: null, title: '' })
  })
})
