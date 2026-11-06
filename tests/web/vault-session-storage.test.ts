/**
 * Where the web app keeps its Passwords unlock (web/src/api/vault.ts): localStorage, shared by every
 * tab, never mirrored to the server by ui-prefs; a token an older page left in sessionStorage is
 * carried over; a 401 drops only the token that got it, never a newer one another tab stored; a
 * storage event from another tab tells the listeners; Lock asks for every window, an auto-lock
 * only for this browser. Node env with stubbed storage and fetch. Fake tokens only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

class FakeStorage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  key(i: number) { return [...this.store.keys()][i] ?? null }
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, v) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}

const local = new FakeStorage()
const session = new FakeStorage()
const windowListeners = new Map<string, Array<(e: unknown) => void>>()
Object.defineProperty(globalThis, 'localStorage', { value: local, writable: true, configurable: true })
Object.defineProperty(globalThis, 'sessionStorage', { value: session, writable: true, configurable: true })
Object.defineProperty(globalThis, 'window', {
  value: { addEventListener: (t: string, f: (e: unknown) => void) => { windowListeners.set(t, [...(windowListeners.get(t) ?? []), f]) } },
  writable: true, configurable: true,
})

vi.mock('../../web/src/api/client', () => ({ apiGet: async () => ({ prefs: {} }), apiPut: async () => ({}) }))
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }))

const sent: Array<{ path: string; body?: unknown; session?: string; quiet?: string }> = []
let answer: { status: number; body: unknown } = { status: 200, body: {} }
globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
  sent.push({ path: String(url), body: init.body ? JSON.parse(init.body) : undefined, session: init.headers['x-walnut-vault-session'], quiet: init.headers['x-walnut-vault-quiet'] })
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response
}) as typeof fetch

const { vaultApi, vaultSession, onVaultSessionChange } = await import('../../web/src/api/vault')
const { syncable } = await import('../../web/src/utils/ui-prefs-sync')
const KEY = 'walnut.vault.session'

beforeEach(() => {
  local.clear(); session.clear(); sent.length = 0
  answer = { status: 200, body: {} }
})

describe('the web app\'s Passwords unlock', () => {
  it('lives in localStorage, under a key ui-prefs never sends to the server', () => {
    expect(syncable(KEY)).toBe(false)
    expect(syncable('walnut.vault.active')).toBe(false)
    local.setItem(KEY, 'tok-a')
    expect(vaultSession()).toBe('tok-a')
  })

  it('carries over a token an older page kept in sessionStorage', () => {
    session.setItem(KEY, 'tok-old')
    expect(vaultSession()).toBe('tok-old')
    expect(local.getItem(KEY)).toBe('tok-old')
    expect(session.getItem(KEY)).toBeNull()
  })

  it('a 401 drops the token that got it, but not a newer one another tab stored meanwhile', async () => {
    local.setItem(KEY, 'tok-a')
    answer = { status: 401, body: { code: 'vault_session_needed', error: 'locked' } }
    await expect(vaultApi.list()).rejects.toThrow()
    expect(local.getItem(KEY)).toBeNull()

    local.setItem(KEY, 'tok-b')
    const slow = vaultApi.list() // sent with tok-b
    local.setItem(KEY, 'tok-c') // another tab unlocked again before the answer
    await expect(slow).rejects.toThrow()
    expect(local.getItem(KEY)).toBe('tok-c')
  })

  it('another tab\'s unlock or lock reaches this one\'s listeners', () => {
    let calls = 0
    const off = onVaultSessionChange(() => { calls++ })
    for (const f of windowListeners.get('storage') ?? []) f({ key: KEY, newValue: null })
    for (const f of windowListeners.get('storage') ?? []) f({ key: 'something-else', newValue: '1' })
    off()
    expect(calls).toBe(1)
  })

  it('Lock asks for every window; an auto-lock only for this browser', async () => {
    local.setItem(KEY, 'tok-a')
    await vaultApi.lock()
    expect(sent.at(-1)).toMatchObject({ body: { everywhere: true }, session: 'tok-a' })
    expect(local.getItem(KEY)).toBeNull()
    await vaultApi.lock(true)
    expect(sent.at(-1)?.body).toEqual({ all: true })
    local.setItem(KEY, 'tok-b')
    await vaultApi.lockThisBrowser()
    expect(sent.at(-1)).toMatchObject({ body: {}, session: 'tok-b' })
    expect(local.getItem(KEY)).toBeNull()
  })

  it('a status that says locked drops the token it went with, and forget() only the one it names', async () => {
    local.setItem(KEY, 'tok-a')
    answer = { status: 200, body: { unlocked: false } }
    await vaultApi.status({ quiet: true })
    expect(local.getItem(KEY)).toBeNull()
    local.setItem(KEY, 'tok-b')
    const slow = vaultApi.status({ quiet: true }) // sent with tok-b
    local.setItem(KEY, 'tok-c') // another tab unlocked again before the answer
    await slow
    expect(local.getItem(KEY)).toBe('tok-c')
    vaultApi.forget('tok-b')
    expect(local.getItem(KEY)).toBe('tok-c')
    vaultApi.forget(null)
    expect(local.getItem(KEY)).toBe('tok-c')
    vaultApi.forget('tok-c')
    expect(local.getItem(KEY)).toBeNull()
  })

  it('a quiet status read says so', async () => {
    await vaultApi.status({ quiet: true })
    expect(sent.at(-1)).toMatchObject({ quiet: '1' })
    expect(sent.at(-1)?.path).toContain('/vault/status')
    await vaultApi.status()
    expect(sent.at(-1)?.quiet).toBeUndefined()
  })
})

describe('one unlock on this computer, in a Walnut window', () => {
  const BKEY = 'walnut.vault.browser'
  const fakeKey = 'k'.repeat(43)

  /** Answers by path, recording the browser key each request carried. */
  function serve(routes: Record<string, { status: number; body: unknown }>): Array<{ path: string; key?: string }> {
    const seen: Array<{ path: string; key?: string }> = []
    globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
      const p = String(url).replace('/api/v1', '')
      seen.push({ path: `${init.method} ${p}`, key: init.headers['x-walnut-vault-browser'] })
      const a = routes[`${init.method} ${p}`] ?? { status: 404, body: {} }
      return { ok: a.status < 400, status: a.status, json: async () => a.body } as Response
    }) as typeof fetch
    return seen
  }

  it('keeps the browser key an unlock typed here gets, under a key ui-prefs never sends', async () => {
    expect(syncable(BKEY)).toBe(false)
    serve({
      'GET /vault/status': { status: 200, body: { unlocked: false, privateLink: true } },
      'POST /vault/unlock': { status: 200, body: { session: { token: 'tok-typed' }, browserKey: fakeKey } },
    })
    await vaultApi.unlock('a fake master', undefined)
    expect(local.getItem(BKEY)).toBe(fakeKey)
    expect(local.getItem(KEY)).toBe('tok-typed')
  })

  it('a locked window that may share (canJoin) takes the unlock with no password, sending its key', async () => {
    local.setItem(BKEY, fakeKey)
    let joined = false
    const seen = serve({ 'POST /vault/join': { status: 200, body: { session: { token: 'tok-shared' } } } })
    // The status says canJoin until the join, then unlocked.
    const base = globalThis.fetch
    globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
      if (String(url).endsWith('/vault/status')) {
        seen.push({ path: 'GET /vault/status', key: init.headers['x-walnut-vault-browser'] })
        return { ok: true, status: 200, json: async () => (joined ? { unlocked: true } : { unlocked: false, canJoin: true }) } as Response
      }
      joined = true
      return base(url, init as RequestInit)
    }) as typeof fetch
    let calls = 0
    const off = onVaultSessionChange(() => { calls++ })
    const st = await vaultApi.status({ quiet: true })
    off()
    expect(st.unlocked).toBe(true)
    expect(local.getItem(KEY)).toBe('tok-shared')
    expect(calls).toBeGreaterThan(0)
    expect(seen.map((s) => s.path)).toEqual(['GET /vault/status', 'POST /vault/join', 'GET /vault/status'])
    expect(seen.every((s) => s.key === fakeKey)).toBe(true)
  })

  it('a share refused (the unlock ended meanwhile) leaves the lock screen, with no unlock kept', async () => {
    local.setItem(BKEY, fakeKey)
    serve({
      'GET /vault/status': { status: 200, body: { unlocked: false, canJoin: true } },
      'POST /vault/join': { status: 409, body: { code: 'nothing_to_join', error: 'locked' } },
    })
    const st = await vaultApi.status()
    expect(st).toMatchObject({ unlocked: false, canJoin: false })
    expect(local.getItem(KEY)).toBeNull()
  })

  it('never shares while this browser already holds an unlock, nor when the server says nothing to share', async () => {
    const seen = serve({ 'GET /vault/status': { status: 200, body: { unlocked: false } } })
    await vaultApi.status()
    expect(seen.map((s) => s.path)).toEqual(['GET /vault/status'])
  })
})
