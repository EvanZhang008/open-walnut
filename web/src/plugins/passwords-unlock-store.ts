/**
 * One Passwords unlock a plugin asked for (walnut.passwords.unlock), shown by PasswordsUnlockHost
 * over whatever is open. Nothing here holds a password: only who asks, why, and the vault's status.
 */
import type { VaultStatus } from '@/api/vault'

export interface PasswordsUnlockRequest {
  sequence: number
  pluginName: string
  reason: string
  status: VaultStatus
}

const listeners = new Set<() => void>()
let request: PasswordsUnlockRequest | null = null
let settle: ((ok: boolean) => void) | null = null
let sequence = 0
let opener: Element | null = null

export const getPasswordsUnlock = (): PasswordsUnlockRequest | null => request
export const getPasswordsUnlockOpener = (): Element | null => opener
export function subscribePasswordsUnlock(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(): void { for (const listener of listeners) listener() }

/** Opens the unlock; one at a time, so a second ask while one is open answers false. */
export function askPasswordsUnlock(pluginName: string, reason: string, status: VaultStatus): Promise<boolean> {
  if (request) return Promise.resolve(false)
  opener = typeof document === 'undefined' ? null : document.activeElement
  request = { sequence: ++sequence, pluginName, reason, status }
  const answer = new Promise<boolean>((resolve) => { settle = resolve })
  publish()
  return answer
}

/** The identity fence keeps a late close from settling a newer ask. */
export function settlePasswordsUnlock(expectedSequence: number, ok: boolean): void {
  if (request?.sequence !== expectedSequence) return
  const done = settle
  request = null
  settle = null
  publish()
  done?.(ok)
}
