import { useState } from 'react'
import { ActionButton, Card, Chip, Facts } from './ui-kit'
import type { DemoBadge, DemoContext, LayoutMode, SectionId } from './types'

const THEME_TOKENS = [
  '--accent',
  '--fg',
  '--fg-muted',
  '--bg-secondary',
  '--card-bg',
  '--border',
  '--success',
  '--warning',
  '--error',
]

export function PlatformSection(props: {
  demo: DemoContext
  section: SectionId
  layout: LayoutMode
  deepLink: string
  search: string
}) {
  const { demo, layout, deepLink } = props
  const [count, setCount] = useState(0)
  const [badge, setBadge] = useState<DemoBadge>(null)

  const applyBadge = (value: DemoBadge, action: string) => {
    demo.setBadge(value)
    setBadge(value)
    return { ok: true, action, ms: 0, receipt: { badge: value } }
  }

  return (
    <div className="wd-grid">
      <Card
        title="Shared React"
        hint="One React runtime. The plugin bundle imports the host's copy instead of shipping its own."
      >
        <ActionButton
          action="react-count"
          label={`React count: ${count}`}
          hint="Local state, host reconciler"
          tone="primary"
          perform={() => {
            const next = count + 1
            setCount(next)
            return { ok: true, action: 'react-count', ms: 0, receipt: { count: next } }
          }}
        />
      </Card>

      <Card
        title="Theme tokens"
        hint="Colours come from the console's CSS variables, so light and dark follow the host with no work."
        testId="plugin-demo-theme-tokens"
      >
        <ul className="wd-tokens">
          {THEME_TOKENS.map((token) => (
            <li key={token}>
              <span className="wd-swatch" style={{ background: `var(${token})` }} aria-hidden="true" />
              <code>{token}</code>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="App badge"
        hint="The handle returned by ui.app drives the badge. A count, a dot, or cleared."
      >
        <div className="wd-row">
          <ActionButton
            action="badge-count"
            label="Set count badge (3)"
            perform={() => applyBadge(3, 'badge-count')}
          />
          <ActionButton
            action="badge-dot"
            label="Set dot badge"
            perform={() => applyBadge('dot', 'badge-dot')}
          />
          <ActionButton
            action="badge-clear"
            label="Clear badge"
            perform={() => applyBadge(null, 'badge-clear')}
          />
        </div>
        <Facts
          testId="plugin-demo-badge-state"
          rows={[['Current badge', badge === null ? <Chip>cleared</Chip> : <code>{String(badge)}</code>]]}
        />
      </Card>

      <Card
        title="Auxiliary page"
        hint="ui.page registers a native route without creating another Sidebar App."
      >
        <a
          className="wd-button"
          data-testid="plugin-demo-open-auxiliary-page"
          href={demo.auxiliaryPath}
        >
          Open auxiliary page
        </a>
        <p><code>{demo.auxiliaryPath}</code></p>
      </Card>

      <Card
        title="Deep link"
        hint="Built from the base path the host supplied and the route on the app handle, never hardcoded. Switching tabs moves the host's URL."
      >
        <p className="wd-deeplink" data-testid="plugin-demo-deep-link">{deepLink}</p>
        <Facts
          rows={[
            ['Registered route', <code>{demo.appPath || '(unknown)'}</code>],
            ['Current section', <code>{props.section}</code>],
            ['Query string', <code>{props.search || '(none)'}</code>],
            ['Layout mode', <span data-testid="plugin-demo-layout-mode">{layout}</span>],
            ['Plugin id', <code>{demo.walnut.pluginId}</code>],
            ['Walnut version', <code>{demo.walnut.walnutVersion}</code>],
            ['Abort signal', <code>{demo.walnut.signal.aborted ? 'aborted' : 'active'}</code>],
          ]}
        />
      </Card>
    </div>
  )
}
