/**
 * The plugin AI row's data (GET/PATCH /api/plugin-runtime/:id/ai), read defensively: an older
 * server, a proxy or a half-written reply may leave fields out, and the row then shows what it
 * has instead of throwing and taking the whole Plugins section down with it.
 */

export interface PluginAiState { enabled: boolean; monthlyUsd: number; spentUsd: number; calls: number; lastAt: string | null }

export const DEFAULT_MONTHLY_USD = 10

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** A reply with nothing usable (not an object) is null: the row stays hidden. */
export function readPluginAiState(answer: unknown, previous?: PluginAiState | null): PluginAiState | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return previous ?? null
  const a = answer as Record<string, unknown>
  const base = previous ?? { enabled: true, monthlyUsd: DEFAULT_MONTHLY_USD, spentUsd: 0, calls: 0, lastAt: null }
  return {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : base.enabled,
    monthlyUsd: num(a.monthlyUsd, base.monthlyUsd),
    spentUsd: num(a.spentUsd, base.spentUsd),
    calls: Math.floor(num(a.calls, base.calls)),
    lastAt: typeof a.lastAt === 'string' ? a.lastAt : base.lastAt,
  }
}

export function money(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

/** Shown once the plugin used AI, or once the user changed its defaults. */
export function pluginAiRowVisible(state: PluginAiState | null): state is PluginAiState {
  return !!state && !(state.calls === 0 && state.enabled && state.monthlyUsd === DEFAULT_MONTHLY_USD)
}

export function pluginAiHelp(state: PluginAiState): string {
  const over = state.spentUsd >= state.monthlyUsd
  return `${money(state.spentUsd)} of ${money(state.monthlyUsd)} this month, ${state.calls} ${state.calls === 1 ? 'call' : 'calls'}`
    + (over ? '. Out of budget: calls are refused until next month or a higher budget' : '')
    + (!state.enabled ? '. Off: calls are refused' : '')
    + (over || !state.enabled ? '.' : '')
}
