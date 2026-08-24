import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import {
  effectiveAppPlacement,
  supportsPlacementOverride,
  type AppDisposition,
} from '@/apps/preferences'
import {
  getAppPreferences,
  moveAppPreference,
  resetAppPreferences,
  subscribeAppPreferences,
  updateAppDisposition,
  updateAppPlacement,
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
          <p className="text-sm text-muted">
            Core and Plugin Apps share one ordered launcher. A Plugin App's row can live in the
            sidebar or down here in Settings → Manage; Restore defaults puts every app back where
            it asked to be.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={resetAppPreferences}>
          Restore defaults
        </button>
      </div>
      <div className="app-manager-list">
        {apps.all.map((app, index) => {
          const state = app.lockVisibility ? 'pinned' : disposition(app.key)
          const placement = effectiveAppPlacement(app, preferences)
          const movable = supportsPlacementOverride(app)
          return (
            <article
              key={app.key}
              className="app-manager-row"
              data-testid={`app-manager-row-${app.key}`}
              data-app-disposition={state}
              data-app-placement={placement}
            >
              <div className="app-manager-copy">
                <strong>{app.title}</strong>
                {/* Where its row lives is part of what this app IS, and without it a
                    settings-placed app reads as missing from the sidebar. */}
                <span>
                  {app.kind === 'core' ? 'Core App' : app.kind === 'native' ? 'Native Plugin App' : 'Webview App'}
                  {placement === 'settings' ? ' · row in Settings → Manage' : ''}
                </span>
                <code>{app.path}</code>
              </div>
              <div className="app-manager-actions">
                <button type="button" className="btn btn-secondary" onClick={() => navigate(app.path)}>
                  Open
                </button>
                {/* The app's declared placement is a default, not a verdict: only the
                    person using the sidebar knows whether this belongs in it. Core
                    screens and legacy webviews are excluded by
                    `supportsPlacementOverride`, so the control appears exactly where
                    it can be honoured. */}
                {movable && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppPlacement(app.key, placement === 'settings' ? 'sidebar' : 'settings')}
                    aria-label={placement === 'settings' ? `Move ${app.title} to the sidebar` : `Move ${app.title} to Settings`}
                    data-testid={`app-manager-placement-${app.key}`}
                  >
                    {placement === 'settings' ? 'Move to Sidebar' : 'Move to Settings'}
                  </button>
                )}
                {/* Pinning is about the SIDEBAR, so a settings-placed app gets no
                    pin control: the button would report a state nothing reads. */}
                {placement !== 'settings' && !app.lockVisibility && state === 'pinned' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => updateAppDisposition(app.key, 'unpinned')}
                    aria-label={`Unpin ${app.title}`}
                  >
                    Unpin
                  </button>
                )}
                {placement !== 'settings' && !app.lockVisibility && state === 'unpinned' && (
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
