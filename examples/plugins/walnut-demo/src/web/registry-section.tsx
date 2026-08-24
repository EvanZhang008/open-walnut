import { useEffect, useState } from 'react'
import { Card, Chip, Facts, ServerAction } from './ui-kit'
import type { DemoContext, DemoStats, RunOutcome } from './types'

export function RegistrySection(props: { demo: DemoContext }) {
  const { demo } = props
  const [stats, setStats] = useState<DemoStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const outcome = await demo.fetchStats()
    apply(outcome)
  }

  const apply = (outcome: RunOutcome) => {
    if (outcome.ok && outcome.receipt && typeof outcome.receipt === 'object') {
      setStats(outcome.receipt as DemoStats)
      setError(null)
      return
    }
    setError(outcome.error ?? 'The receipts endpoint returned an error')
  }

  useEffect(() => {
    let cancelled = false
    void demo.fetchStats().then((outcome) => { if (!cancelled) apply(outcome) })
    return () => { cancelled = true }
  }, [demo])

  const registrations = stats?.registrations ?? []
  const timers = stats?.timers ?? {}

  return (
    <div className="wd-stack">
      <Card
        title="Registered contributions"
        hint="Each row is a live registration. All of them are owner-scoped and vanish when the plugin is disabled."
      >
        <div className="wd-row">
          <button
            type="button"
            className="wd-button"
            data-testid="plugin-demo-action-registry-refresh"
            onClick={() => { void load() }}
          >
            Refresh inventory
          </button>
          {error ? <Chip tone="bad">{error}</Chip> : <Chip tone="ok">{registrations.length} registrations</Chip>}
        </div>
        <div className="wd-table-wrap">
          <table className="wd-table" data-testid="plugin-demo-registrations">
            <thead>
              <tr><th>Category</th><th>Name</th><th>Note</th></tr>
            </thead>
            <tbody>
              {registrations.length === 0 && (
                <tr><td colSpan={3} className="wd-muted">Nothing loaded yet.</td></tr>
              )}
              {registrations.map((row) => (
                <tr key={`${row.category}-${row.name}`}>
                  <td><code>{row.category}</code></td>
                  <td>{row.name}</td>
                  <td className="wd-muted">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Self tests"
        hint="Each button runs the registered contribution locally, so you can see its behaviour without waiting for the host to call it."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="tool-handler-probe" label="Probe tool handler" tone="primary" />
          <ServerAction demo={demo} action="cron-handler-probe" label="Probe cron handler" />
          <ServerAction demo={demo} action="provider-adapter-probe" label="Probe provider adapter" />
          <ServerAction demo={demo} action="sync-adapter-probe" label="Probe sync adapter contract" />
          <ServerAction demo={demo} action="registry-list" label="List registrations" />
        </div>
      </Card>

      <Card
        title="Server state"
        hint="Counters, timer state and the one task id the demo owns. No paths, no secret values."
      >
        <Facts
          testId="plugin-demo-server-state"
          rows={[
            ['Capabilities', (stats?.capabilities ?? []).length ? (stats?.capabilities ?? []).join(', ') : '(none)'],
            ['Actions', String((stats?.actions ?? []).length)],
            ['Demo project', stats?.demoProject ?? '(none)'],
            ['Demo task id', stats?.demoTaskId ?? '(none)'],
            ['Secret keys', (stats?.secretKeys ?? []).join(', ') || '(none)'],
            ['Stored files', (stats?.storage?.relativeNames ?? []).join(', ') || '(none)'],
            ['Audit rows', String(stats?.storage?.receiptRows ?? 0)],
            ['Interval running', String(timers.intervalRunning ?? false)],
            ['Interval ticks', String(timers.intervalTicks ?? 0)],
            ['Timeout fires', String(timers.timeoutFires ?? 0)],
            ['Config changes observed', String(stats?.counters?.configChanges ?? 0)],
          ]}
        />
      </Card>
    </div>
  )
}
