import { apiGet } from './client';

/** One file of Walnut's artifacts folder (src/web/routes/artifacts.ts), by its absolute path. */
export interface ArtifactFile { path: string; name: string; kind: 'memory' | 'guidance' | 'skill' | 'note' | 'reflection'; bytes: number; at: string }
export interface ArtifactGroup { id: string; title: string; task_id?: string; files: ArtifactFile[] }

export async function fetchArtifacts(): Promise<{ root: string; groups: ArtifactGroup[] }> {
  return apiGet<{ root: string; groups: ArtifactGroup[] }>('/api/artifacts');
}
