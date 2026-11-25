/**
 * Locked notes (docs/reference/locked-notes.md): the text of a note sealed with the master
 * password, read and saved through the vault's routes with this window's Passwords unlock.
 * Nothing here keeps the text: no cache, no storage, only what the caller holds while it shows it.
 */
import { vaultCall } from './vault';

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
};
