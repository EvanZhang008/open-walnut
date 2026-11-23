/**
 * Small pieces every Apps page view draws for a registered App: its glyph (a plugin's own
 * icon, inside the plugin's error boundary) and its badge, drawn like the Sidebar's so an
 * App off the Sidebar still shows it here; and the one card grid every section uses.
 */
import type { HTMLAttributes } from 'react'
import { PuzzleIcon } from '@/apps/icons'
import type { RegisteredApp } from '@/apps/registry'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'

/**
 * The grid of store cards, the same in every section (built-ins, each source, Get more). Cards read
 * left to right, top to bottom, and the cards of one row share its height, so their footers
 * (status, Sidebar, Open) line up across the row. A long description is clamped to a few lines on
 * the card and read whole in place on hover or on the detail page (2026-11-22, the UI audit: packed
 * cards of their own heights left ragged columns, a short card under a long one started the next
 * row's cards out of order, and Open no longer lined up beside Open).
 */
export function AppsGrid({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={className ? `apps-grid ${className}` : 'apps-grid'} {...rest} />
}

/**
 * The one "Show <name> on the sidebar" switch every Apps page view draws: a built-in part on
 * its card and its page, a plugin App on its card and its plugin's page.
 */
/**
 * The one "is it on my sidebar" switch. `labelled`: a card's footer, where the status beside it
 * speaks of something else (a plugin's On), names it "Sidebar" in words, or it reads as a second,
 * unnamed on/off of the same thing (UI audit, 2026-11-22).
 */
export function SidebarSwitch({ name, shown, onChange, testId, labelled = false }: { name: string; shown: boolean; onChange: (next: boolean) => void; testId: string; labelled?: boolean }) {
  return (
    <ToggleSwitch
      checked={shown}
      onChange={onChange}
      aria-label={`Show ${name} on the sidebar`}
      title={labelled ? `Show ${name} on the sidebar` : undefined}
      label={labelled ? 'Sidebar' : undefined}
      data-testid={testId}
    />
  )
}

export function AppBadge({ app }: { app: RegisteredApp }) {
  const badge = app.badge
  if (badge === 'dot') return <span className="notification-badge-dot apps-card-badge" data-testid={`apps-app-badge-${app.key}`} />
  if (typeof badge === 'number' && badge > 0) {
    return <span className="badge badge-count badge-alert apps-card-badge" data-testid={`apps-app-badge-${app.key}`}>{badge > 99 ? '99+' : badge}</span>
  }
  if (badge && typeof badge === 'object') {
    return <span className="badge badge-count apps-card-badge" data-testid={`apps-app-badge-${app.key}`}>{badge.text}</span>
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
