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
      // A browser's access token that ran out: the page renews it (device-token.ts), never a sign-out.
      { error: 'This sign-in needs renewing.', code: 'token_expired' },
    ]
    for (const body of others) m.noteAuthRefusal(body)
    expect(m.getUnpairedState()).toBe('ok')
    expect(listener).not.toHaveBeenCalled()
  })

  it('a renewal\'s refusal signs out and keeps why (cookie gone, used elsewhere, a year unused); a plain refusal after it keeps the reason; a sign-in clears it', async () => {
    const m = await fresh()
    const seen: Array<string | null> = []
    m.subscribeUnpaired(() => seen.push(m.getSignedOutReason()))
    m.noteAuthRefusal({ code: 'refresh_missing' })
    expect(m.getUnpairedState()).toBe('revoked')
    expect(m.getSignedOutReason()).toBe('cookie_gone')
    m.noteAuthRefusal({ code: 'token_refused' })
    expect(m.getSignedOutReason()).toBe('cookie_gone')
    m.noteSignedIn()
    expect(m.getSignedOutReason()).toBeNull()
    // Signed out by a plain refusal first, the renewal's reason heard after: the page learns why.
    m.noteAuthRefusal({ code: 'token_refused' })
    expect(m.getSignedOutReason()).toBeNull()
    m.noteAuthRefusal({ code: 'refresh_reused' })
    expect(m.getSignedOutReason()).toBe('used_elsewhere')
    expect(seen).toEqual(['cookie_gone', null, null, 'used_elsewhere'])
    m.noteSignedIn()
    m.noteAuthRefusal({ code: 'refresh_expired' })
    expect(m.getSignedOutReason()).toBe('year_unused')
    m.noteSignedIn()
    m.noteAuthRefusal({ code: 'refresh_refused' })
    expect(m.getUnpairedState()).toBe('revoked')
    expect(m.getSignedOutReason()).toBeNull()
  })

  it('a socket closed because the device went says removed on the computer, unless a renewal said more', async () => {
    const m = await fresh()
    m.noteAuthRefusal({ code: 'device_removed' })
    expect(m.getUnpairedState()).toBe('revoked')
    expect(m.getSignedOutReason()).toBe('removed')
    m.noteAuthRefusal({ code: 'refresh_missing' })
    expect(m.getSignedOutReason()).toBe('cookie_gone')
    m.noteAuthRefusal({ code: 'device_removed' })
    expect(m.getSignedOutReason()).toBe('cookie_gone')
  })

  it('why is kept across a reload, and a sign-in forgets it', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    try {
      let m = await fresh()
      m.noteAuthRefusal({ code: 'refresh_missing' })
      // The page loads again: it hears only the plain refusal of its token.
      m = await fresh()
      expect(m.getSignedOutReason()).toBeNull()
      m.noteAuthRefusal({ code: 'token_refused' })
      expect(m.getSignedOutReason()).toBe('cookie_gone')
      m.noteSignedIn()
      m = await fresh()
      m.noteAuthRefusal({ code: 'token_refused' })
      expect(m.getSignedOutReason()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
