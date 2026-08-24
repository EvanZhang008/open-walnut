import { useState } from 'react'
import { ActionButton, Card, Chip } from './ui-kit'
import type { DemoContext } from './types'

export function LifecycleSection(props: { demo: DemoContext }) {
  const { demo } = props
  const [armed, setArmed] = useState(false)

  return (
    <div className="wd-grid">
      <Card
        title="Reload"
        hint="Rebuilds the plugin's registrations from disk. Every owner-scoped contribution is disposed and registered again."
      >
        <ActionButton
          action="reload"
          label="Reload this plugin"
          tone="primary"
          hint="The app may flicker while the host re-registers it."
          perform={() => demo.lifecycle('reload')}
        />
      </Card>

      <Card
        title="Disable"
        hint="Removes the plugin until it is enabled again. Asks for confirmation, since this app disappears with it."
      >
        <ActionButton
          action="disable"
          label="Disable this plugin"
          tone="danger"
          perform={async () => {
            const confirmed = window.confirm(
              'Disable the Walnut Plugin Demo? This app, its agent, its tool and its skill all disappear until you enable it again.',
            )
            if (!confirmed) {
              return { ok: true, action: 'disable', ms: 0, receipt: { cancelled: true } }
            }
            return demo.lifecycle('disable')
          }}
        />
      </Card>

      <Card
        title="Controlled crash"
        hint="Throws inside this app's React tree on purpose. The host's PluginBoundary catches it; the console keeps working."
      >
        <div className="wd-row">
          <button
            type="button"
            className="wd-button wd-button-danger"
            data-testid="plugin-demo-action-crash"
            onClick={() => setArmed(true)}
          >
            Crash this app on purpose
          </button>
          <Chip tone="warn">Recover with Reload, or refresh the page</Chip>
        </div>
        <p className="wd-muted">
          There is no receipt for this one: the subtree that would render it is exactly what unmounts.
        </p>
        <CrashProbe armed={armed} />
      </Card>
    </div>
  )
}

function CrashProbe(props: { armed: boolean }) {
  if (props.armed) {
    throw new Error('Walnut Plugin Demo: controlled crash, shown so the host PluginBoundary is visible')
  }
  return null
}
