import { apiGet, apiPut } from './client';

export interface MemoryEntry {
  path: string;
  category: string;
  content: string;
  updated_at: string;
}

export interface BrowseItem {
  path: string;
  title: string;
  updatedAt: string;
}

export interface BrowseDailyItem extends BrowseItem {
  date: string;
}

export interface MemoryBrowseTree {
  global: BrowseItem | null;
  daily: BrowseDailyItem[];
  projects: BrowseItem[];
  sessions: BrowseItem[];
  knowledge: BrowseItem[];
}

export interface MemoryBrowseResponse {
  tree: MemoryBrowseTree;
}

export interface MemoryContentResponse {
  memory: {
    path: string;
    title: string;
    category: string;
    content: string;
    createdAt: string;
    updatedAt: string;
  };
}

export async function fetchMemories(category?: string): Promise<MemoryEntry[]> {
  const params = category ? { category } : undefined;
  const res = await apiGet<{ memories: MemoryEntry[] }>('/api/memory', params);
  return res.memories;
}

export async function fetchMemory(path: string): Promise<MemoryEntry> {
  // Encode each path segment individually — the wildcard route expects real slashes
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await apiGet<{ memory: MemoryEntry }>(`/api/memory/${encoded}`);
  return res.memory;
}

export async function fetchMemoryBrowse(): Promise<MemoryBrowseTree> {
  const res = await apiGet<MemoryBrowseResponse>('/api/memory/browse');
  return res.tree;
}

export async function fetchGlobalMemory(): Promise<MemoryContentResponse['memory']> {
  const res = await apiGet<MemoryContentResponse>('/api/memory/global');
  return res.memory;
}

export async function saveGlobalMemory(content: string): Promise<{ ok: boolean; updatedAt: string }> {
  return apiPut<{ ok: boolean; updatedAt: string }>('/api/memory/global', { content });
}

export async function saveMemory(path: string, content: string): Promise<{ ok: boolean; updatedAt: string }> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return apiPut<{ ok: boolean; updatedAt: string }>(`/api/memory/${encoded}`, { content });
}
