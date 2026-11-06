/**
 * Passwords client (server: src/web/routes/vault-v1.ts). Every item call carries this
 * window's vault session (x-walnut-vault-session), which only the master password buys;
 * the token is kept in localStorage, so every tab and window of this Walnut (and a reload, the
 * Mac app's page recycle) shares one unlock, and dropped on Lock or a 401. Its key is not one
 * ui-prefs mirrors to the server (ui-prefs-sync.ts `syncable`).
 *
 * One unlock on this computer (docs/reference/passwords.md): when the person types the master
 * password here on the computer Walnut runs on, the server hands this browser a browser key
 * (src/core/vault/browser-keys.ts), kept in localStorage beside the session and never mirrored
 * either. A locked window sends it, and when the status says `canJoin` (Passwords was unlocked on
 * this computer since, in the extension or another window) it shares that unlock with no password.
 *
 * The master password never leaves the page when WebCrypto is here: the page derives the
 * password key (PBKDF2, the vault's own parameters) and sends that. A page on plain http
 * from another device has no WebCrypto, so it sends the password and the server derives it.
 * Responses are never cached (no-store) and nothing here logs a value.
 */
import { getDeviceToken } from './device-token'
import { derivePasswordKey, randomBytes, toB64, PBKDF2_ITERATIONS, type KdfParams } from '../../../src/core/vault/crypto'
import type { VaultItem, VaultItemInput, VaultItemSummary } from '../../../src/core/vault/types'
import { busyWaitOf, throwingWhileUnlockBusy, type RetryOptions } from '../../../src/core/vault/unlock-retry'

export type { VaultItem, VaultItemInput, VaultItemSummary }

export interface VaultStatus {
  setUp: boolean
  open: boolean
  unlocked: boolean
  agentsWhileAway: boolean
  hasSecretKey: boolean
  kdf?: KdfParams
  itemCount?: number
  /** For older clients: minutes; a new client reads unlockFor and lockAfterIdleMinutes. */
  autoLockMinutes: number
  /** "Keep Passwords unlocked" in effect (src/core/vault/unlock-length.ts); `always` = Forever (the machine key). */
  unlockFor?: UnlockFor
  /** Minutes unused before this window locks itself, or null when only the length ends it. */
  lockAfterIdleMinutes?: number | null
  waitMs: number
  /** Nobody else reads the link to the server (https, this machine, Tailscale). */
  privateLink?: boolean
  /** The vault has a recovery code (one set up before them has none until a new kit is made). */
  hasRecovery?: boolean
  /** The newest recovery kit was never confirmed saved. */
  recoveryUnsaved?: boolean
  /** The master password hint (shown on the unlock screen); absent when none, or from an older Walnut. */
  hint?: string
  /** This locked window may share an unlock made on this computer (POST /vault/join); absent otherwise. */
  canJoin?: boolean
}

/** What a recovery kit holds. */
export interface RecoveryKit { secretKey: string; recoveryCode: string }

export interface SecurityReport { weak: string[]; reused: string[][]; old: string[]; insecureUrl: string[] }

export type AgentsSwitch = 'off' | 'ask' | 'allow'
export type UnlockFor = 'idle' | '1h' | '12h' | '48h' | 'restart' | 'always'
/** An approved ask's grant length: 0 once, 1 h, 12 h, 48 h (default), -1 forever (until revoked). */
export const GRANT_LENGTHS = [0, 3_600_000, 43_200_000, 172_800_000, -1] as const
export interface AgentGrant {
  id: string; asker: string; itemId: string; itemTitle?: string
  /** null: until revoked. */
  until: string | null
  grantedAt?: string; fields?: string[]; host?: string; taskId?: string; taskTitle?: string; sessionId?: string; approvedBy?: string
  /** What the person approved: reveal covers env and fill; fill or env only itself. */
  use?: 'fill' | 'env' | 'reveal'
}
export interface AgentPolicy { agents: AgentsSwitch; grantMs: number; grants: AgentGrant[] }
export interface AgentLogEntry {
  at: string
  kind: 'released' | 'fill' | 'asked' | 'denied' | 'refused' | 'expired' | 'listed' | 'revoked' | 'synced'
  itemId?: string; itemTitle?: string; fields?: string[]; purpose?: string
  via?: 'allow' | 'grant' | 'approval'; reason?: string; approvalId?: string
  taskId?: string; taskTitle?: string; sessionId?: string; host?: string; command?: string
  /** How the value was used: reveal (shown to the agent), env (a command), fill (a browser page), list. */
  use?: 'reveal' | 'env' | 'fill' | 'list'
  approvedBy?: string; count?: number; summary?: string
}
export interface SyncCounts { added: number; updated: number; trashed: number; conflicts: number; unchanged: number; ambiguous?: number }
export interface BitwardenSyncReport {
  at: string; ok: boolean; trigger: string; counts: SyncCounts; byType: Record<string, SyncCounts>
  bitwarden: Record<string, number>; linked: Record<string, number>; error?: string
}
export interface BitwardenSyncStatus { /** The person added Bitwarden as a source (or synced from it before). Absent from an older server. */ added?: boolean; daily: boolean; last: BitwardenSyncReport | null; summary?: string }

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

