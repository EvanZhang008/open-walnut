import { apiGet, apiPut } from './client';

export async function fetchGlobalNotes(): Promise<string> {
  const res = await apiGet<{ content: string }>('/api/notes/global');
  return res.content;
}

export async function saveGlobalNotes(content: string): Promise<void> {
  await apiPut('/api/notes/global', { content });
}
