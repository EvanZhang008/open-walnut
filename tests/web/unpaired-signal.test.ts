/**
 * The web client's "not paired" signal: only the primary auth middleware's two
 * refusal codes count, so a plugin's own 401 (or a cloud replica's) never tells
 * the user their device is unpaired.
 */
import { describe, it, expect, vi } from 'vitest'

async function fresh() {
  vi.resetModules()
  return import('../../web/src/api/unpaired')
}

describe('noteAuthRefusal', () => {
  it('not_paired means unpaired; token_refused means revoked', async () => {
    const m = await fresh()
    const seen: string[] = []
    m.subscribeUnpaired(() => seen.push(m.getUnpairedState()))
    m.noteAuthRefusal({ error: 'Authentication required. Pair this device ...', code: 'not_paired' })
    expect(m.getUnpairedState()).toBe('unpaired')
    m.noteAuthRefusal({ code: 'not_paired' }) // same state: no second notification
    m.noteAuthRefusal({ error: 'Invalid or revoked token', code: 'token_refused' })
    expect(seen).toEqual(['unpaired', 'revoked'])
  })

  it('other 401 bodies leave the state alone, including the cloud replica\'s own refusal', async () => {
    const m = await fresh()
    const listener = vi.fn()
    m.subscribeUnpaired(listener)
    const others = [
      { error: 'Authentication required. Use Authorization: Bearer <device_token>' },
      { error: { code: 'unauthorized', message: 'Apple Health needs this device\'s token' } },
      'Unauthorized', null, undefined, { code: 42 },
    ]
    for (const body of others) m.noteAuthRefusal(body)
    expect(m.getUnpairedState()).toBe('ok')
    expect(listener).not.toHaveBeenCalled()
  })
})
