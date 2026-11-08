/**
 * The one place Walnut reads a secret out of the macOS keychain (`security find-generic-password -w`).
 *
 * Walnut otherwise only asks whether a keychain item exists (claude-check-core.ts), because a
 * secret read on a locked login keychain shows an unlock dialog on the person's screen and waits
 * there. The password manager is the exception: it reads back items the person put there for it,
 * and only those (KEYCHAIN_SECRETS): the vault's master password, kept so the vault opens on this
 * Mac without typing (passwords.md, "Unlocking"), and the Bitwarden CLI session for the daily sync.
 *
 * The gate, since no `security` call tells "locked" apart without itself possibly prompting:
 * - an allow-listed service only;
 * - the item must exist first (asked without -w, which reads no secret);
 * - a deadline, in a child process (child-run.ts), never a sync call;
 * - a failed or timed-out probe or read of a service pauses reads of it for GIVE_UP_MS, so a
 *   locked keychain shows the person at most one dialog per pause, never one per sync or retry.
 *   ("No such item", exit 44, is an answer, not a failure.)
 * tests/providers/claude-check-core.test.ts's class guard lists this file as the only reader.
 */
import os from 'node:os'
import { runVaultHelper } from './child-run.js'
import { IS_DEMO } from '../../constants.js'

/** The services Walnut may read a secret of, and why. */
export const KEYCHAIN_SECRETS = {
  'walnut-vault-master': 'the vault master password the person chose to keep in this Mac\'s keychain',
  BW_SESSION: 'the Bitwarden CLI session the person stored for the daily Bitwarden sync',
} as const
export type KeychainSecretService = keyof typeof KEYCHAIN_SECRETS

const TIMEOUT_MS = 10_000
const GIVE_UP_MS = 6 * 3600_000
const NOT_FOUND = 44
const gaveUp = new Map<string, number>()

export function keychainAccount(): string {
  try { return os.userInfo().username } catch { return process.env.USER ?? '' }
}

/** Tests: forget the failed reads. */
export function resetKeychainSecretForTest(): void {
  gaveUp.clear()
}

function paused(service: string, now: () => number): boolean {
  const at = gaveUp.get(service)
  if (at === undefined) return false
  if (now() - at < GIVE_UP_MS) return true
  gaveUp.delete(service)
  return false
}

/** The item's secret, or null (not a Mac, no item, a failed read, or reads of it stopped). */
export async function readKeychainSecret(service: KeychainSecretService, platform: string = process.platform, now: () => number = Date.now): Promise<string | null> {
  if (IS_DEMO || platform !== 'darwin' || !(service in KEYCHAIN_SECRETS) || paused(service, now)) return null
  const account = keychainAccount()
  const present = await runVaultHelper('security', ['find-generic-password', '-s', service, '-a', account], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 })
  if (present.code !== 0) {
    if (present.code !== NOT_FOUND) gaveUp.set(service, now())
    return null
  }
  const r = await runVaultHelper('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 })
  if (r.code !== 0 || !r.stdout) {
    gaveUp.set(service, now())
    return null
  }
  // `-w` prints the secret and one newline; anything else is the secret's own.
  const v = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout
  return v || null
}
