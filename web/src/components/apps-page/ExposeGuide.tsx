/**
 * A plugin that brings a tunnel provider (it registers one through `walnut.expose`) is how a
 * phone or another browser reaches this Walnut, so the next step after installing it is the
 * Browser link page. This row leads there from the plugin's page and from the notice an install
 * leaves, and says so when the link already runs through it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useEvent } from '@/hooks/useWebSocket'
import { SettingsNotice } from '@/components/settings/SettingsSection'

/** The Settings page that turns the browser link on (Phones & Cloud, Browser link). */
export const BROWSER_LINK_PANE = 'devices-browser'

export interface ExposeOverview {
  providers: Array<{ id: string; title: string; owner?: string }>
  status: { enabled: boolean; provider: string | null; state?: string }
}

/** The provider one of these plugins registers, and whether the browser link uses it now. */
export function exposeGuideFor(view: ExposeOverview | null, pluginIds: readonly string[]): { title: string; on: boolean } | null {
  if (!view) return null
  const provider = view.providers.find((p) => p.owner && pluginIds.includes(p.owner))
  if (!provider) return null
  return { title: provider.title, on: view.status.enabled && view.status.provider === provider.id }
}

function useExposeOverview(): ExposeOverview | null {
  const [overview, setOverview] = useState<ExposeOverview | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/expose')
      if (!res.ok) return
      const body = await res.json() as { providers?: ExposeOverview['providers']; status?: Partial<ExposeOverview['status']> }
      setOverview({
        providers: body.providers ?? [],
        status: { enabled: body.status?.enabled === true, provider: body.status?.provider ?? null, state: body.status?.state },
      })
    } catch { /* no row: nothing to lead to */ }
  }, [])
  useEffect(() => { void load() }, [load])
  // A plugin that was just installed registers its provider a moment later.
  useEvent('plugin:runtime-changed', () => { void load() })
  return overview
}

export function ExposeGuide({ pluginIds, testId = 'expose-guide' }: { pluginIds: readonly string[]; testId?: string }) {
  const guide = exposeGuideFor(useExposeOverview(), pluginIds)
  if (!guide) return null
  return (
    <div className="apps-expose-guide" data-testid={testId} data-expose-on={guide.on ? 'true' : 'false'}>
      <SettingsNotice
        kind="info"
        action={(
          <Link className="settings-button settings-button-primary" to={`/settings#${BROWSER_LINK_PANE}`} data-testid={`${testId}-open`}>
            {guide.on ? 'Open browser link settings' : 'Set up the phone link'}
          </Link>
        )}
      >
        {guide.on
          ? <>Your browser link runs through {guide.title}.</>
          : <>{guide.title} opens this Walnut from your phone or any browser. Next: turn on the browser link.</>}
      </SettingsNotice>
    </div>
  )
}
