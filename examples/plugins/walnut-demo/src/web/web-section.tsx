import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ActionButton, Card, Chip, Facts, formatJson, ServerAction } from './ui-kit'
import type { DemoContext, DemoStats, RunOutcome } from './types'

interface OpSummary { name: string; title: string; readonly: boolean }

export function WebSection(props: { demo: DemoContext }) {
  const { demo } = props
  const events = useSyncExternalStore(demo.events.subscribe, demo.events.snapshot)
  const [ops, setOps] = useState<OpSummary[] | null>(null)
  const [opsError, setOpsError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<{ ok: boolean; ms: number } | null>(null)
  const [stats, setStats] = useState<DemoStats | null>(null)

  useEffect(() => {
    let cancelled = false
    void demo.walnut.ops.list()
      .then((list) => { if (!cancelled) setOps(list) })
      .catch((error: unknown) => {
        if (!cancelled) setOpsError(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [demo])

  const readStats = (outcome: RunOutcome) => {
    if (outcome.ok && outcome.receipt && typeof outcome.receipt === 'object') {
      setStats(outcome.receipt as DemoStats)
    }
  }

  const callStatusOp = async (): Promise<RunOutcome> => {
    const started = performance.now()
    try {
      const result = await demo.walnut.ops.call<Record<string, unknown>>('walnut_status')
      const value = demo.walnut.ops.unwrap(result)
      return {
        ok: true,
        action: 'web-ops-call',
        ms: Math.round(performance.now() - started),
        receipt: {
          op: 'walnut_status',
          called: true,
          unwrapped: true,
          resultKeys: Object.keys(value).sort(),
          valuesReported: false,
        },
      }
    } catch (error) {
      return {
        ok: false,
        action: 'web-ops-call',
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // Reading `unsafe` makes the host log a warning; only each handle's type is reported, never a value reached through it.
  const unsafeHandle = demo.walnut.unsafe
  const unsafeTypes: Array<[string, string]> = [
    ['react', typeof unsafeHandle.react],
    ['host', typeof unsafeHandle.host],
    ['dom', typeof unsafeHandle.dom],
  ]

  return (
    <div className="wd-grid">
      <Card
        title="WS method"
        hint="Every trigger in this app goes through one owner-scoped WS method, walnut-demo:run."
      >
        <ActionButton
          action="ws-ping"
          label="Ping the server plugin"
          tone="primary"
          perform={async () => {
            const outcome = await demo.run('ping')
            setWsStatus({ ok: outcome.ok, ms: outcome.ms })
            return outcome
          }}
        />
        <Facts
          testId="plugin-demo-ws-status"
          rows={[[
            'WS status',
            wsStatus
              ? <Chip tone={wsStatus.ok ? 'ok' : 'bad'}>{wsStatus.ok ? `round trip ${wsStatus.ms} ms` : 'no answer'}</Chip>
              : <Chip tone="warn">not probed yet</Chip>,
          ]]}
        />
      </Card>

      <Card
        title="HTTP route"
        hint="A GET against the plugin's own route. The host's fetch adds authentication for same-origin calls."
      >
        <ActionButton
          action="refresh-status"
          label="Fetch receipts endpoint"
          hint={demo.statsPath}
          onOutcome={readStats}
          perform={() => demo.fetchStats()}
        />
        {stats && (
          <Facts
            testId="plugin-demo-http-stats"
            rows={[
              ['Runs', String(stats.counters?.runs ?? 0)],
              ['Failures', String(stats.counters?.failures ?? 0)],
              ['Stats requests', String(stats.counters?.statsRequests ?? 0)],
              ['Events seen', String(stats.counters?.events ?? 0)],
              ['Secret keys', (stats.secretKeys ?? []).join(', ') || '(none)'],
            ]}
          />
        )}
      </Card>

      <Card
        title="Events"
        hint="One prefix subscription receives both server events and browser-local events emitted through the Web API."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="event-echo" label="Emit from server" />
          <ActionButton
            action="web-event-emit"
            label="Emit from browser"
            perform={() => {
              const nonce = `web-${Date.now().toString(36)}`
              demo.walnut.events.emit('browser-echo', { nonce })
              return {
                ok: true,
                action: 'web-event-emit',
                ms: 0,
                receipt: { emitted: `plugin:${demo.walnut.pluginId}:browser-echo`, nonce },
              }
            }}
          />
        </div>
        <ul className="wd-events" data-testid="plugin-demo-event-log">
          {events.length === 0 && <li className="wd-muted">No plugin event yet.</li>}
          {events.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <code>{entry.name}</code>
              <span className="wd-muted">{entry.at}</span>
              <pre>{formatJson(entry.data)}</pre>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Ops catalogue, call, and unwrap"
        hint="The browser lists host ops, then calls and unwraps the read-only walnut_status op. The receipt reports keys, never values."
      >
        <ActionButton
          action="web-ops-call"
          label="Call and unwrap walnut_status"
          tone="primary"
          perform={callStatusOp}
        />
        <Facts
          testId="plugin-demo-ops"
          rows={[
            ['Ops visible', ops ? String(ops.length) : opsError ? 'failed' : 'loading…'],
            ['Read-only', ops ? String(ops.filter((op) => op.readonly).length) : '(none)'],
            ['First few', ops ? ops.slice(0, 4).map((op) => op.name).join(', ') : opsError ?? '(none)'],
          ]}
        />
      </Card>

      <Card
        title="Escape hatch"
        hint="walnut.unsafe exists for the cases the stable API has not covered yet. Types only, never contents."
      >
        <Facts
          testId="plugin-demo-unsafe"
          rows={unsafeTypes.map(([key, type]) => [key, <code>{type}</code>] as [string, ReactNode])}
        />
      </Card>
    </div>
  )
}
