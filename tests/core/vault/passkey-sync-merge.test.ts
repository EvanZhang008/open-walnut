/**
 * The passkeys a login keeps after a Bitwarden sync (sources/bitwarden/sync.ts mergedPasskeys),
 * judged against what Bitwarden had at the last sync (`known`, kept on the link): a passkey
 * Bitwarden added comes, one Bitwarden deleted goes, one the person deleted in Walnut stays deleted,
 * each keeps the higher counter, and one made in Walnut (or brought by another import) stays. A link
 * an older Walnut wrote has no `known`: then nothing is dropped. Fake data only.
 */
import { describe, it, expect } from 'vitest'
import { mergedPasskeys } from '../../../src/core/vault/sources/bitwarden/sync.js'

const pk = (id: string, extra: Record<string, unknown> = {}) => ({ credentialId: id, rpId: 'example.org', keyValue: `key-${id}`, counter: '0', ...extra })
const ids = (l: Array<Record<string, unknown>> | undefined) => (l ?? []).map((p) => p.credentialId)

describe('mergedPasskeys', () => {
  it('takes a passkey Bitwarden added to a login that already had one made in Walnut', () => {
    expect(ids(mergedPasskeys([pk('w1', { madeBy: 'walnut' })], [pk('b1')], []))).toEqual(['w1', 'b1'])
  })

  it('drops a passkey Bitwarden deleted, and keeps the Walnut one', () => {
    expect(ids(mergedPasskeys([pk('b1'), pk('w1', { madeBy: 'walnut' })], [], ['b1']))).toEqual(['w1'])
  })

  it('a Bitwarden passkey the person deleted in Walnut does not come back', () => {
    expect(mergedPasskeys([], [pk('b1')], ['b1'])).toBeUndefined()
    expect(ids(mergedPasskeys([pk('b2')], [pk('b1'), pk('b2')], ['b1', 'b2']))).toEqual(['b2'])
  })

  it('a passkey from another import (no madeBy, never in Bitwarden) stays', () => {
    expect(ids(mergedPasskeys([pk('x1'), pk('b1')], [pk('b1')], ['b1']))).toEqual(['x1', 'b1'])
  })

  it('keeps the higher counter of the two sides', () => {
    expect(mergedPasskeys([pk('b1', { counter: '9' })], [pk('b1', { counter: '7' })], ['b1'])?.[0].counter).toBe('9')
    expect(mergedPasskeys([pk('b1', { counter: '3' })], [pk('b1', { counter: '7' })], ['b1'])?.[0].counter).toBe('7')
  })

  it('a link with no record (an older Walnut): nothing dropped, Bitwarden\'s added', () => {
    expect(ids(mergedPasskeys([pk('x1')], [pk('b1')]))).toEqual(['x1', 'b1'])
    expect(ids(mergedPasskeys([pk('b1')], []))).toEqual(['b1'])
  })

  it('nothing on either side is nothing', () => {
    expect(mergedPasskeys(undefined, undefined)).toBeUndefined()
  })
})
