/**
 * Small pieces every Apps page view draws for a registered App: its glyph (a plugin's own
 * icon, inside the plugin's error boundary) and its badge, drawn like the Sidebar's so an
 * App off the Sidebar still shows it here.
 */
import { PuzzleIcon } from '@/apps/icons'
import type { RegisteredApp } from '@/apps/registry'
import { PluginBoundary } from '@/components/common/PluginBoundary'

export function AppBadge({ app }: { app: RegisteredApp }) {
  const badge = app.badge
  if (badge === 'dot') return <span className="notification-badge-dot apps-card-badge" data-testid={`apps-app-badge-${app.key}`} />
  if (typeof badge === 'number' && badge > 0) {
    return <span className="notification-badge-count apps-card-badge" data-testid={`apps-app-badge-${app.key}`}>{badge > 99 ? '99+' : badge}</span>
  }
  if (badge && typeof badge === 'object') {
    return <span className="notification-badge-count notification-badge-muted apps-card-badge" data-testid={`apps-app-badge-${app.key}`}>{badge.text}</span>
  }
  return null
}

export function AppGlyph({ app, size = 19 }: { app: RegisteredApp; size?: number }) {
  const Icon = app.icon
  if (Icon && app.kind === 'native' && app.pluginId) {
    return (
      <PluginBoundary pluginId={app.pluginId} pluginName={app.pluginName ?? app.title} resetKey={app.generation} compact fallback={<PuzzleIcon size={size} />}>
        <Icon size={size} />
      </PluginBoundary>
    )
  }
  if (Icon) return <Icon size={size} />
  if (app.iconUrl) return <img src={app.iconUrl} alt="" className="apps-card-img" />
  return <PuzzleIcon size={size} />
}
