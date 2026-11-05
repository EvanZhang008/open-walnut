/**
 * Unlock with this Mac's keychain (docs/reference/passwords.md, "Unlocking"). The person may keep
 * the master password in the macOS keychain as a generic password, service KEYCHAIN_SERVICE,
 * account = the OS user. Walnut reads it through keychain-secret.ts (the one gated keychain
 * secret read: a child process with a deadline, at most one failed read per start), derives the password key with the
 * vault's own KDF and unlocks exactly as a typed password does: under the wrong-password brake,
 * the Secret Key from machine.json, and a session of the person's "Keep Passwords unlocked"
 * length. The password is never logged, returned or written anywhere.
 *
 * Used at server start when the choice is "until restart" or "forever" (background.ts), to reopen
 * the vault for the windows a restart kept (session-store.ts, reopenFromKeychain: no session of
 * its own), and by the daily Bitwarden sync when the vault is locked. macOS and the primary only;
 * elsewhere every call answers `unavailable`.
 */
import os from 'node:os'
import { runVaultHelper } from './child-run.js'
import { readKeychainSecret } from './keychain-secret.js'

export const KEYCHAIN_SERVICE = 'walnut-vault-master'
const TIMEOUT_MS = 10_000

let platformOverride: string | null = null

/** Tests: act as if on another platform (the `security` runner is swapped through child-run.ts). */
export function setKeychainPlatformForTest(p: string | null): void {
  platformOverride = p
  presentCache = null
}

/** Tests forced a platform (so a throwaway server may read the stubbed keychain). */
export function keychainForcedForTest(): boolean {
  return platformOverride !== null
}

export function keychainAvailable(): boolean {
  return (platformOverride ?? process.platform) === 'darwin'
}

function account(): string {
  try { return os.userInfo().username } catch { return process.env.USER ?? '' }
}

/** The master password from the keychain, or null when there is none (or it cannot be read). */
async function readMaster(): Promise<string | null> {
  if (!keychainAvailable()) return null
  return readKeychainSecret(KEYCHAIN_SERVICE, 'darwin')
}

let presentCache: { at: number; present: boolean } | null = null

/** Whether the keychain holds the item (no password is read: `find-generic-password` without -w). Cached 30 s. */
export async function keychainItemPresent(): Promise<boolean> {
  if (!keychainAvailable()) return false
  if (presentCache && Date.now() - presentCache.at < 30_000) return presentCache.present
  const r = await runVaultHelper('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account()], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 })
  presentCache = { at: Date.now(), present: r.code === 0 }
  return presentCache.present
}

/** Remove the keychain item (Settings). True when it was there. */
export async function removeKeychainItem(): Promise<boolean> {
  if (!keychainAvailable()) return false
  const r = await runVaultHelper('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account()], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 })
  presentCache = { at: Date.now(), present: false }
  return r.code === 0
}

export type KeychainUnlock =
  | { ok: true; session: { token: string; expiresAt: string | null } }
  | { ok: false; code: 'unavailable' | 'no_item' | 'not_set_up' | 'unlock_slowed' | 'unlock_busy' | 'wrong_password'; message: string; waitMs?: number }

/**
 * Unlock with the keychain's master password and open a session named `client` (the person's
 * window, or "this Mac" for a start-up or sync unlock nobody holds a token for).
 */
export async function unlockFromKeychain(opts: { client: string; device?: string }): Promise<KeychainUnlock> {
  const r = await keychainOpen(async (status) => {
    const { getConfig } = await import('../config-manager.js')
    const { unlockChoice } = await import('./unlock-length.js')
    const choice = unlockChoice((await getConfig()).passwords, status.agentsWhileAway)
    const s = await import('./sessions.js')
    // Walnut's own unlock (a sync, the start): a restart unlocks again, so none is kept for one.
    const session = s.createSession(opts.client, { ...choice.limits, survivesRestart: false }, opts.device)
    return { token: session.token, expiresAt: session.expiresAt }
  })
  return r.ok ? { ok: true, session: r.value } : r
}

/**
 * Reopen the vault with the keychain's master password, then run `then` while the check still
 * holds the brake's slot, so no close (closeIfNobody waits on a running check) falls between the
 * open and what `then` puts in place. No session of its own.
 */
export async function reopenFromKeychain<T>(then: () => Promise<T>): Promise<{ ok: true; value: T } | Extract<KeychainUnlock, { ok: false }>> {
  return keychainOpen(() => then())
}

async function keychainOpen<T>(then: (status: { agentsWhileAway: boolean }) => Promise<T>): Promise<{ ok: true; value: T } | Extract<KeychainUnlock, { ok: false }>> {
  if (!keychainAvailable()) return { ok: false, code: 'unavailable', message: 'Unlocking from the keychain works on a Mac only.' }
  const st = await import('./store.js')
  const status = await st.vaultStatus()
  if (!status.setUp || !status.kdf) return { ok: false, code: 'not_set_up', message: 'No vault yet: set one up first.' }
  const s = await import('./sessions.js')
  const busy = s.beginAttempt()
  if (busy) return { ok: false, code: busy.code, waitMs: busy.waitMs, message: busy.code === 'unlock_slowed' ? `Too many wrong passwords: try again in ${Math.ceil(busy.waitMs / 1000)} s.` : 'Another unlock is being checked; try again in a moment.' }
  let outcome: 'ok' | 'wrong' | 'other' = 'other'
  try {
    const master = await readMaster()
    if (!master) return { ok: false, code: 'no_item', message: `This Mac's keychain holds no "${KEYCHAIN_SERVICE}" item for ${account()}.` }
    const { derivePasswordKey, toB64 } = await import('./crypto.js')
    const passwordKey = toB64(await derivePasswordKey(master, status.kdf))
    try {
      await st.unlockVault({ passwordKey })
    } catch (err) {
      if (err instanceof st.VaultError && err.code === 'wrong_password') {
        outcome = 'wrong'
        return { ok: false, code: 'wrong_password', message: `The keychain's "${KEYCHAIN_SERVICE}" item is not the master password: update or remove it.` }
      }
      throw err
    }
    // Inside the attempt, as a typed unlock: no close can run between the open and the session.
    const value = await then(status)
    outcome = 'ok'
    return { ok: true, value }
  } finally {
    s.endAttempt(outcome)
  }
}
