import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { PluginAppPage } from '@/pages/PluginAppPage'
import { PluginBounds } from '@/plugins/PluginBounds'
import { useWebPluginRuntime } from '@/plugins/hooks'
import { useAppCatalog } from './hooks'
import { appNavigateTarget, type RegisteredApp } from './registry'

/**
 * A built-in app's page, drawn the same in the console (App.tsx, one route per core app) and in
 * an app's own window (popout/PopoutAppView.tsx). Its navigation is the router's it is drawn in.
 */
export function CoreAppView({ app }: { app: RegisteredApp }) {
  const location = useLocation()
  const navigate = useNavigate()
  const CoreApp = app.component
  if (!CoreApp) return null
  return (
    <CoreApp
      basePath={app.path}
      subpath=""
      search={location.search}
      navigate={(target, options) => navigate(target, options)}
    />
  )
}

export function AppHostPage() {
  const params = useParams<{ appId: string; '*': string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const runtime = useWebPluginRuntime()
  const app = params.appId ? catalog.findByRouteId(params.appId) : undefined

  if (!app) {
    // Words beside the spinner: a first visit can wait a while for the Apps to load.
    if (!runtime.ready || runtime.loading || catalog.loadingWebviews) {
      return (
        <div className="plugin-app-page" data-testid="plugin-app-page">
          <div className="plugin-app-loading">
            <div className="plugin-app-spinner" />
            <span>Loading apps…</span>
          </div>
        </div>
      )
    }
    // A bookmark to a disabled or uninstalled App must SAY so. Bouncing to Home
    // silently is the dead-end answer this repo keeps banning: the user is left
    // wondering whether they mistyped, whether the App broke, or whether Walnut
    // did. PluginAppPage owns that card already, for the legacy Webview case.
    return <PluginAppPage />
  }
  if (app.kind === 'webview') return <PluginAppPage />
  if (app.kind !== 'native' || !app.component || !app.pluginId) return <Navigate to="/" replace />

  const AppComponent = app.component
  const subpath = params['*'] ? `/${params['*']}` : ''
  return (
    <PluginBoundary
      pluginId={app.pluginId}
      pluginName={app.pluginName ?? app.title}
      resetKey={app.generation}
    >
      <PluginBounds
        className="plugin-native-app"
        data-testid="app-host-native"
        data-app-key={app.key}
        data-plugin-id={app.pluginId}
      >
        <AppComponent
          basePath={app.path}
          subpath={subpath}
          search={location.search}
          navigate={(target, options) => navigate(appNavigateTarget(app.path, target), options)}
        />
      </PluginBounds>
    </PluginBoundary>
  )
}
