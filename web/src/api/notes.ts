import { apiGet, apiPost, apiPut } from './client';
import { noteDocKey, publishDocSaved } from '@/stores/file-save-signal';

/**
 * global-notes.md lives in the vault, so it is ALSO reachable through
 * /api/notes-v2 (the /notes editor) and through the Files panel. Its doc key is
 * the canonical vault name, which is what lets a save made through this legacy
 * endpoint reach those other surfaces (and be recognized as our own echo).
 */
export const GLOBAL_NOTES_DOC_KEY = noteDocKey('global-notes.md');

export async function fetchGlobalNotes(): Promise<{ content: string; contentHash: string }> {
  return apiGet<{ content: string; contentHash: string }>('/api/notes/global');
}

export async function saveGlobalNotes(
  content: string,
  expectedHash?: string,
  /** Mount id of the surface saving, for the browser-local doc-saved signal. */
  origin?: string,
): Promise<{ contentHash: string }> {
  const res = await apiPut<{ ok: boolean; contentHash: string }>('/api/notes/global', { content, expectedHash });
  publishDocSaved({
    key: GLOBAL_NOTES_DOC_KEY,
    contentHash: res.contentHash,
    content,
    origin: origin ?? 'anonymous',
  });
  return res;
}

/** Upload a base64 image and return the server URL */
export async function uploadNoteImage(data: string, mediaType: string): Promise<string> {
  const res = await apiPost<{ url: string }>('/api/images/upload', { data, mediaType });
  return res.url;
}
