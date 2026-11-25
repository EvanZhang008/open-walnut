/**
 * Locked and hidden notes (docs/reference/locked-notes.md). A locked note's text is sealed with the
 * master password, read and saved through the vault's routes with this window's Passwords unlock;
 * nothing here keeps it: no cache, no storage, only what the caller holds while it shows it. A
 * hidden note is plain text no agent tool reads: hiding and unhiding need no password, and its
 * text is read and saved like any note's (notes-v2), by the person only.
 */
import { apiPost } from './client';
import { proof, vaultCall, VaultApiError } from './vault';
import { busyWaitOf, throwingWhileUnlockBusy } from '../../../src/core/vault/unlock-retry';
import type { KdfParams } from '../../../src/core/vault/crypto';

export interface LockedNoteText { content: string; contentHash: string; updatedAt: string; path: string }
export interface LockedNoteSaved { contentHash: string; updatedAt: string; path: string }

export const lockedNotesApi = {
  read: (path: string) => vaultCall<LockedNoteText>('POST', '/vault/notes/read', { path }),
  save: (path: string, content: string, expectedHash: string) =>
    vaultCall<LockedNoteSaved>('POST', '/vault/notes/save', { path, content, expectedHash }),
  lock: (path: string, expectedHash?: string) =>
    vaultCall<LockedNoteSaved>('POST', '/vault/notes/lock', { path, ...(expectedHash ? { expectedHash } : {}) }),
  removeLock: (path: string, expectedHash?: string) =>
    vaultCall<LockedNoteText>('POST', '/vault/notes/remove-lock', { path, ...(expectedHash ? { expectedHash } : {}) }),
  /** The key's backups in the data folder, the newest first (404 no_key_backup: none). */
  keyBackups: async (): Promise<KeyBackupVault[]> => {
    const b = await vaultCall<KeyBackupVault & { earlier?: KeyBackupVault[] }>('GET', '/vault/notes/key-backup');
    return [b, ...(b.earlier ?? [])];
  },
  /**
   * Put the keys of one backup back into Passwords, with the master password and Secret Key of the
   * vault that made it. It checks a master password, so while another check runs (`429 unlock_busy`)
   * it waits and sends it again, as an unlock does; a wrong password is never sent again.
   */
  restoreKey: async (from: KeyBackupVault, password: string, secretKey: string) => {
    const body = { ...(await proof(password, from.kdf)), secretKey, vaultId: from.vaultId };
    return throwingWhileUnlockBusy(() => vaultCall<{ added: number }>('POST', '/vault/notes/restore-key', body, 60_000),
      (err) => (err instanceof VaultApiError ? busyWaitOf(err) : null));
  },
};

/** One backup of the locked-notes key (core/vault/locked-notes-key-backup.ts): no secret in it. */
export interface KeyBackupVault { vaultId: string; kdf: KdfParams; hint?: string; keys: number }

/** What a hide or an unhide answers: no text, so it is kept like any answer. */
export interface HiddenNoteChange { path: string; contentHash: string; updatedAt: string; hidden: boolean; changed: boolean }

export const hiddenNotesApi = {
  hide: (path: string, expectedHash?: string) =>
    apiPost<HiddenNoteChange>('/api/v1/notes/hide', { path, ...(expectedHash ? { expectedHash } : {}) }),
  unhide: (path: string, expectedHash?: string) =>
    apiPost<HiddenNoteChange>('/api/v1/notes/unhide', { path, ...(expectedHash ? { expectedHash } : {}) }),
};
