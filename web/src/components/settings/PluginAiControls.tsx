/**
 * A plugin's AI row in the Plugins section, under its row once it has used `walnut.ai`
 * (src/core/ai/ai-policy.ts): spend this month against its budget, the budget, and the switch.
 */
import { useEffect, useState } from 'react'
import { apiGet, apiPatch } from '@/api/client'
import { SettingsRow } from './SettingsSection'
import { NumberInput } from './inputs/NumberInput'
import { ToggleSwitch } from './inputs/ToggleSwitch'
import '@/styles/settings-sections-addons.css'

interface PluginAiState { enabled: boolean; monthlyUsd: number; spentUsd: number; calls: number; lastAt: string | null }

const DEFAULT_MONTHLY_USD = 10

function money(n: number): string {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

export function PluginAiControls({ pluginId }: { pluginId: string }) {
  const base = `/api/plugin-runtime/${encodeURIComponent(pluginId)}/ai`
  const [state, setState] = useState<PluginAiState | null>(null)
  const [budget, setBudget] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiGet<PluginAiState>(base, undefined, { quietStatuses: [400, 404] })
      .then((answer) => { if (live) { setState(answer); setBudget(answer.monthlyUsd) } })
      .catch(() => { /* an older server has no AI row */ })
    return () => { live = false }
  }, [base])

  // Shown once the plugin used AI, or once the user changed its defaults.
  if (!state || (state.calls === 0 && state.enabled && state.monthlyUsd === DEFAULT_MONTHLY_USD)) return null

  const save = async (patch: { enabled?: boolean; monthlyUsd?: number }) => {
    setBusy(true)
    setError(null)
    try {
      const saved = await apiPatch<{ enabled: boolean; monthlyUsd: number }>(base, patch)
      setState((prev) => (prev ? { ...prev, ...saved } : prev))
      setBudget(saved.monthlyUsd)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const commitBudget = () => {
    if (budget === undefined || budget === state.monthlyUsd) return
    void save({ monthlyUsd: budget })
  }
  const over = state.spentUsd >= state.monthlyUsd

  return (
    <div className="settings-addons-rows plugin-app-controls" data-testid={`plugin-ai-${pluginId}`}>
      <SettingsRow
        indent
        className="plugin-app-controls-row"
        state={over ? 'error' : undefined}
        label={<span className="plugin-app-controls-label">AI</span>}
        help={
          <span data-testid={`plugin-ai-help-${pluginId}`}>
            {`${money(state.spentUsd)} of ${money(state.monthlyUsd)} this month, ${state.calls} ${state.calls === 1 ? 'call' : 'calls'}`}
            {over ? '. Out of budget: calls are refused until next month or a higher budget.' : ''}
            {!state.enabled ? '. Off: calls are refused.' : ''}
          </span>
        }
        error={error ?? undefined}
        control={
          <span className="settings-addons-inline">
            <NumberInput
              aria-label="Monthly AI budget in dollars"
              data-testid={`plugin-ai-budget-${pluginId}`}
              value={budget}
              min={0}
              step={1}
              unit="$ a month"
              onChange={setBudget}
              onBlur={commitBudget}
              onEnter={commitBudget}
            />
            <ToggleSwitch
              aria-label="Let this plugin use AI"
              data-testid={`plugin-ai-toggle-${pluginId}`}
              checked={state.enabled}
              busy={busy}
              onChange={(enabled) => void save({ enabled })}
            />
          </span>
        }
      />
    </div>
  )
}
