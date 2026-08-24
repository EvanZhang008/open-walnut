import { useState } from 'react'
import { ActionButton, Card, ServerAction } from './ui-kit'
import type { DemoContext } from './types'

export function ServerSection(props: { demo: DemoContext }) {
  const { demo } = props
  const [probeUrl, setProbeUrl] = useState('https://example.com/')

  return (
    <div className="wd-grid">
      <Card
        title="Tasks"
        hint="The demo creates ONE task in its own project and only ever touches that id. Clean up removes it."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="task-create" label="Create demo task" tone="primary" />
          <ServerAction demo={demo} action="task-get" label="Get owned task" />
          <ServerAction demo={demo} action="task-list" label="List demo project" />
          <ServerAction demo={demo} action="task-query" label="Query demo project" />
          <ServerAction demo={demo} action="task-children" label="Read children" />
        </div>
        <div className="wd-row">
          <ServerAction demo={demo} action="task-update" label="Update priority" />
          <ServerAction demo={demo} action="task-note" label="Append note" />
          <ServerAction demo={demo} action="task-log" label="Append log" />
          <ServerAction demo={demo} action="task-complete" label="Complete task" />
          <ServerAction demo={demo} action="task-cleanup" label="Delete demo task" tone="danger" />
        </div>
      </Card>

      <Card
        title="Config"
        hint="Read, patch, and observe the plugin's own config block. The owner-scoped onChange listener emits a receipt event."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="config-read" label="Read plugin config" />
          <ServerAction demo={demo} action="config-patch" label="Toggle demoFlag" />
        </div>
      </Card>

      <Card
        title="Storage"
        hint="A private data directory: JSON, text and a SQLite database with versioned migrations."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="storage-roundtrip" label="JSON and text round trip" tone="primary" />
          <ServerAction demo={demo} action="sqlite-roundtrip" label="SQLite read back" />
          <ServerAction demo={demo} action="storage-list" label="List stored files" />
          <ServerAction demo={demo} action="storage-delete" label="Write and delete sample" />
        </div>
      </Card>

      <Card
        title="Secrets"
        hint="Stored under a fixed dummy value. The API can return key names and existence; this demo never returns a value."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="secret-roundtrip" label="Store and inspect key" tone="primary" />
          <ServerAction demo={demo} action="secret-delete" label="Delete key" tone="danger" />
        </div>
      </Card>

      <Card
        title="Timers"
        hint="Owner-scoped timers: the host cancels both of these when the plugin reloads or is disabled."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="timer-timeout" label="Schedule 1.5s timeout" />
          <ServerAction demo={demo} action="timer-interval-start" label="Start 5s interval" />
          <ServerAction demo={demo} action="timer-interval-stop" label="Stop interval" />
        </div>
      </Card>

      <Card
        title="Notifications"
        hint="Dedup keys are namespaced by the host, so a plugin cannot collide with core notifications."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="notify" label="Send notification" tone="primary" />
          <ServerAction demo={demo} action="notify-error" label="Raise error notification" />
          <ServerAction demo={demo} action="notify-recover" label="Recover" />
        </div>
      </Card>

      <Card
        title="Outbound HTTP"
        hint="User-triggered and restricted to the fixed reserved URL https://example.com/. Every other target is rejected."
      >
        <div className="wd-row">
          <input
            className="wd-input"
            aria-label="URL to probe"
            placeholder="https://example.com/"
            data-testid="plugin-demo-probe-url"
            value={probeUrl}
            onChange={(event) => setProbeUrl(event.target.value)}
          />
        </div>
        <ActionButton
          action="http-probe"
          label={probeUrl.trim() ? 'Probe allowlisted URL' : 'Probe (skips without a URL)'}
          perform={() => demo.run('http-probe', { url: probeUrl.trim() })}
        />
      </Card>

      <Card
        title="Ops and escape hatch"
        hint="The server lists ops, calls and unwraps the read-only walnut_status op, then inspects only the unsafe handle's shape."
      >
        <div className="wd-row">
          <ServerAction demo={demo} action="ops-catalogue" label="List host ops" />
          <ServerAction demo={demo} action="ops-selftest" label="Call and unwrap status" tone="primary" />
          <ServerAction demo={demo} action="unsafe-inspect" label="Inspect unsafe handle" />
        </div>
      </Card>
    </div>
  )
}
