/**
 * Passwords client (server: src/web/routes/vault-v1.ts). Every item call carries this
 * window's vault session (x-walnut-vault-session), which only the master password buys;
 * the token is kept for this tab only (sessionStorage) and dropped on Lock or a 401.
 *
 * The master password never leaves the page when WebCrypto is here: the page derives the
 * password key (PBKDF2, the vault's own parameters) and sends that. A page on plain http
 * from another device has no WebCrypto, so it sends the password and the server derives it.
 * Responses are never cached (no-store) and nothing here logs a value.
 */
import { getDeviceToken } from './device-token'
import { derivePasswordKey, randomBytes, toB64, PBKDF2_ITERATIONS, type KdfParams } from '../../../src/core/vault/crypto'
import type { VaultItem, VaultItemInput, VaultItemSummary } from '../../../src/core/vault/types'

export type { VaultItem, VaultItemInput, VaultItemSummary }

export interface VaultStatus {
  setUp: boolean
  open: boolean
  unlocked: boolean
  agentsWhileAway: boolean
  hasSecretKey: boolean
  kdf?: KdfParams
  itemCount?: number
  autoLockMinutes: number
  waitMs: number
}

export interface SecurityReport { weak: string[]; reused: string[][]; old: string[]; insecureUrl: string[] }

export interface ImportReport {
  format: string
  found: number
  duplicates: number
  toAdd: number
  skipped: Array<{ row: number; title?: string; reason: string }>
  passkeys: number
  byType: Record<string, number>
}

export class VaultApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public waitMs?: number) {
    super(message)
    this.name = 'VaultApiError'
  }
}

const TOKEN_KEY = 'walnut.vault.session'
const listeners = new Set<() => void>()

export function vaultSession(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}

function setSession(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* storage off: the session lives as long as the page */ }
  for (const l of listeners) l()
}

/** Called when this window's unlock ends (Lock, auto-lock, a 401). */
export function onVaultSessionChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const device = getDeviceToken()
  if (device) headers.Authorization = `Bearer ${device}`
  const s = vaultSession()
  if (s) headers['x-walnut-vault-session'] = s
  const res = await fetch(`/api/v1${path}`, {
    method, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    if (res.status === 401 && data.code === 'vault_session_needed' && s) setSession(null)
    throw new VaultApiError(res.status, String(data.error ?? `HTTP ${res.status}`), typeof data.code === 'string' ? data.code : undefined, typeof data.waitMs === 'number' ? data.waitMs : undefined)
  }
  return data as T
}

const canDerive = () => typeof globalThis.crypto?.subtle?.deriveBits === 'function'

/** The body that proves the master password: its key when WebCrypto is here, else the password. */
async function proof(password: string, kdf: KdfParams | undefined, field: 'password' | 'oldPassword' | 'newPassword' = 'password'): Promise<Record<string, string>> {
  const keyField = field === 'password' ? 'passwordKey' : field === 'oldPassword' ? 'oldPasswordKey' : 'newPasswordKey'
  if (kdf && canDerive()) return { [keyField]: toB64(await derivePasswordKey(password, kdf)) }
  return { [field]: password }
}

function newKdf(): KdfParams | undefined {
  if (!canDerive()) return undefined // the server picks the salt and derives
  return { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(randomBytes(16)) }
}

const CLIENT = 'Walnut web'