/** This window's unlock is over (its session lapsed, or the vault closed): show the lock screen. */
export function isLockedError(err: unknown): boolean {
  return err instanceof VaultApiError && ((err.status === 401 && err.code === 'vault_session_needed') || (err.status === 423 && err.code === 'vault_locked'))
}

const TOKEN_KEY = 'walnut.vault.session'
const listeners = new Set<() => void>()

// Storage off (a private window's quota, a policy): the session lives as long as the page.
let memoryToken: string | null = null

export function vaultSession(): string | null {
  try {
    let t = localStorage.getItem(TOKEN_KEY)
    // A tab an older Walnut unlocked kept its token in sessionStorage: carried over once.
    const old = sessionStorage.getItem(TOKEN_KEY)
    if (old) {
      sessionStorage.removeItem(TOKEN_KEY)
      if (!t) { localStorage.setItem(TOKEN_KEY, old); t = old }
    }
    return t
  } catch { return memoryToken }
}

function setSession(token: string | null): void {
  memoryToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* storage off: memoryToken holds it */ }
  for (const l of listeners) l()
}

/** Drop `token` when it is still the one stored (a newer unlock in another tab stays). */
function dropSession(token: string | null): void {
  let cur: string | null = memoryToken
  try { cur = localStorage.getItem(TOKEN_KEY) } catch { /* memory only */ }
  if (!token || cur === token) setSession(null)
  else for (const l of listeners) l()
}

/** Called when this window's unlock changes (Lock, auto-lock, a 401, an unlock or Lock in another tab). */
export function onVaultSessionChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Another tab or window of this Walnut unlocked or locked: this one follows without a reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== TOKEN_KEY && e.key !== null) return
    for (const l of listeners) l()
  })
}

const BROWSER_KEY = 'walnut.vault.browser'
let memoryBrowserKey: string | null = null

/** This browser's key for sharing an unlock made on this computer, if the server gave it one. */
function browserKey(): string | null {
  try { return localStorage.getItem(BROWSER_KEY) } catch { return memoryBrowserKey }
}

function keepBrowserKey(r: { browserKey?: unknown }): void {
  if (typeof r.browserKey !== 'string' || !r.browserKey) return
  memoryBrowserKey = r.browserKey
  try { localStorage.setItem(BROWSER_KEY, r.browserKey) } catch { /* storage off: this page keeps it */ }
}

/** `used` learns the unlock the request went with, so a dead one is dropped and never a newer one. */
async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000, extra: Record<string, string> = {}, used?: { token: string | null }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  const device = getDeviceToken()
  if (device) headers.Authorization = `Bearer ${device}`
  const s = vaultSession()
  if (used) used.token = s
  if (s) headers['x-walnut-vault-session'] = s
  const bk = browserKey()
  if (bk) headers['x-walnut-vault-browser'] = bk
  const res = await fetch(`/api/v1${path}`, {
    method, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    // A closed vault (a restart, Lock all elsewhere) ends this window's unlock as a lapsed session does.
    if (s && ((res.status === 401 && data.code === 'vault_session_needed') || (res.status === 423 && data.code === 'vault_locked'))) dropSession(s)
    throw new VaultApiError(res.status, String(data.error ?? `HTTP ${res.status}`), typeof data.code === 'string' ? data.code : undefined, typeof data.waitMs === 'number' ? data.waitMs : undefined)
  }
  return data as T
}

const canDerive = () => typeof globalThis.crypto?.subtle?.deriveBits === 'function'

/**
 * The body that proves the master password: its key when WebCrypto is here, else the password
 * itself, and that only over a link the server calls private (it refuses one anyway; this
 * keeps the password from leaving the page at all).
 */
async function proof(password: string, kdf: KdfParams | undefined, field: 'password' | 'oldPassword' | 'newPassword' = 'password'): Promise<Record<string, string>> {
  const keyField = field === 'password' ? 'passwordKey' : field === 'oldPassword' ? 'oldPasswordKey' : 'newPasswordKey'
  if (kdf && canDerive()) return { [keyField]: toB64(await derivePasswordKey(password, kdf)) }
  if (!(await call<VaultStatus>('GET', '/vault/status')).privateLink) {
    throw new VaultApiError(400, 'Open Walnut over https or Tailscale to unlock Passwords from this device: plain http would send the master password readable on the network.', 'insecure_link')
  }
  return { [field]: password }
}

