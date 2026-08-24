import { useEffect, useState } from 'react'
import { ActionButton, Card, Chip, Facts } from './ui-kit'
import type { DemoContext, DemoStats } from './types'

export function DemoSettings(props: { demo: DemoContext }) {
  const { demo } = props
  const [stats, setStats] = useState<DemoStats | null>(null)

  useEffect(() => {
    let cancelled = false
    void demo.fetchStats().then((outcome) => {
      if (cancelled || !outcome.ok || typeof outcome.receipt !== 'object' || !outcome.receipt) return
      setStats(outcome.receipt as DemoStats)
    })
    return () => { cancelled = true }
  }, [demo])

  return (
    <div className="wd-root wd-settings" data-testid="plugin-demo-settings">
      <Card
        title="Walnut Plugin Demo"
        hint="A settings contribution renders inside the host's own settings page."
      >
        <Facts
          rows={[
            ['Plugin id', <code>{demo.walnut.pluginId}</code>],
            ['Walnut version', <code>{demo.walnut.walnutVersion}</code>],
            ['Registrations', String((stats?.registrations ?? []).length)],
            ['Demo task', stats?.demoTaskId ?? '(none)'],
            ['Secret keys', (stats?.secretKeys ?? []).join(', ') || '(none)'],
            ['Owns', <Chip tone="info">project "{stats?.demoProject ?? 'Plugin Demo'}" only</Chip>],
          ]}
        />
        <ActionButton
          action="settings-config-patch"
          label="Toggle demoFlag in plugin config"
          hint="Writes to config.plugins[&quot;walnut-demo&quot;]"
          perform={() => demo.run('config-patch')}
        />
      </Card>
    </div>
  )
}
