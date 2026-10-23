import { apiGet, apiPost } from './client';

/** Mirrors ComponentStatus in src/core/components/types.ts. */
export interface ComponentStatus {
  name: 'embedding' | 'images' | 'audio-capture';
  label: string;
  /** waiting: another Walnut process on this machine holds the install; this one waits for it. */
  state: 'unsupported' | 'missing' | 'waiting' | 'downloading' | 'installing' | 'ready' | 'failed';
  platform: string | null;
  version: string | null;
  source?: 'bundled' | 'installed';
  size?: number;
  progress?: { done: number; total: number | null };
  error?: string;
  code?: string;
  updatedAt: string;
}

export function fetchComponentStatus(name: ComponentStatus['name']): Promise<ComponentStatus> {
  return apiGet<ComponentStatus>(`/api/components/${name}`);
}

/** Starts the download; the answer is the status at once, the install runs on. */
export function installComponent(name: ComponentStatus['name']): Promise<ComponentStatus> {
  return apiPost<ComponentStatus>(`/api/components/${name}/install`, undefined, { quietStatuses: [409] });
}