/** One unlock: the KDF read fresh, and once more when the master password changed meanwhile (`kdf_changed`). */
async function unlockOnce(password: string, secretKey?: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const kdf = (await call<VaultStatus>('GET', '/vault/status')).kdf
    try {
      const r = await call<{ session: { token: string }; browserKey?: string }>('POST', '/vault/unlock', {
        ...(await proof(password, kdf)), ...(kdf ? { kdfSalt: kdf.salt } : {}), ...(secretKey ? { secretKey } : {}), client: CLIENT,
      }, 60_000)
      keepBrowserKey(r)
      setSession(r.session.token)
      return
    } catch (err) {
      if (tries === 0 && err instanceof VaultApiError && err.code === 'kdf_changed') continue
      throw err
    }
  }
}

function newKdf(): KdfParams | undefined {
  if (!canDerive()) return undefined // the server picks the salt and derives
  return { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(randomBytes(16)) }
}

const CLIENT = 'Walnut web'

export const vaultApi = {
  /**
   * The vault's state for this window: an unlock the server no longer knows is dropped here, and a
   * locked window that may share an unlock made on this computer (`canJoin`) takes it, with no
   * password. `quiet`: a check the page makes by itself (is this window still unlocked?), which is
   * no use of the vault (a share is none either: it renews nothing).
   */
  async status(opts: { quiet?: boolean } = {}): Promise<VaultStatus> {
    const used = { token: null as string | null }
    const quiet: Record<string, string> = opts.quiet ? { 'x-walnut-vault-quiet': '1' } : {}
    const st = await call<VaultStatus>('GET', '/vault/status', undefined, 20_000, quiet, used)
    if (!st.unlocked && used.token) dropSession(used.token)
    if (st.unlocked || !st.canJoin) return st
    // Another tab may have taken it meanwhile: share only while this browser still has no unlock.
    if (vaultSession()) return call<VaultStatus>('GET', '/vault/status', undefined, 20_000, quiet)
    try {
      const r = await call<{ session: { token: string } }>('POST', '/vault/join', { client: CLIENT })
      if (!vaultSession()) setSession(r.session.token)
    } catch { return { ...st, canJoin: false } } // the unlock ended meanwhile: the lock screen stays
    return call<VaultStatus>('GET', '/vault/status', undefined, 20_000, quiet)
  },

  async setup(password: string, hint = ''): Promise<RecoveryKit> {
    const kdf = newKdf()
    const r = await call<RecoveryKit & { session: { token: string }; browserKey?: string }>('POST', '/vault/setup', {
      ...(await proof(password, kdf)), ...(kdf ? { kdf } : {}), agentsWhileAway: false, client: CLIENT, ...(hint ? { hint } : {}),
    }, 60_000)
    keepBrowserKey(r)
    setSession(r.session.token)
    return { secretKey: r.secretKey, recoveryCode: r.recoveryCode }
  },

  /** A forgotten master password: the recovery code sets a new one and returns the new kit. */
  async recover(recoveryCode: string, newPassword: string, secretKey?: string, hint = ''): Promise<RecoveryKit> {
    const kdf = newKdf()
    const r = await call<RecoveryKit & { session: { token: string }; browserKey?: string }>('POST', '/vault/recover', {
      recoveryCode, ...(secretKey ? { secretKey } : {}), ...(await proof(newPassword, kdf, 'newPassword')), ...(kdf ? { kdf } : {}), client: CLIENT, hint,
    }, 60_000)
    keepBrowserKey(r)
    setSession(r.session.token)
    return { secretKey: r.secretKey, recoveryCode: r.recoveryCode }
  },

  /**
   * Unlock with the master password. The KDF is read fresh first (another window may have
   * changed the master password since this page loaded), and its salt rides along so the
   * server can say "changed" instead of counting a wrong password; then it tries once more.
   * While another unlock is being checked (`429 unlock_busy`) it waits and sends it again, a few
   * times (core/vault/unlock-retry.ts); `opts.onWait` is where the form shows "Checking…". A wrong
   * password is never sent again.
   */
  async unlock(password: string, _kdf: KdfParams | undefined, secretKey?: string, opts: RetryOptions = {}): Promise<void> {
    return throwingWhileUnlockBusy(() => unlockOnce(password, secretKey), (err) => (err instanceof VaultApiError ? busyWaitOf(err) : null), opts)
  },

  /** The person's Lock: every window and the browser extension lock (`all`: and every agent grant ends). */
  async lock(all = false): Promise<void> {
    try { await call('POST', '/vault/lock', all ? { all: true } : { everywhere: true }) } finally { setSession(null) }
  },

  /** An auto-lock: only this browser's unlock ends (every tab of it shares one). */
  async lockThisBrowser(): Promise<void> {
    const s = vaultSession()
    try { await call('POST', '/vault/lock', {}) } finally { dropSession(s) }
  },

  /** Forget the unlock `token` names without asking the server (it already ended it); a newer one stays. */
  forget: (token: string | null) => { if (token) dropSession(token) },

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
  agentPolicy: () => call<AgentPolicy>('GET', '/vault/agent/policy'),
  setAgentsSwitch: (agents: AgentsSwitch) => call<AgentPolicy>('PUT', '/vault/agent/policy', { agents }),
  setGrantLength: (grantMs: number) => call<AgentPolicy>('PUT', '/vault/agent/policy', { grantMs }),
  endAgentGrants: () => call<{ grants: number; asks: number }>('POST', '/vault/agent/grants/end'),
  revokeGrant: (id: string) => call<{ revoked: AgentGrant }>('POST', `/vault/agent/grants/${encodeURIComponent(id)}/revoke`),
  bitwardenSync: () => call<BitwardenSyncStatus>('GET', '/vault/sync/bitwarden'),
  runBitwardenSync: (allowMassTrash = false) => call<{ report: BitwardenSyncReport; summary: string }>('POST', '/vault/sync/bitwarden/run', allowMassTrash ? { allowMassTrash: true } : {}, 400_000),
  keychain: () => call<{ available: boolean; present: boolean; service: string }>('GET', '/vault/keychain'),
  removeKeychain: () => call<{ removed: boolean }>('DELETE', '/vault/keychain'),
  agentLog: () => call<{ entries: AgentLogEntry[] }>('GET', '/vault/agent/log').then((r) => r.entries),

  /** Turning agents-while-away on or off asks for the master password again; off brings a new recovery kit. */
  async setAgentsWhileAway(on: boolean, password: string, kdf: KdfParams | undefined): Promise<VaultStatus & { recoveryKit?: RecoveryKit }> {
    return call<VaultStatus & { recoveryKit?: RecoveryKit }>('POST', '/vault/settings', { agentsWhileAway: on, ...(await proof(password, kdf)) }, 60_000)
  },

  /** The person saved the newest kit: Walnut stops asking for one. */
  confirmRecoveryKit: () => call('POST', '/vault/recovery-kit/confirm'),

  /** A new recovery kit (a new recovery code; the old one stops working). Needs the master password. */
  /** The vault's Secret Key, to set up another device (the iPhone app) by pasting it there once. */
  async revealSecretKey(password: string, kdf: KdfParams | undefined): Promise<string> {
    return (await call<{ secretKey: string }>('POST', '/vault/secret-key', { ...(await proof(password, kdf)) }, 60_000)).secretKey
  },

  async newRecoveryKit(password: string, kdf: KdfParams | undefined): Promise<RecoveryKit> {
    return call<RecoveryKit>('POST', '/vault/recovery-kit', { ...(await proof(password, kdf)) }, 60_000)
  },

  /** A new master password; the vault's recovery code changes with it (the new kit comes back). */
  async changePassword(oldPassword: string, newPassword: string, kdf: KdfParams | undefined, hint = ''): Promise<{ recoveryKit?: RecoveryKit }> {
    const next = newKdf()
    const r = await call<{ recoveryKit?: RecoveryKit; browserKey?: string }>('POST', '/vault/password', {
      ...(await proof(oldPassword, kdf, 'oldPassword')), ...(await proof(newPassword, next, 'newPassword')), ...(next ? { kdf: next } : {}), hint,
    }, 60_000)
    // Every other browser's key ended with the old password; this one gets a new one.
    keepBrowserKey(r)
    return r
  },

  /** A new master password hint (checked against the master password), or '' to remove it (no password needed). */
  async setHint(hint: string, password: string, kdf: KdfParams | undefined): Promise<void> {
    await call('PUT', '/vault/hint', { hint, ...(hint ? await proof(password, kdf) : {}) }, 60_000)
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
let lastCopy = 0

export async function copySecret(text: string, clearMs = 30_000): Promise<void> {
  await navigator.clipboard.writeText(text)
  const mine = ++lastCopy
  window.setTimeout(() => {
    void navigator.clipboard.readText()
      .then((now) => (now === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => {
        // Reading the clipboard is refused (Safari, Firefox): clear it only when this page made
        // the last copy and still has focus, so something the person copied elsewhere since stays.
        if (mine === lastCopy && document.hasFocus()) void navigator.clipboard.writeText('').catch(() => {})
      })
  }, clearMs)
}