export const vaultApi = {
  status: () => call<VaultStatus>('GET', '/vault/status'),

  async setup(password: string, agentsWhileAway: boolean): Promise<{ secretKey: string }> {
    const kdf = newKdf()
    const r = await call<{ secretKey: string; session: { token: string } }>('POST', '/vault/setup', {
      ...(await proof(password, kdf)), ...(kdf ? { kdf } : {}), agentsWhileAway, client: CLIENT,
    }, 60_000)
    setSession(r.session.token)
    return { secretKey: r.secretKey }
  },

  /**
   * Unlock with the master password. The KDF is read fresh first (another window may have
   * changed the master password since this page loaded), and its salt rides along so the
   * server can say "changed" instead of counting a wrong password; then it tries once more.
   */
  async unlock(password: string, _kdf: KdfParams | undefined, secretKey?: string): Promise<void> {
    for (let tries = 0; ; tries++) {
      const kdf = (await call<VaultStatus>('GET', '/vault/status')).kdf
      try {
        const r = await call<{ session: { token: string } }>('POST', '/vault/unlock', {
          ...(await proof(password, kdf)), ...(kdf ? { kdfSalt: kdf.salt } : {}), ...(secretKey ? { secretKey } : {}), client: CLIENT,
        }, 60_000)
        setSession(r.session.token)
        return
      } catch (err) {
        if (tries === 0 && err instanceof VaultApiError && err.code === 'kdf_changed') continue
        throw err
      }
    }
  },

  async lock(all = false): Promise<void> {
    try { await call('POST', '/vault/lock', all ? { all: true } : {}) } finally { setSession(null) }
  },

  /** Forget this window's unlock without asking the server (it already ended it). */
  forget: () => setSession(null),

  list: () => call<{ items: VaultItemSummary[] }>('GET', '/vault/items').then((r) => r.items),
  get: (id: string) => call<{ item: VaultItem }>('GET', `/vault/items/${encodeURIComponent(id)}`).then((r) => r.item),
  create: (item: VaultItemInput) => call<{ item: VaultItem }>('POST', '/vault/items', { item }).then((r) => r.item),
  update: (id: string, item: VaultItemInput, expectedUpdatedAt?: string) =>
    call<{ item: VaultItem }>('PUT', `/vault/items/${encodeURIComponent(id)}`, { item, expectedUpdatedAt }).then((r) => r.item),
  trash: (id: string) => call<{ item: VaultItem }>('POST', `/vault/items/${encodeURIComponent(id)}/trash`).then((r) => r.item),
  restore: (id: string) => call<{ item: VaultItem }>('POST', `/vault/items/${encodeURIComponent(id)}/restore`).then((r) => r.item),
  remove: (id: string) => call('DELETE', `/vault/items/${encodeURIComponent(id)}`),
  favorite: (id: string, favorite: boolean) => call<{ item: VaultItem }>('POST', `/vault/items/${encodeURIComponent(id)}/favorite`, { favorite }).then((r) => r.item),
  used: (id: string) => call('POST', `/vault/items/${encodeURIComponent(id)}/used`),
  totp: (id: string) => call<{ code: string; period: number; remaining: number }>('GET', `/vault/items/${encodeURIComponent(id)}/totp`),
  report: () => call<SecurityReport>('GET', '/vault/report'),
  importFile: (text: string, fileName: string, dryRun: boolean, format?: string) =>
    call<{ dryRun: boolean; report: ImportReport; added?: number }>('POST', '/vault/import', { text, fileName, dryRun, ...(format ? { format } : {}) }, 120_000),
  /** Turning agents-while-away on or off asks for the master password again. */
  async setAgentsWhileAway(on: boolean, password: string, kdf: KdfParams | undefined): Promise<VaultStatus> {
    return call<VaultStatus>('POST', '/vault/settings', { agentsWhileAway: on, ...(await proof(password, kdf)) }, 60_000)
  },

  /** The Secret Key again, for a new recovery kit. Needs the master password. */
  async secretKey(password: string, kdf: KdfParams | undefined): Promise<string> {
    return (await call<{ secretKey: string }>('POST', '/vault/secret-key', { ...(await proof(password, kdf)) }, 60_000)).secretKey
  },

  async changePassword(oldPassword: string, newPassword: string, kdf: KdfParams | undefined): Promise<void> {
    const next = newKdf()
    await call('POST', '/vault/password', {
      ...(await proof(oldPassword, kdf, 'oldPassword')), ...(await proof(newPassword, next, 'newPassword')), ...(next ? { kdf: next } : {}),
    }, 60_000)
  },

  async exportAll(password: string, kdf: KdfParams | undefined, format: 'csv' | 'json'): Promise<{ fileName: string; text: string }> {
    return call('POST', '/vault/export', { ...(await proof(password, kdf)), format }, 60_000)
  },
}

/**
 * Copy, then after `clearMs` empty the clipboard if it still holds this value. When the
 * page may not read the clipboard it leaves it alone rather than wipe something the
 * person copied since.
 */
export async function copySecret(text: string, clearMs = 30_000): Promise<void> {
  await navigator.clipboard.writeText(text)
  window.setTimeout(() => {
    void navigator.clipboard.readText()
      .then((now) => (now === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => {})
  }, clearMs)
}
