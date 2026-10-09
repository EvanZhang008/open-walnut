/**
 * The "Open from a browser" group's words per tunnel state
 * (web/src/components/settings/sections/cloud/browser-access-status.ts) and its
 * poll interval.
 */
import { describe, expect, it } from 'vitest'
import {
  describeExpose, exposePollMs, type ExposeStatus,
} from '../../web/src/components/settings/sections/cloud/browser-access-status.js'

const status = (over: Partial<ExposeStatus>): ExposeStatus => ({ enabled: true, provider: 'acme', providerTitle: 'Acme', state: 'off', since: 0, ...over })

describe('describeExpose', () => {
  it('before the first answer it reads, muted', () => {
    expect(describeExpose(null, 'Acme')).toMatchObject({ dot: 'pending', retry: false })
  })

  it('off and starting are muted; connected is done', () => {
    expect(describeExpose(status({ state: 'off' }), 'Acme')).toMatchObject({ dot: 'pending', retry: false })
    expect(describeExpose(status({ state: 'starting' }), 'Acme')).toMatchObject({ dot: 'pending', text: 'Starting Acme...' })
    expect(describeExpose(status({ state: 'connected', url: 'https://a.example' }), 'Acme')).toMatchObject({ dot: 'done', retry: false })
  })

  it('a sign-in or a missing command is the person\'s turn, with the provider\'s words and Retry', () => {
    const signIn = describeExpose(status({ state: 'needs-sign-in', hint: 'Run acme login.', lastError: 'Run acme login.' }), 'Acme')
    expect(signIn).toMatchObject({ dot: 'action', retry: true })
    expect(signIn.text).toBe('Run acme login.')
    const missing = describeExpose(status({ state: 'missing', lastError: 'Acme is not installed here (acme not found).', hint: 'Install acme.' }), 'Acme')
    expect(missing).toMatchObject({ dot: 'action', retry: true, text: 'Acme is not installed here (acme not found). Install acme.' })
  })

  it('a provider that stopped says why and when it tries again; one that cannot run offers no Retry', () => {
    const at = new Date(2026, 9, 9, 14, 5).getTime()
    const retrying = describeExpose(status({ state: 'retrying', lastError: 'Acme exited (code 1).', nextRetryAt: at }), 'Acme')
    expect(retrying).toMatchObject({ dot: 'error', retry: true })
    expect(retrying.text).toMatch(/^Acme exited \(code 1\)\. Trying again at /)
    expect(describeExpose(status({ state: 'unavailable', lastError: 'No tunnel provider named "acme" is installed.' }), 'Acme'))
      .toMatchObject({ dot: 'error', retry: false, text: 'No tunnel provider named "acme" is installed.' })
  })
})

describe('exposePollMs', () => {
  it('often while it moves or waits on the person, rarely once settled', () => {
    expect(exposePollMs(null)).toBe(3_000)
    for (const state of ['starting', 'retrying', 'needs-sign-in', 'missing'] as const) expect(exposePollMs(status({ state }))).toBe(3_000)
    for (const state of ['off', 'connected', 'unavailable'] as const) expect(exposePollMs(status({ state }))).toBe(30_000)
  })
})
