/**
 * The extension hands a browser key only to the paired Walnut's own page (packages/browser-extension/
 * src/hand-browser-key.ts): the top frame of a tab at exactly the address it is paired with, never a
 * frame, another site, or another loopback name or port of it; only while it holds an unlock; and a
 * key Walnut already confirmed under this unlock costs no second request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  conn: { serverUrl: 'http://localhost:3456', token: 't', device: 'd' } as { serverUrl: string } | null,
  session: 'vault-token' as string | null,
  calls: [] as Array<{ path: string; body: unknown; opts: unknown }>,
  answer: { browserKey: 'K'.repeat(43), known: false } as Record<string, unknown>,
}))

vi.mock('../../../packages/browser-extension/src/ext', () => ({ ext: { storage: { onChanged: { addListener() {} } }, tabs: { query: async () => [], sendMessage: async () => undefined } } }))
vi.mock('../../../packages/browser-extension/src/walnut-api', () => ({
  connection: async () => state.conn,
  vaultSession: async () => state.session,
  call: async (_m: string, path: string, body: unknown, opts: unknown) => { state.calls.push({ path, body, opts }); return state.answer },
}))
vi.mock('../../../packages/browser-extension/src/bg-vault', () => ({
  originOf: (url: string) => { try { return new URL(url).origin } catch { return '' } },
}))
const { handBrowserKey, pairedTopOrigin } = await import('../../../packages/browser-extension/src/hand-browser-key')

const PAIRED = 'http://localhost:3456'
const top = (url: string, extra: Record<string, unknown> = {}) => ({ tab: { id: 7 }, frameId: 0, url, ...extra })
const KEY_A = 'a'.repeat(43)

beforeEach(() => {
  state.conn = { serverUrl: PAIRED }
  state.session = 'vault-token'
  state.calls = []
  state.answer = { browserKey: 'K'.repeat(43), known: false }
})

describe('pairedTopOrigin', () => {
  it('the top frame of a tab at exactly the paired address', () => {
    expect(pairedTopOrigin(PAIRED, top(`${PAIRED}/passwords`))).toBe(PAIRED)
    expect(pairedTopOrigin(PAIRED, top('http://other.example/', { origin: PAIRED }))).toBe(PAIRED) // the browser's own origin wins
  })

  it('never a frame, another site, another loopback name or port, or no pairing', () => {
    expect(pairedTopOrigin(PAIRED, { ...top(`${PAIRED}/`), frameId: 2 })).toBeNull()
    expect(pairedTopOrigin(PAIRED, { frameId: 0, url: `${PAIRED}/` })).toBeNull() // no tab: an extension page
    expect(pairedTopOrigin(PAIRED, top('http://127.0.0.1:3456/'))).toBeNull()
    expect(pairedTopOrigin(PAIRED, top('http://localhost:3457/'))).toBeNull()
    expect(pairedTopOrigin(PAIRED, top('https://localhost:3456/'))).toBeNull()
    expect(pairedTopOrigin(PAIRED, top('http://localhost.evil.example:3456/'))).toBeNull()
    expect(pairedTopOrigin(PAIRED, top(`${PAIRED}/`, { origin: 'http://evil.example' }))).toBeNull()
    expect(pairedTopOrigin(undefined, top(`${PAIRED}/`))).toBeNull()
  })
})

describe('handBrowserKey', () => {
  it('a page with no key gets the one Walnut issues, with the origin to check before writing it', async () => {
    const r = await handBrowserKey({}, top(`${PAIRED}/passwords`))
    expect(r).toEqual({ ok: true, key: 'K'.repeat(43), origin: PAIRED })
    expect(state.calls).toEqual([{ path: '/vault/browser-key', body: {}, opts: expect.objectContaining({ quiet: true }) }])
  })

  it('a key Walnut knows writes nothing, and asking again under the same unlock costs no request', async () => {
    state.answer = { browserKey: KEY_A, known: true }
    expect(await handBrowserKey({ key: KEY_A }, top(`${PAIRED}/`))).toEqual({ ok: true, known: true })
    expect(state.calls[0].body).toEqual({ browserKey: KEY_A })
    expect(await handBrowserKey({ key: KEY_A }, top(`${PAIRED}/`))).toEqual({ ok: true, known: true })
    expect(state.calls).toHaveLength(1)
    // A new unlock asks again.
    state.session = 'another-token'
    await handBrowserKey({ key: KEY_A }, top(`${PAIRED}/`))
    expect(state.calls).toHaveLength(2)
  })

  it('a malformed key the page holds is not sent: Walnut issues a new one', async () => {
    await handBrowserKey({ key: 'not a key' }, top(`${PAIRED}/`))
    expect(state.calls[0].body).toEqual({})
  })

  it('locked, not paired, or not the paired page: no request, no key', async () => {
    state.session = null
    expect((await handBrowserKey({}, top(`${PAIRED}/`))).ok).toBe(false)
    state.session = 'vault-token'
    expect((await handBrowserKey({}, top('http://127.0.0.1:3456/'))).ok).toBe(false)
    expect((await handBrowserKey({}, { ...top(`${PAIRED}/`), frameId: 1 })).ok).toBe(false)
    state.conn = null
    expect((await handBrowserKey({}, top(`${PAIRED}/`))).ok).toBe(false)
    expect(state.calls).toEqual([])
  })

  it('an answer that is not a key hands nothing', async () => {
    state.answer = { browserKey: 'short' }
    expect((await handBrowserKey({}, top(`${PAIRED}/`))).ok).toBe(false)
  })
})
