import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { PluginAppPage } from '@/pages/PluginAppPage'
import { useWebPluginRuntime } from '@/plugins/hooks'
import { useAppCatalog } from './hooks'

export function AppHostPage() {
  const params = useParams<{ appId: string; '*': string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const runtime = useWebPluginRuntime()
  const app = params.appId ? catalog.findByRouteId(params.appId) : undefined

  if (!app) {
    if (!runtime.ready || runtime.loading || catalog.loadingWebviews) return <LoadingSpinner />
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
      <div
        className="plugin-native-app"
        data-testid="app-host-native"
        data-app-key={app.key}
        data-plugin-id={app.pluginId}
      >
        <AppComponent
          basePath={app.path}
          subpath={subpath}
          search={location.search}
          navigate={(target, options) => {
            const path = target.startsWith('/')
              ? target
              : `${app.path}/${target.replace(/^\.\//, '').replace(/^\//, '')}`
            navigate(path, options)
          }}
        />
      </div>
    </PluginBoundary>
  )
}
