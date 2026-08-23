import { useEffect, useMemo, useState } from 'react'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { usePluginUi, useWebPluginRuntime } from '@/plugins/hooks'
import {
  cyclePluginDashboardSpan,
  loadPluginDashboardLayout,
  movePluginDashboardCell,
  reconcilePluginDashboardLayout,
  removePluginDashboardCell,
  savePluginDashboardLayout,
  type PluginDashboardLayout,
} from './pluginDashboardLayout'

export function PluginDashboardPage() {
  const pluginUi = usePluginUi()
  const runtime = useWebPluginRuntime()
  const [layout, setLayout] = useState<PluginDashboardLayout>(() => (
    loadPluginDashboardLayout(localStorage)
  ))
  const panels = useMemo(
    () => new Map(pluginUi.panels.map((panel) => [panel.key, panel])),
    [pluginUi.panels],
  )

  useEffect(() => {
    setLayout((current) => reconcilePluginDashboardLayout(
      current,
      pluginUi.panels.map((panel) => ({
        key: panel.key,
        defaultSpan: panel.value.defaultSpan,
      })),
    ))
  }, [pluginUi.panels])

  useEffect(() => {
    savePluginDashboardLayout(layout, localStorage)
  }, [layout])

  const missingReason = (key: string): string => {
    const pluginId = key.slice(0, key.indexOf(':'))
    const tombstone = runtime.tombstones.find((entry) => entry.id === pluginId)
    if (tombstone) return `Plugin is unavailable (${tombstone.reason})`
    const lifecycle = runtime.plugins.find((entry) => entry.id === pluginId)
    if (lifecycle && lifecycle.state !== 'active') return `Plugin is ${lifecycle.state}`
    const failure = runtime.errors.find((entry) => entry.id === pluginId)
    if (failure) return failure.error
    return runtime.loading ? 'Plugin is loading' : 'Panel is not registered'
  }

  return (
    <main className="plugin-dashboard-page" data-testid="plugin-dashboard">
      <header className="plugin-dashboard-heading">
        <div>
          <h1>Dashboard</h1>
          <p>Panels from your installed Plugins.</p>
        </div>
      </header>

      {layout.cells.length === 0 ? (
        <div className="plugin-dashboard-empty">
          <strong>No Plugin panels yet</strong>
          <span>Install a Plugin that contributes a panel to build this dashboard.</span>
        </div>
      ) : (
        <div className="plugin-dashboard-grid">
          {layout.cells.map((cell, index) => {
            const panel = panels.get(cell.key)
            if (!panel) {
              return (
                <article
                  className="plugin-dashboard-cell plugin-dashboard-cell-missing"
                  data-panel-key={cell.key}
                  data-testid={`plugin-panel-missing-${cell.key}`}
                  key={cell.key}
                  style={{ gridColumn: `span ${cell.span}` }}
                >
                  <PanelHeader
                    title={cell.key}
                    index={index}
                    count={layout.cells.length}
                    span={cell.span}
                    onMove={(delta) => setLayout((current) => movePluginDashboardCell(current, cell.key, delta))}
                    onResize={() => setLayout((current) => cyclePluginDashboardSpan(current, cell.key))}
                    onRemove={() => setLayout((current) => removePluginDashboardCell(current, cell.key))}
                  />
                  <div className="plugin-dashboard-missing-body">
                    <strong>Panel unavailable</strong>
                    <span>{missingReason(cell.key)}</span>
                  </div>
                </article>
              )
            }

            const Panel = panel.value.component
            return (
              <article
                className="plugin-dashboard-cell"
                data-panel-key={cell.key}
                data-testid={`plugin-panel-${cell.key}`}
                key={cell.key}
                style={{ gridColumn: `span ${cell.span}` }}
              >
                <PanelHeader
                  title={panel.value.title}
                  subtitle={panel.pluginName}
                  index={index}
                  count={layout.cells.length}
                  span={cell.span}
                  onMove={(delta) => setLayout((current) => movePluginDashboardCell(current, cell.key, delta))}
                  onResize={() => setLayout((current) => cyclePluginDashboardSpan(current, cell.key))}
                />
                <div className="plugin-dashboard-panel-body">
                  <PluginBoundary
                    pluginId={panel.pluginId}
                    pluginName={panel.pluginName}
                    resetKey={panel.generation}
                  >
                    <Panel panelKey={cell.key} />
                  </PluginBoundary>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </main>
  )
}

function PanelHeader({
  title,
  subtitle,
  index,
  count,
  span,
  onMove,
  onResize,
  onRemove,
}: {
  title: string
  subtitle?: string
  index: number
  count: number
  span: number
  onMove(delta: -1 | 1): void
  onResize(): void
  onRemove?(): void
}) {
  return (
    <header className="plugin-dashboard-cell-header">
      <div className="plugin-dashboard-cell-title">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="plugin-dashboard-cell-actions">
        <button
          type="button"
          aria-label={`Move ${title} left`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={`Move ${title} right`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          →
        </button>
        <button
          type="button"
          aria-label={`Change ${title} width`}
          title="Change width"
          onClick={onResize}
        >
          {span}/3
        </button>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${title}`}
            title="Remove unavailable panel"
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
    </header>
  )
}
