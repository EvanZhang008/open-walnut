import { useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { SettingsSection } from '../SettingsSection'
import { PluginBoundary } from '@/components/common/PluginBoundary'
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

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

const ICONS = {
  open: <Svg><line x1="7" y1="17" x2="17" y2="7" /><polyline points="8 7 17 7 17 16" /></Svg>,
  toSidebar: <Svg><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></Svg>,
  toSettings: <Svg><line x1="21" y1="7" x2="14" y2="7" /><line x1="10" y1="7" x2="3" y2="7" /><line x1="21" y1="17" x2="12" y2="17" /><line x1="8" y1="17" x2="3" y2="17" /><circle cx="12" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Svg>,
  pin: <Svg><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></Svg>,
  unpin: <Svg><line x1="12" y1="17" x2="12" y2="22" /><path d="M9 6H8a2 2 0 0 1 0-4h8a2 2 0 0 1 0 4h-1v4.76c0 .27.05.53.16.78" /><path d="M7.24 12.4A2 2 0 0 0 5 15.24V17h11" /><line x1="3" y1="3" x2="21" y2="21" /></Svg>,
  hide: <Svg><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" /><line x1="2" y1="2" x2="22" y2="22" /></Svg>,
  show: <Svg><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>,
  up: <Svg><polyline points="18 15 12 9 6 15" /></Svg>,
  down: <Svg><polyline points="6 9 12 15 18 9" /></Svg>,
}

function IconButton({ label, icon, onClick, disabled, testId }: {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      className="app-icon-btn"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {icon}
    </button>
  )
}

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
    <SettingsSection
      id="apps"
      title="Apps"
      description="Pick what lives in your sidebar: reorder, unpin, or hide any app. A plugin app can also keep its row here in Settings instead."
      actions={(
        <button type="button" className="btn btn-secondary" onClick={resetAppPreferences}>
          Restore defaults
        </button>
      )}
    >
      <div className="app-manager-list">
        {apps.all.map((app, index) => {
          const state = app.lockVisibility ? 'pinned' : disposition(app.key)
          const placement = effectiveAppPlacement(app, preferences)
          const movable = supportsPlacementOverride(app)
          const Icon = app.icon
          return (
            <article
              key={app.key}
              className="app-manager-row"
              data-testid={`app-manager-row-${app.key}`}
              data-app-disposition={state}
              data-app-placement={placement}
            >
              <span className="app-manager-icon" aria-hidden="true">
                {/* [...title][0], not slice(0,1): slice splits a surrogate pair, and a
                    fallback letter is exactly where an emoji-titled plugin lands. */}
                {Icon ? (
                  // Third-party code renders here; a throwing icon must cost one
                  // letter, not the whole Apps section (same wrap as the Sidebar).
                  app.kind === 'native' && app.pluginId ? (
                    <PluginBoundary
                      pluginId={app.pluginId}
                      pluginName={app.pluginName ?? app.title}
                      resetKey={app.generation}
                      compact
                      fallback={<>{[...app.title][0]?.toUpperCase()}</>}
                    >
                      <Icon size={15} />
                    </PluginBoundary>
                  ) : <Icon size={15} />
                ) : app.iconUrl
                  ? <img src={app.iconUrl} alt="" />
                  : [...app.title][0]?.toUpperCase()}
              </span>
              <div className="app-manager-copy">
                <span className="app-manager-title">{app.title}</span>
                {app.kind !== 'core' && (
                  <span className="app-manager-chip">{app.kind === 'native' ? 'Plugin' : 'Webview'}</span>
                )}
                {/* Where its row lives is part of what this app IS, and without it a
                    settings-placed app reads as missing from the sidebar. */}
                {placement === 'settings' && <span className="app-manager-chip">In Settings</span>}
                {state === 'hidden' && <span className="app-manager-chip">Hidden</span>}
                <code className="app-manager-path">{app.path}</code>
              </div>
              <div className="app-manager-actions">
                <IconButton label="Open" icon={ICONS.open} onClick={() => navigate(app.path)} />
                {/* The app's declared placement is a default, not a verdict: only the
                    person using the sidebar knows whether this belongs in it. Core
                    screens and legacy webviews are excluded by
                    `supportsPlacementOverride`, so the control appears exactly where
                    it can be honoured. */}
                {movable && (
                  <IconButton
                    label={placement === 'settings' ? `Move ${app.title} to the sidebar` : `Move ${app.title} to Settings`}
                    icon={placement === 'settings' ? ICONS.toSidebar : ICONS.toSettings}
                    onClick={() => updateAppPlacement(app.key, placement === 'settings' ? 'sidebar' : 'settings')}
                    testId={`app-manager-placement-${app.key}`}
                  />
                )}
                {/* Pinning is about the SIDEBAR, so a settings-placed app gets no
                    pin control: the button would report a state nothing reads. */}
                {placement !== 'settings' && !app.lockVisibility && state === 'pinned' && (
                  <IconButton
                    label={`Unpin ${app.title}`}
                    icon={ICONS.unpin}
                    onClick={() => updateAppDisposition(app.key, 'unpinned')}
                  />
                )}
                {placement !== 'settings' && !app.lockVisibility && state === 'unpinned' && (
                  <IconButton
                    label={`Pin ${app.title}`}
                    icon={ICONS.pin}
                    onClick={() => updateAppDisposition(app.key, 'pinned')}
                  />
                )}
                {!app.lockVisibility && state === 'hidden' && (
                  <IconButton
                    label={`Show ${app.title}`}
                    icon={ICONS.show}
                    onClick={() => updateAppDisposition(app.key, 'unpinned')}
                  />
                )}
                {!app.lockVisibility && state !== 'hidden' && (
                  <IconButton
                    label={`Hide ${app.title}`}
                    icon={ICONS.hide}
                    onClick={() => updateAppDisposition(app.key, 'hidden')}
                  />
                )}
                <IconButton
                  label={`Move ${app.title} up`}
                  icon={ICONS.up}
                  disabled={index === 0}
                  onClick={() => moveAppPreference(apps.all, app.key, 'up')}
                />
                <IconButton
                  label={`Move ${app.title} down`}
                  icon={ICONS.down}
                  disabled={index === apps.all.length - 1}
                  onClick={() => moveAppPreference(apps.all, app.key, 'down')}
                />
              </div>
            </article>
          )
        })}
      </div>
      <p className="app-manager-footer text-sm text-muted">
        Want one of your own here?{' '}
        <button type="button" className="link-button" onClick={() => navigate('/plugins/new')}>
          Build a plugin app →
        </button>
      </p>
    </SettingsSection>
  )
}
