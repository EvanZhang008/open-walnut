/**
 * The extension's way to the Walnut server: its address and the device token a pairing code
 * bought (the extension's IndexedDB, which content scripts cannot open), and the vault session the master password bought (storage.session,
 * gone when the browser quits). Runs in the background only: a content script never holds
 * either.
 *
 * Every call carries `Authorization: Bearer <device token>`: an extension's requests come
 * from its own origin, which Walnut never takes for this machine, so the token is what lets
 * them in. The master password never leaves the extension: it derives the password key with
 * WebCrypto and sends that (the server refuses a plain password over such a link).
 */
import { ext } from './ext'
import { secrets } from './secret-store'
import { clearPanelData } from './panel-data'
import { derivePasswordKey, fromB64, toB64, type KdfParams } from '../../../src/core/vault/crypto'
import type { VaultItem, VaultItemInput, VaultItemSummary } from '../../../src/core/vault/types'

export const DEFAULT_SERVER = 'http://localhost:3456'
const CLIENT = 'Walnut extension'

/** `device` is what Settings shows ("Walnut extension (Chrome on Mac)"), `deviceId` its record. */
export interface Connection { serverUrl: string; token: string; device: string; deviceId?: string }

export interface VaultStatus {
  setUp: boolean
  unlocked: boolean
  hasSecretKey: boolean
  kdf?: KdfParams
  itemCount?: number
  autoLockMinutes: number
  waitMs: number
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly waitMs?: number) { super(message) }
}

/** This machine, or a Tailscale address (WireGuard carries it encrypted). */
export function privateHttpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h)
  if (m && Number(m[1]) === 127) return true
  if (m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) return true
  return /^fd7a:115c:a1e0:/.test(h)
}

/**
 * The Walnut address as an origin. Plain http only to this machine or over Tailscale: on any
 * other network it would carry the device token, the unlock and every password readable.
 */
export function cleanServerUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, '')
  const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `http://${t}`)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The Walnut address starts with http:// or https://')
  if (u.protocol === 'http:' && !privateHttpHost(u.hostname)) {
    throw new Error('Use https or a Tailscale address for a Walnut on another computer: plain http would send your passwords readable on the network.')
  }
  return u.origin
}

/** The key derivation the server asks for, held to the same floor the server holds itself to. */
export function checkKdf(kdf: KdfParams): void {
  if (kdf.name !== 'PBKDF2-SHA256' || !Number.isInteger(kdf.iterations) || kdf.iterations < 600_000 || kdf.iterations > 10_000_000) {
    throw new ApiError('Walnut asked for a weak key derivation: refusing to send anything derived from your password.', 0, 'bad_kdf')
  }
  if (fromB64(kdf.salt).length < 16) throw new ApiError('Walnut asked for a short salt: refusing.', 0, 'bad_kdf')
}

export async function connection(): Promise<Connection | null> {
  const c = await secrets.get<Connection>('connection').catch(() => undefined)
  return c && typeof c.serverUrl === 'string' && typeof c.token === 'string' ? c : null
}

export async function vaultSession(): Promise<string | null> {
  const { vaultSession: s } = await ext.storage.session.get('vaultSession')
  return typeof s === 'string' ? s : null
}

async function setVaultSession(token: string | null): Promise<void> {
  if (token) await ext.storage.session.set({ vaultSession: token })
  else await ext.storage.session.remove('vaultSession')
}

