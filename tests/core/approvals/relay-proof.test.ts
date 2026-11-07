import { afterEach, describe, expect, it } from 'vitest'
import { _clearRelayProofsForTesting, holdRelayProof, relayProofOf } from '../../../src/core/approvals/relay-proof.js'

describe("a host daemon's word on the asking process, held for the approvals route", () => {
  afterEach(() => _clearRelayProofsForTesting())

  it('is read back only by its token, only for a minute, and keeps only known fields', () => {
    const t = holdRelayProof({ v: 1, verified: true, pid: 7, process: 'python3', extra: 'x' }, 'sid-1', 'devbox', 1_000)!
    expect(relayProofOf(t, 2_000)).toMatchObject({ sid: 'sid-1', host: 'devbox', proof: { v: 1, verified: true, pid: 7, process: 'python3' } })
    expect((relayProofOf(t, 2_000)!.proof as Record<string, unknown>).extra).toBeUndefined()
    expect(relayProofOf(t, 61_001)).toBeUndefined()
    expect(relayProofOf('f'.repeat(48), 2_000)).toBeUndefined()
    expect(relayProofOf(undefined)).toBeUndefined()
  })

  it('holds none for a malformed proof or a caller outside every session', () => {
    expect(holdRelayProof({ verified: true }, 'sid-1', 'devbox')).toBeUndefined()
    expect(holdRelayProof('yes', 'sid-1', 'devbox')).toBeUndefined()
    expect(holdRelayProof({ v: 1, verified: true }, 'external', 'devbox')).toBeUndefined()
    expect(holdRelayProof({ v: 1, verified: true }, '', 'devbox')).toBeUndefined()
  })

  it('a flood never drops a live token: once full it holds no new one', () => {
    const first = holdRelayProof({ v: 1, verified: true }, 's', 'h', 1_000)!
    for (let i = 0; i < 600; i++) holdRelayProof({ v: 1, verified: true }, 's', 'h', 1_000)
    expect(relayProofOf(first, 1_500)).toBeDefined()
    expect(holdRelayProof({ v: 1, verified: true }, 's', 'h', 1_500)).toBeUndefined()
    // Expired ones make room again.
    expect(holdRelayProof({ v: 1, verified: true }, 's', 'h', 70_000)).toBeDefined()
  })
})
