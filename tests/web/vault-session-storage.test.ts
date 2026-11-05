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
