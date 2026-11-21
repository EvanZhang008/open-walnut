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

describe('describeExpose, the tunnel on a host', () => {
  const runsOn = { hostKey: 'devbox', label: 'Dev box', auto: true }

  it('names the host while it starts, connects and stops; the wait it reports while starting', () => {
    expect(describeExpose(status({ state: 'connected', runsOn, url: 'https://x.example' }), 'Acme').text).toBe('Connected through Acme on Dev box.')
    expect(describeExpose(status({ state: 'starting', runsOn }), 'Acme').text).toBe('Starting Acme on Dev box...')
    expect(describeExpose(status({ state: 'starting', runsOn, lastError: 'Waiting to connect to Dev box.' }), 'Acme').text).toBe('Waiting to connect to Dev box.')
    expect(describeExpose(status({ state: 'retrying', runsOn }), 'Acme').text).toBe('Acme stopped on Dev box.')
  })

  it('this computer\'s tunnel reads as before', () => {
    expect(describeExpose(status({ state: 'starting', lastError: 'ignored' }), 'Acme').text).toBe('Starting Acme...')
    expect(describeExpose(status({ state: 'connected' }), 'Acme').text).toBe('Connected through Acme.')
  })

  it('a CLI missing on the host names the host', () => {
    expect(describeExpose(status({ state: 'missing', runsOn, lastError: 'Acme is not installed (acme not found).', hint: 'Install acme.' }), 'Acme').text)
      .toBe('On Dev box: Acme is not installed (acme not found). Install acme.')
  })
})

describe('describeExpose, installing the CLI', () => {
  it('says it installs, here and on a host', () => {
    expect(describeExpose(status({ state: 'starting', activity: 'Installing Acme...' }), 'Acme')).toEqual({ dot: 'pending', text: 'Installing Acme...', retry: false })
    expect(describeExpose(status({ state: 'starting', activity: 'Installing Acme...', runsOn: { hostKey: 'devbox', label: 'Dev box', auto: true } }), 'Acme').text)
      .toBe('Installing Acme on Dev box...')
  })

  it('a failed install is the person\'s turn, with what it printed last and Retry', () => {
    expect(describeExpose(status({ state: 'missing', lastError: 'Installing Acme failed: no access.', hint: 'Install acme.' }), 'Acme'))
      .toMatchObject({ dot: 'action', retry: true, text: 'Installing Acme failed: no access. Install acme.' })
    // A reason or a hint without a full stop still reads as its own sentence.
    expect(describeExpose(status({ state: 'missing', lastError: 'Installing Acme failed: error: no access', hint: 'Install acme' }), 'Acme').text)
      .toBe('Installing Acme failed: error: no access. Install acme.')
    expect(describeExpose(status({ state: 'retrying', lastError: 'Error: connection refused' }), 'Acme').text).toBe('Error: connection refused.')
  })
})

describe('describeExpose, moving to a host', () => {
  const movingTo = { hostKey: 'devbox', label: 'Dev box' }

  it('connected here meanwhile, with what the host is doing', () => {
    expect(describeExpose(status({ state: 'connected', url: 'https://a.example', movingTo: { ...movingTo, note: 'Installing Walnut 1.2.3 on the host.' } }), 'Acme'))
      .toEqual({ dot: 'done', retry: false, text: 'Connected through Acme. Moving to Dev box once it runs there. Installing Walnut 1.2.3 on the host.' })
    // A note without a full stop gets one; none, no note.
    expect(describeExpose(status({ state: 'connected', movingTo: { ...movingTo, note: 'Installing Acme...' } }), 'Acme').text)
      .toBe('Connected through Acme. Moving to Dev box once it runs there. Installing Acme...')
    expect(describeExpose(status({ state: 'connected', movingTo: { ...movingTo, note: 'Waiting to connect to Dev box' } }), 'Acme').text)
      .toBe('Connected through Acme. Moving to Dev box once it runs there. Waiting to connect to Dev box.')
    expect(describeExpose(status({ state: 'connected', movingTo }), 'Acme').text).toBe('Connected through Acme. Moving to Dev box once it runs there.')
  })

  it('whatever the state here, the move is said too, and the state keeps its dot and Retry', () => {
    expect(describeExpose(status({ state: 'starting', movingTo }), 'Acme')).toEqual({ dot: 'pending', retry: false, text: 'Starting Acme... Moving to Dev box once it runs there.' })
    expect(describeExpose(status({ state: 'retrying', lastError: 'Acme exited (code 1).', movingTo }), 'Acme'))
      .toMatchObject({ dot: 'error', retry: true, text: 'Acme exited (code 1). Moving to Dev box once it runs there.' })
    // Off says nothing of a move.
    expect(describeExpose(status({ state: 'off', movingTo }), 'Acme').text).not.toMatch(/Moving/)
  })
})

describe('exposePollMs', () => {
  it('often while it moves or waits on the person, rarely once settled', () => {
    expect(exposePollMs(null)).toBe(3_000)
    for (const state of ['starting', 'retrying', 'needs-sign-in', 'missing'] as const) expect(exposePollMs(status({ state }))).toBe(3_000)
    for (const state of ['off', 'connected', 'unavailable'] as const) expect(exposePollMs(status({ state }))).toBe(30_000)
  })

  it('often while it moves to a host, connected here or not', () => {
    expect(exposePollMs(status({ state: 'connected', movingTo: { hostKey: 'devbox', label: 'Dev box' } }))).toBe(3_000)
  })
})
