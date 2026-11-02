/**
 * A task plugin's own page (Apps › the plugin) names its sync rules and opens them: the rules
 * themselves live in Settings › Tasks › Task providers (TaskProvidersSection.tsx), one place for
 * every provider. Renders nothing for a plugin that does not sync tasks.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { summaryOf } from './task-provider-parts'
import { listTaskProviders, type ProviderRules } from '@/api/private-tasks'

export function TaskProviderRulesGroup({ pluginId, className }: { pluginId: string; className?: string }) {
  const navigate = useNavigate()
  const [rules, setRules] = useState<ProviderRules | null>(null)
  useEffect(() => {
    let alive = true
    listTaskProviders()
      .then((r) => { if (alive) setRules(r.providers.find((p) => p.id === pluginId) ?? null) })
      .catch(() => { if (alive) setRules(null) })
    return () => { alive = false }
  }, [pluginId])
  if (!rules) return null
  return (
    <SettingsGroup heading="Sync rules" className={className} data-testid={`plugin-sync-rules-${pluginId}`}>
      <SettingsRow
        label={`What may sync to ${rules.name}`}
        help={summaryOf(rules, rules.check, rules.words.length, rules.ai)}
        control={(
          <SettingsButton data-testid={`plugin-open-sync-rules-${pluginId}`} onClick={() => navigate('/settings#task-providers')}>
            Edit rules
          </SettingsButton>
        )}
      />
    </SettingsGroup>
  )
}
