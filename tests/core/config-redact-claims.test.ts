/**
 * A relayed push row's `claims` (core/push/claims.ts) never leave the box.
 *
 * Both masking helpers drop them: `maskPushTokens` (GET /api/config on the Mac
 * and its change broadcast) and `redactConfig` (GET /api/config on a replica,
 * and every bug report). The row's other fields stay as they were, a field
 * called `claims` outside `push_tokens` is not touched, and the input, which is
 * the registry's own copy, keeps its claims.
 */
import { describe, expect, it } from 'vitest'
import { maskPushTokens, redactConfig } from '../../src/core/config-redact.js'
import { pushClaimOf } from '../../src/core/push/claims.js'

const TOKEN = 'ab'.repeat(32)
const CLAIMS = [pushClaimOf('bearer-one'), pushClaimOf('bearer-two')]

function config() {
  return {
    push_tokens: [
      { token: TOKEN, platform: 'ios', key_name: 'acme-tablet', origin: 'relay', registered_at: '2026-10-09T10:00:00.000Z', claims: [...CLAIMS] },
      { token: 'cd'.repeat(32), platform: 'ios', key_name: 'acme-phone', origin: 'local' },
    ],
    plugins: { acme: { claims: ['kept'] } },
  }
}

describe('a relayed row\'s claims are dropped from every answer', () => {
  it('maskPushTokens drops them and masks the token; the other fields stay', () => {
    const input = config()
    const out = maskPushTokens(input)
    expect(out.push_tokens[0]).toEqual({
      token: '\u2022'.repeat(8) + TOKEN.slice(-4), platform: 'ios', key_name: 'acme-tablet', origin: 'relay', registered_at: '2026-10-09T10:00:00.000Z',
    })
    expect(out.push_tokens.filter((r) => 'claims' in r)).toEqual([])
    expect(JSON.stringify(out)).not.toContain(CLAIMS[0])
    // Only push rows: a plugin's own field of that name is its business.
    expect(out.plugins).toEqual({ acme: { claims: ['kept'] } })
    // The registry's copy is not changed.
    expect(input.push_tokens[0]?.claims).toEqual(CLAIMS)
    expect(input.push_tokens[0]?.token).toBe(TOKEN)
  })

  it('redactConfig drops them too, for a replica\'s answer and every bug report', () => {
    const input = config()
    const out = redactConfig(input) as ReturnType<typeof config>
    expect(out.push_tokens.map((r) => r.token)).toEqual(['\u2022'.repeat(8) + TOKEN.slice(-4), '\u2022'.repeat(8) + 'cdcd'])
    expect(out.push_tokens.filter((r) => 'claims' in r)).toEqual([])
    const text = JSON.stringify(out)
    for (const c of CLAIMS) expect(text).not.toContain(c)
    expect(out.plugins).toEqual({ acme: { claims: ['kept'] } })
    expect(input.push_tokens[0]?.claims).toEqual(CLAIMS)
  })
})
