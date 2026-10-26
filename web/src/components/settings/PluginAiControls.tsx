/**
 * A plugin's AI row in the Plugins section, under its row once it has used `walnut.ai`
 * (src/core/ai/ai-policy.ts): spend this month against its budget, the budget, and the switch.
 */
import { useEffect, useState } from 'react'
import { apiGet, apiPatch } from '@/api/client'
import { SettingsRow } from './SettingsSection'
import { NumberInput } from './inputs/NumberInput'
import { ToggleSwitch } from './inputs/ToggleSwitch'
import { pluginAiHelp, pluginAiRowVisible, readPluginAiState, type PluginAiState } from './plugin-ai-state'
import '@/styles/settings-sections-addons.css'

export function PluginAiControls({ pluginId }: { pluginId: string }) {
  const base = `/api/plugin-runtime/${encodeURIComponent(pluginId)}/ai`
  const [state, setState] = useState<PluginAiState | null>(null)
  const [budget, setBudget] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiGet<unknown>(base, undefined, { quietStatuses: [400, 404] })
      .then((answer) => {
        const read = readPluginAiState(answer)
        if (live && read) { setState(read); setBudget(read.monthlyUsd) }
      })
      .catch(() => { /* an older server has no AI row */ })
    return () => { live = false }
  }, [base])

  if (!pluginAiRowVisible(state)) return null

  const save = async (patch: { enabled?: boolean; monthlyUsd?: number }) => {
    setBusy(true)
    setError(null)
    try {
      const saved = await apiPatch<unknown>(base, patch)
      const next = readPluginAiState(saved, state)
      if (next) { setState(next); setBudget(next.monthlyUsd) }
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
            {pluginAiHelp(state)}
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
