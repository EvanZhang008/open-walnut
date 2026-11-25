/**
 * Locked and hidden notes (docs/reference/locked-notes.md). A locked note's text is sealed with the
 * master password, read and saved through the vault's routes with this window's Passwords unlock;
 * nothing here keeps it: no cache, no storage, only what the caller holds while it shows it. A
 * hidden note is plain text no agent tool reads: hiding and unhiding need no password, and its
 * text is read and saved like any note's (notes-v2), by the person only.
 */
import { apiPost } from './client';
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

/** What a hide or an unhide answers: no text, so it is kept like any answer. */
export interface HiddenNoteChange { path: string; contentHash: string; updatedAt: string; hidden: boolean; changed: boolean }

export const hiddenNotesApi = {
  hide: (path: string, expectedHash?: string) =>
    apiPost<HiddenNoteChange>('/api/v1/notes/hide', { path, ...(expectedHash ? { expectedHash } : {}) }),
  unhide: (path: string, expectedHash?: string) =>
    apiPost<HiddenNoteChange>('/api/v1/notes/unhide', { path, ...(expectedHash ? { expectedHash } : {}) }),
};
