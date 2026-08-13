import { apiGet, apiPatch } from './client';

/** Unified hook inventory entry (GET /api/hooks). */
export interface HookInfo {
  id: string
  name: string
  description?: string
  on: string[]
  domains: string[]
  runtime: 'walnut' | 'daemon'
  source: 'builtin' | 'config' | 'file' | 'daemon-policy' | 'inline'
  enabled: boolean
  priority: number
  timeoutMs?: number
  actionType?: string
  actionDetail?: string
  conditions: string[]
  mutable: 'config-override' | 'config-path' | 'readonly'
  configPath?: string
  note?: string
}

export interface HookPatchResult {
  ok: boolean
  id: string
  enabled?: boolean
  requiresDaemonRestart?: boolean
  note?: string
  override?: { enabled?: boolean; priority?: number; timeoutMs?: number }
}

export async function fetchHooks(): Promise<HookInfo[]> {
  return apiGet<HookInfo[]>('/api/hooks')
}

export async function patchHook(
  id: string,
  patch: { enabled?: boolean; priority?: number; timeoutMs?: number },
): Promise<HookPatchResult> {
  return apiPatch<HookPatchResult>(`/api/hooks/${encodeURIComponent(id)}`, patch)
}
