import { apiGet, apiPut } from './client';
import { memoryDocKey, publishDocSaved, beginDocSave, endDocSave } from '@/stores/file-save-signal';

/**
 * Announce a memory write on the browser-local doc-saved signal, and hold the
 * "a save is mid-air" flag across the request. Both matter for ONE reason: the
 * server emits `memory:updated` BEFORE it answers the PUT, so the /memory page
 * would see its OWN write as a foreign one (its `contentHash` state is still the
 * pre-save token) and re-read the file on every keystroke burst. The flag lets it
 * recognize the mid-air case, and the registered hash lets it recognize the echo
 * afterwards.
 */
async function writeMemoryDocument(
  relPath: string,
  content: string,
  put: () => Promise<MemorySaveResult>,
  origin?: string,
): Promise<MemorySaveResult> {
  const key = memoryDocKey(relPath);
  beginDocSave(key);
  try {
    const res = await put();
    if (res.contentHash) {
      publishDocSaved({ key, contentHash: res.contentHash, content, origin: origin ?? 'anonymous' });
    }
    return res;
  } finally {
    endDocSave(key);
  }
}

export interface MemoryEntry {
  path: string;
  category: string;
  content: string;
  updated_at: string;
  /** Optimistic-lock token for the bytes read — send it back as `expectedHash`.
   *  Absent from older servers, in which case the write stays last-write-wins. */
  contentHash?: string;
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
  user?: BrowseItem | null;
  daily: BrowseDailyItem[];
  projects: BrowseItem[];
  sessions: BrowseItem[];
  knowledge: BrowseItem[];
  repos?: BrowseItem[];
  topics?: BrowseItem[];
  compaction?: BrowseItem[];
  special?: BrowseItem[];
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
    contentHash?: string;
  };
}

/** What every memory write answers with. `contentHash` is the new lock token. */
export interface MemorySaveResult {
  ok: boolean;
  updatedAt: string;
  contentHash?: string;
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

/**
 * Write MEMORY.md. `expectedHash` is the token the read handed over: the server
 * answers 409 when the bytes on disk no longer hash to it, so a memory doc open
 * in two surfaces (the /memory editor and a Files-panel view of the same file)
 * can no longer silently overwrite the other one's change. Omitting it keeps the
 * old last-write-wins behaviour.
 */
export async function saveGlobalMemory(
  content: string,
  expectedHash?: string,
  origin?: string,
): Promise<MemorySaveResult> {
  return writeMemoryDocument('MEMORY.md', content, () =>
    apiPut<MemorySaveResult>('/api/memory/global', { content, expectedHash }), origin);
}

export async function fetchUserMemory(): Promise<MemoryContentResponse['memory']> {
  const res = await apiGet<MemoryContentResponse>('/api/memory/user');
  return res.memory;
}

export async function saveUserMemory(
  content: string,
  expectedHash?: string,
  origin?: string,
): Promise<MemorySaveResult> {
  return writeMemoryDocument('USER.md', content, () =>
    apiPut<MemorySaveResult>('/api/memory/user', { content, expectedHash }), origin);
}

export async function saveMemory(
  path: string,
  content: string,
  expectedHash?: string,
  origin?: string,
): Promise<MemorySaveResult> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return writeMemoryDocument(path, content, () =>
    apiPut<MemorySaveResult>(`/api/memory/${encoded}`, { content, expectedHash }), origin);
}
