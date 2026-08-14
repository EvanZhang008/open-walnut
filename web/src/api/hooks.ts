import { apiGet, apiPatch } from './client';

/** One tunable knob a hook exposes, with its current value. */
export interface HookSetting {
  key: string
  label: string
  path: string
  type: 'number' | 'boolean'
  unit?: string
  default: number | boolean
  min?: number
  max?: number
  help?: string
  value: number | boolean
}

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
  /** Present + non-empty when the hook has knobs beyond on/off. */
  settings?: HookSetting[]
  note?: string
}

export interface HookPatchResult {
  ok: boolean
  id: string
  enabled?: boolean
  requiresDaemonRestart?: boolean
  note?: string
  override?: { enabled?: boolean; priority?: number; timeoutMs?: number }
  /** Echoed back after a settings write, so the caller can trust server state. */
  settings?: HookSetting[]
}

export async function fetchHooks(): Promise<HookInfo[]> {
  return apiGet<HookInfo[]>('/api/hooks')
}

export async function patchHook(
  id: string,
  patch: {
    enabled?: boolean
    priority?: number
    timeoutMs?: number
    /** Hook-declared knobs, keyed by HookSetting.key. */
    settings?: Record<string, number | boolean>
  },
): Promise<HookPatchResult> {
  return apiPatch<HookPatchResult>(`/api/hooks/${encodeURIComponent(id)}`, patch)
}
