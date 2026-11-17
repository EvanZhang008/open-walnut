/**
 * A host problem reaches the person only when only they can clear it (audience.ts
 * HOST_SIGN_IN_KINDS); Walnut Health holds the ones Walnut heals by reconnecting. A kind no
 * retry heals (host-connect-hint.ts RETRYABLE false) is the person's by definition: in Health
 * it would sit unseen forever. 2026-11-17: hosting turned off on the cloud companion and a
 * companion owned by another Mac went to Health, and the Mac showed nothing (Nightly extra
 * tests run 44126359245, cloud-host.spec.ts and cloud-host-other-mac.spec.ts). This fails
 * when a new kind that no retry heals is left out of the person's list.
 */
import { describe, expect, it } from 'vitest'
import { HOST_SIGN_IN_KINDS, hostProblemNeedsYou } from '../../../src/core/notifications/audience.js'
import { RETRYABLE } from '../../../src/core/sessions/host-connect-hint.js'

/** Not a failure of the host: remote hosts are off on a test server, which only explains. */
const NOT_A_PROBLEM = new Set(['ephemeral'])

const unhealable = Object.entries(RETRYABLE).filter(([kind, retry]) => !retry && !NOT_A_PROBLEM.has(kind)).map(([kind]) => kind)

describe('a host problem no retry heals reaches the person', () => {
  it('finds the kinds no retry heals', () => {
    expect(unhealable).toEqual(expect.arrayContaining(['auth', 'cloud_exec_off', 'cloud_other_mac']))
  })

  it.each(unhealable)('%s is the person\'s', (kind) => {
    expect(HOST_SIGN_IN_KINDS).toContain(kind)
    expect(hostProblemNeedsYou({ kind, hosts: ['__cloudbox__'] }, new Set())).toBe('sign-in')
  })

  it('a kind a reconnect heals stays Walnut Health\'s until the person acts', () => {
    for (const kind of Object.keys(RETRYABLE).filter((k) => RETRYABLE[k as keyof typeof RETRYABLE])) {
      expect(hostProblemNeedsYou({ kind, hosts: ['box'] }, new Set()), kind).toBeUndefined()
      expect(hostProblemNeedsYou({ kind, hosts: ['box'] }, new Set(['box'])), kind).toBe('own-action')
    }
  })
})
