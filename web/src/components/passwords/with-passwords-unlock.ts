/**
 * A step of Walnut's own that needs Passwords unlocked in this window (a locked note,
 * docs/reference/locked-notes.md; approving an agent's ask for one): this window's own unlock, a
 * share of one made on this computer, or Walnut's unlock sheet with the master password. Nothing
 * here holds the password; the sheet derives its key and the server checks it.
 */
import { isLockedError, vaultApi } from '@/api/vault';
// A Lock anywhere (another window, the extension, Lock all) reaches this window at once.
import '@/api/vault-live';
import { askPasswordsUnlock, type UnlockWords } from '@/plugins/passwords-unlock-store';

export type UnlockOutcome = 'ok' | 'cancel' | 'not_set_up';

/** Unlocked when this resolves `ok`; the sheet is shown only when the window has no unlock to use. */
export async function ensurePasswordsUnlocked(sub: string, who = 'Notes'): Promise<UnlockOutcome> {
  const st = await vaultApi.status(); // takes an unlock made on this computer, when it may
  if (!st.setUp) return 'not_set_up';
  if (st.unlocked) return 'ok';
  return (await askPasswordsUnlock(who, '', st, sub)) ? 'ok' : 'cancel';
}

/**
 * Run `work`; when it is refused for a locked window, unlock once (the sheet) and run it again.
 * Answers null when the person cancelled the unlock; throws `not_set_up` as a VaultApiError-like
 * error when Passwords has no vault yet.
 */
export async function withPasswordsUnlock<T>(sub: string, work: () => Promise<T>, who = 'Notes'): Promise<T | null> {
  try {
    return await work();
  } catch (err) {
    if (!isLockedError(err)) throw err;
  }
  const outcome = await ensurePasswordsUnlocked(sub, who);
  if (outcome === 'not_set_up') throw Object.assign(new Error(NOT_SET_UP_WORDS), { code: 'vault_not_set_up' });
  if (outcome === 'cancel') return null;
  return work();
}

export const NOT_SET_UP_WORDS = 'Locked notes use your Passwords master password. Set up Passwords first (the Passwords app), then lock the note.';

/**
 * Run `work` right after the person types the master password here, even when this window is
 * already unlocked: a yes the server takes only with the password just typed (an agent's ask for a
 * locked note, src/web/routes/approvals-v1.ts). Null when they cancel.
 */
export async function withMasterPassword<T>(sub: string, work: () => Promise<T>, words: UnlockWords, who = 'Approvals'): Promise<T | null> {
  const st = await vaultApi.status();
  if (!st.setUp) throw Object.assign(new Error(NOT_SET_UP_WORDS), { code: 'vault_not_set_up' });
  if (!(await askPasswordsUnlock(who, '', st, sub, words))) return null;
  return work();
}
