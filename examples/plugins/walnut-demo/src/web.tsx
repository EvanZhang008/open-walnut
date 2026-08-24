import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { DemoApp } from './web/app'
import { DemoEventLog } from './web/event-log'
import { DemoSettings } from './web/settings'
import { DEMO_CSS } from './web/styles'
import type { DemoBadge, DemoContext, RunOutcome } from './web/types'

const AUXILIARY_PATH = '/plugin-demo-about'

export async function activate(walnut: WalnutWebApi) {
  const events = new DemoEventLog()
  const statsPath = `/api/plugins/${walnut.pluginId}/stats`

  const elapsed = (started: number): number => Math.round(performance.now() - started)

  const failure = (action: string, started: number, error: unknown): RunOutcome => ({
    ok: false,
    action,
    ms: elapsed(started),
    error: error instanceof Error ? error.message : String(error),
  })

  const demo: DemoContext = {
    walnut,
    views: walnut.ui.views,
    statsPath,
    events,
    // Filled in from the app handle below: the host owns the route, so the plugin must never guess it.
    appPath: '',
    auxiliaryPath: AUXILIARY_PATH,

    async run(action, input = {}) {
      const started = performance.now()
      try {
        const answer = await walnut.ws.call<{ ok?: boolean; receipt?: unknown }>('run', { action, input })
        const receipt = answer?.receipt ?? answer
        return { ok: answer?.ok !== false, action, ms: elapsed(started), receipt }
      } catch (error) {
        return failure(action, started, error)
      }
    },

    async fetchStats() {
      const started = performance.now()
      try {
        const response = await walnut.http.fetch(statsPath)
        const body = await response.json<unknown>()
        return {
          ok: response.ok,
          action: 'refresh-status',
          ms: elapsed(started),
          receipt: body,
          ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        }
      } catch (error) {
        return failure('refresh-status', started, error)
      }
    },

    // Host endpoints, not plugin ones: the host's fetch attaches same-origin credentials, so the plugin never handles a token.
    async lifecycle(operation) {
      const started = performance.now()
      try {
        const response = await walnut.http.fetch(
          `/api/plugin-runtime/${walnut.pluginId}/${operation}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        )
        const body = await response.json<unknown>()
        return {
          ok: response.ok,
          action: operation,
          ms: elapsed(started),
          receipt: body,
          ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        }
      } catch (error) {
        return failure(operation, started, error)
      }
    },

    // Replaced right after registration, once the app handle exists.
    setBadge: () => undefined,
  }

  walnut.events.on(`plugin:${walnut.pluginId}:`, (event) => {
    events.push({ name: event.name, at: new Date(event.timestamp).toISOString(), data: event.data })
  })

  function DemoIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 15V9l4 4 4-4v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  function DemoAppRoot(props: AppProps) {
    return (
      <DemoApp
        demo={demo}
        basePath={props.basePath}
        subpath={props.subpath}
        search={props.search}
        navigate={props.navigate}
      />
    )
  }

  function DemoSettingsPanel() {
    return <DemoSettings demo={demo} />
  }

  function DemoAuxiliaryPage() {
    return (
      <div className="wd-root" data-testid="plugin-demo-auxiliary-page">
        <span className="wd-kicker">Native auxiliary page</span>
        <h1>Plugin Demo auxiliary route</h1>
        <p>This page came from <code>ui.page</code>. It has no separate Sidebar entry.</p>
        <a className="wd-button" href={demo.appPath || '/'}>Back to Plugin Demo</a>
      </div>
    )
  }

  const app = walnut.ui.app({
    id: 'main',
    title: 'Plugin Demo',
    icon: DemoIcon,
    component: DemoAppRoot,
    badge: null,
    order: 50,
    fullBleed: true,
  })

  demo.appPath = app.path
  demo.setBadge = (value: DemoBadge) => { app.setBadge(value) }

  walnut.ui.page({
    id: 'about',
    path: AUXILIARY_PATH,
    title: 'Plugin Demo auxiliary page',
    component: DemoAuxiliaryPage,
  })

  walnut.ui.settings({
    id: 'demo',
    label: 'Plugin Demo',
    component: DemoSettingsPanel,
  })

  walnut.ui.injectCss(DEMO_CSS)
  walnut.log.info('Plugin Demo web activated', { appPath: app.path, auxiliaryPath: AUXILIARY_PATH })
}
