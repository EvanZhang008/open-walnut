/**
 * The extension's unlock with the master password, as its lock screens send it (the popup and the
 * side panel's Passwords view, popup.ts; the key popover, key-pop.ts): through the background
 * (background.ts 'unlock'), sent again while Walnut is checking another unlock (`unlock_busy`,
 * core/vault/unlock-retry.ts), with `onWait` the place to show "Checking…". A wrong password is
 * never sent again. And the words under the form for a refusal, the same for every lock screen.
 */
import { ask } from './ext'
import { busyWaitOf, unlockRefusalText, whileUnlockBusy, type RetryOptions } from '../../../src/core/vault/unlock-retry'

export interface UnlockReply { ok: boolean; error?: string; code?: string; waitMs?: number }

type Send = (msg: { type: string; [k: string]: unknown }) => Promise<UnlockReply>

/** Unlock with `password` (and the Secret Key when given); `send` is the background (tests pass their own). */
export function sendUnlock(password: string, secretKey: string, opts: RetryOptions & { send?: Send } = {}): Promise<UnlockReply> {
  const send: Send = opts.send ?? ((m) => ask<{ waitMs?: number }>(m))
  return whileUnlockBusy(() => send({ type: 'unlock', password, secretKey }), (r) => (r.ok ? null : busyWaitOf(r)), opts)
}

/** What a lock screen says for a refusal: "Too many tries. Wait N s." for the brake, else Walnut's words. */
export function unlockRefusal(r: UnlockReply): string {
  return unlockRefusalText({ code: r.code, waitMs: r.waitMs, message: r.error })
}
