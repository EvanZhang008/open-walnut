/**
 * The web app's unlock (web/src/api/vault.ts vaultApi.unlock), used by the Passwords lock screen
 * and an approval card's "Unlock to approve": sent again while the server checks another unlock
 * (`429 unlock_busy`), never again for a wrong password. Node env with stubbed storage and fetch.
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
Object.defineProperty(globalThis, 'localStorage', { value: local, writable: true, configurable: true })
Object.defineProperty(globalThis, 'sessionStorage', { value: new FakeStorage(), writable: true, configurable: true })
Object.defineProperty(globalThis, 'window', { value: { addEventListener: () => {} }, writable: true, configurable: true })

vi.mock('../../web/src/api/client', () => ({ apiGet: async () => ({ prefs: {} }), apiPut: async () => ({}) }))
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }))

const BUSY = { status: 429, body: { error: 'Another unlock is being checked; try again in a moment.', code: 'unlock_busy', waitMs: 100 } }
const WRONG = { status: 401, body: { error: 'Wrong master password', code: 'wrong_password' } }
const OK = { status: 200, body: { session: { token: 'tok-new' } } }
let unlockAnswers: Array<{ status: number; body: unknown }> = []
let unlocks = 0
globalThis.fetch = (async (url: string, init: { method?: string }) => {
  // No KDF in the status: the password goes as is, over the private link the status says this is.
  const a = String(url).endsWith('/vault/unlock') && init.method === 'POST'
    ? unlockAnswers[Math.min(unlocks++, unlockAnswers.length - 1)]
    : { status: 200, body: { setUp: true, unlocked: false, privateLink: true } }
  return { ok: a.status < 400, status: a.status, json: async () => a.body } as Response
}) as typeof fetch

const { vaultApi, vaultSession, VaultApiError } = await import('../../web/src/api/vault')
const noSleep = { sleep: async () => {} }

beforeEach(() => { local.clear(); unlocks = 0 })

describe('the web app\'s unlock while another is being checked', () => {
  it('busy, then unlocked: sent again, Checking shown while it waits, and the session kept', async () => {
    unlockAnswers = [BUSY, OK]
    const waits: number[] = []
    await vaultApi.unlock('pw', undefined, undefined, { ...noSleep, onWait: (ms) => waits.push(ms) })
    expect(unlocks).toBe(2)
    expect(waits).toEqual([100])
    expect(vaultSession()).toBe('tok-new')
  })

  it('busy every time: a bounded number of sends, then the busy refusal', async () => {
    unlockAnswers = [BUSY]
    const err = await vaultApi.unlock('pw', undefined, undefined, noSleep).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultApiError)
    expect((err as InstanceType<typeof VaultApiError>).code).toBe('unlock_busy')
    expect(unlocks).toBe(4)
    expect(vaultSession()).toBeNull()
  })

  it('a wrong password is sent once', async () => {
    unlockAnswers = [WRONG, OK]
    const err = await vaultApi.unlock('nope', undefined, undefined, noSleep).catch((e: unknown) => e)
    expect((err as InstanceType<typeof VaultApiError>).code).toBe('wrong_password')
    expect(unlocks).toBe(1)
  })
})
