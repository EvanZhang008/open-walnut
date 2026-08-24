import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import type { AppDisposition } from '@/apps/preferences'
import {
  getAppPreferences,
  moveAppPreference,
  resetAppPreferences,
  subscribeAppPreferences,
  updateAppDisposition,
} from '@/apps/store'

export function AppsSection() {
  const navigate = useNavigate()
  const apps = useAppCatalog()
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferences,
    getAppPreferences,
  )
  const hidden = new Set(preferences.hidden)
  const unpinned = new Set(preferences.unpinned)
  const disposition = (key: string): AppDisposition => (
    hidden.has(key) ? 'hidden' : unpinned.has(key) ? 'unpinned' : 'pinned'
  )

  return (
    <section id="apps" className="card settings-section">
      <div className="settings-section-header-row">
        <div>
          <h3 className="settings-section-title">Apps</h3>
          <p className="text-sm text-muted">Core and Plugin Apps share one ordered launcher.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={resetAppPreferences}>
          Restore defaults
        </button>
      </div>
      <div className="app-manager-list">
        {apps.all.map((app, index) => {
          const state = app.lockVisibility ? 'pinned' : disposition(app.key)
          return (
            <article
              key={app.key}
              className="app-manager-row"
              data-testid={`app-manager-row-${app.key}`}
              data-app-disposition={state}
            >
              <div className="app-manager-copy">
                <strong>{app.title}</strong>
                <span>{app.kind === 'core' ? 'Core App' : app.kind === 'native' ? 'Native Plugin App' : 'Webview App'}</span>
                <code>{app.path}</code>
              </div>
              <div className="app-manager-actions">
                <button type="button" className="btn btn-secondary" onClick={() => navigate(app.path)}>
                  Open
                </button>
                {!app.lockVisibility && state === 'pinned' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppDisposition(app.key, 'unpinned')}
                    aria-label={`Unpin ${app.title}`}
                  >
                    Unpin
                  </button>
                )}
                {!app.lockVisibility && state === 'unpinned' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppDisposition(app.key, 'pinned')}
                    aria-label={`Pin ${app.title}`}
                  >
                    Pin
                  </button>
                )}
                {!app.lockVisibility && state === 'hidden' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppDisposition(app.key, 'unpinned')}
                    aria-label={`Show ${app.title}`}
                  >
                    Show
                  </button>
                )}
                {!app.lockVisibility && state !== 'hidden' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppDisposition(app.key, 'hidden')}
                    aria-label={`Hide ${app.title}`}
                  >
                    Hide
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={index === 0}
                  onClick={() => moveAppPreference(apps.all, app.key, 'up')}
                  aria-label={`Move ${app.title} up`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={index === apps.all.length - 1}
                  onClick={() => moveAppPreference(apps.all, app.key, 'down')}
                  aria-label={`Move ${app.title} down`}
                >
                  Down
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
