import { apiGet, apiPost, apiPut } from './client';

export async function fetchGlobalNotes(): Promise<string> {
  const res = await apiGet<{ content: string }>('/api/notes/global');
  return res.content;
}

export async function saveGlobalNotes(content: string): Promise<void> {
  await apiPut('/api/notes/global', { content });
}

/** Upload a base64 image and return the server URL */
export async function uploadNoteImage(data: string, mediaType: string): Promise<string> {
  const res = await apiPost<{ url: string }>('/api/images/upload', { data, mediaType });
  return res.url;
}