/** `quiet`: a read the extension makes by itself, which never keeps the vault unlocked. */
export async function call<T>(method: string, path: string, body?: unknown, opts: { conn?: Connection; timeoutMs?: number; noAuth?: boolean; quiet?: boolean; noSession?: boolean } = {}): Promise<T> {
  const conn = opts.conn ?? await connection()
  if (!conn) throw new ApiError('The extension is not connected to Walnut yet.', 0, 'not_connected')
  const session = opts.noSession ? null : await vaultSession()
  let res: Response
  try {
    res = await fetch(`${conn.serverUrl}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.noAuth ? {} : { authorization: `Bearer ${conn.token}` }),
        ...(session ? { 'x-walnut-vault-session': session } : {}),
        ...(opts.quiet ? { 'x-walnut-vault-quiet': '1' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    })
  } catch (err) {
    throw new ApiError(`Walnut does not answer at ${conn.serverUrl}. Is it running?`, 0, 'unreachable')
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    const e = data.error
    const message = typeof e === 'string' ? e : (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') ? (e as { message: string }).message : `Walnut answered ${res.status}`
    const code = typeof data.code === 'string' ? data.code : (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') ? (e as { code: string }).code : undefined
    // The server ended this window's unlock (auto-lock, Lock all, a restart): forget it.
    if ((res.status === 401 && code === 'vault_session_needed') || (res.status === 423 && code === 'vault_locked')) await setVaultSession(null)
    // The token was removed in Settings: the extension is no longer connected.
    if (res.status === 401 && (code === 'not_paired' || code === 'token_refused')) await secrets.delete('connection').catch(() => undefined)
    throw new ApiError(message, res.status, code, typeof data.waitMs === 'number' ? data.waitMs : undefined)
  }
  return data as T
}

/** Trade a pairing code for a device token. A connection it replaces is removed from Walnut first. */
export async function pair(serverUrl: string, code: string): Promise<Connection> {
  const url = cleanServerUrl(serverUrl)
  const conn: Connection = { serverUrl: url, token: '', device: '' }
  const r = await call<{ token: string; name: string; deviceName?: string }>('POST', '/browser-pair', { code: code.trim().toUpperCase(), client: 'extension' }, { conn, noAuth: true })
  const done: Connection = { serverUrl: url, token: r.token, device: r.deviceName ?? r.name, deviceId: r.name }
  // Connecting again (the same Walnut or another): the old device and its token go, best effort.
  const old = await connection()
  if (old && old.deviceId !== done.deviceId) await removeDevice(old)
  // Another Walnut: the side panel keeps nothing of the one before (panel-data.ts).
  if (!old || old.serverUrl !== done.serverUrl) await clearPanelData().catch(() => undefined)
  await secrets.set('connection', done)
  await setVaultSession(null)
  return done
}

/** Forget the connection here only (Walnut already refused it). */
async function forgetConnection(): Promise<void> {
  await secrets.delete('connection').catch(() => undefined)
  await setVaultSession(null)
  // The side panel's copy of that Walnut's chat and tasks goes too, and an open panel closes its frames.
  await clearPanelData().catch(() => undefined)
}

/** Lock this browser's unlock and remove its device in Walnut (a device may remove itself, devices.ts). */
async function removeDevice(conn: Connection): Promise<void> {
  await call('POST', '/vault/lock', {}, { conn, timeoutMs: 5000 }).catch(() => undefined)
  if (conn.deviceId) {
    await fetch(`${conn.serverUrl}/api/devices/${encodeURIComponent(conn.deviceId)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${conn.token}` }, signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  }
}

/** The person disconnects: lock, remove its device in Walnut (offline, Settings still lists it), forget it. */
export async function disconnect(): Promise<void> {
  const conn = await connection()
  if (conn) await removeDevice(conn)
  await forgetConnection()
}

export const api = {
  status: () => call<VaultStatus>('GET', '/vault/status', undefined, { quiet: true }),

  async unlock(password: string, secretKey?: string): Promise<void> {
    for (let tries = 0; ; tries++) {
      const st = await api.status()
      if (!st.setUp) throw new ApiError('Passwords is not set up in Walnut yet: open Walnut, Passwords, to set it up.', 409, 'vault_not_set_up')
      if (!st.kdf) throw new ApiError('Walnut did not say how to derive the key.', 500)
      checkKdf(st.kdf)
      const passwordKey = toB64(await derivePasswordKey(password, st.kdf))
      try {
        const r = await call<{ session: { token: string } }>('POST', '/vault/unlock', {
          passwordKey, kdfSalt: st.kdf.salt, client: CLIENT, ...(secretKey ? { secretKey } : {}),
        }, { timeoutMs: 60_000 })
        await setVaultSession(r.session.token)
        return
      } catch (err) {
        if (tries === 0 && err instanceof ApiError && err.code === 'kdf_changed') continue
        throw err
      }
    }
  },

  async lock(): Promise<void> {
    try { await call('POST', '/vault/lock', {}) } catch { /* locked anyway */ }
    await setVaultSession(null)
  },

  /**
   * Is this extension still connected? A local GET with no Origin passes Walnut's own-machine
   * rule without its token, so only a write tells: the device report (POST /devices/self), which
   * a browser always sends with its Origin. A token removed in Settings is refused (401, call()
   * forgets it), and one Walnut no longer has a record for answers 404. Anything else (a 400
   * when Walnut could not read the token this time, a network error) keeps the connection.
   * The report carries the name Walnut gave at pairing: Walnut keeps a report whole, so one
   * without it would clear the name Settings shows.
   */
  async checkConnection(): Promise<void> {
    const conn = await connection()
    if (!conn) throw new ApiError('The extension is not connected to Walnut yet.', 0, 'not_connected')
    try {
      await call('POST', '/devices/self', { deviceName: conn.device, appVersion: ext.runtime.getManifest().version }, { conn, timeoutMs: 8000 })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await forgetConnection()
        throw new ApiError('Walnut no longer knows this browser: connect it again.', err.status, 'token_refused')
      }
      if (err instanceof ApiError && err.status === 401) throw err
      // Not a refusal: the popup goes on.
    }
  },

  // The summaries are read as the person browses: quiet, so browsing never keeps the vault open.
  items: () => call<{ items: VaultItemSummary[] }>('GET', '/vault/items', undefined, { quiet: true }).then((r) => r.items),
  item: (id: string) => call<{ item: VaultItem }>('GET', `/vault/items/${encodeURIComponent(id)}`).then((r) => r.item),
  totp: (id: string) => call<{ code: string; remaining: number }>('GET', `/vault/items/${encodeURIComponent(id)}/totp`),
  create: (item: VaultItemInput) => call<{ item: VaultItem }>('POST', '/vault/items', { item }).then((r) => r.item),
  update: (id: string, item: VaultItemInput, expectedUpdatedAt?: string) =>
    call<{ item: VaultItem }>('PUT', `/vault/items/${encodeURIComponent(id)}`, { item, expectedUpdatedAt }).then((r) => r.item),
  used: (id: string) => call('POST', `/vault/items/${encodeURIComponent(id)}/used`, {}).catch(() => undefined),
}
