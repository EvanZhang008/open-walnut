import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DemoContext, RunOutcome } from './types'

const RECEIPT_CHAR_LIMIT = 4_000

export function formatJson(value: unknown): string {
  if (value === undefined) return '(no body)'
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > RECEIPT_CHAR_LIMIT ? `${text.slice(0, RECEIPT_CHAR_LIMIT)}\n… truncated` : text
}

export function Card(props: { title: string; hint?: string; testId?: string; children: ReactNode }) {
  return (
    <section className="wd-card" data-testid={props.testId}>
      <header className="wd-card-head">
        <h3>{props.title}</h3>
        {props.hint && <p>{props.hint}</p>}
      </header>
      <div className="wd-card-body">{props.children}</div>
    </section>
  )
}

export function Chip(props: { tone?: 'ok' | 'bad' | 'info' | 'warn'; children: ReactNode }) {
  return <span className={`wd-chip wd-chip-${props.tone ?? 'info'}`}>{props.children}</span>
}

export function Facts(props: { rows: Array<[string, ReactNode]>; testId?: string }) {
  return (
    <dl className="wd-facts" data-testid={props.testId}>
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Receipt(props: { action: string; outcome: RunOutcome }) {
  const { action, outcome } = props
  return (
    <div
      className="wd-receipt"
      data-testid={`plugin-demo-receipt-${action}`}
      data-ok={outcome.ok ? 'true' : 'false'}
    >
      <div className="wd-receipt-head">
        <Chip tone={outcome.ok ? 'ok' : 'bad'}>{outcome.ok ? 'success' : 'failed'}</Chip>
        <code>{action}</code>
        <span className="wd-muted">{outcome.ms} ms</span>
      </div>
      <pre>{formatJson(outcome.error ? { error: outcome.error } : outcome.receipt)}</pre>
    </div>
  )
}

export interface ActionButtonProps {
  /** Also the test id suffix, so renaming it breaks the E2E selectors. */
  action: string
  label: string
  hint?: string
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  perform(): Promise<RunOutcome> | RunOutcome
  onOutcome?(outcome: RunOutcome): void
}

export function ActionButton(props: ActionButtonProps) {
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)

  const click = async () => {
    setPending(true)
    const started = performance.now()
    try {
      const result = await props.perform()
      setOutcome(result)
      props.onOutcome?.(result)
    } catch (error) {
      const failure: RunOutcome = {
        ok: false,
        action: props.action,
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      }
      setOutcome(failure)
      props.onOutcome?.(failure)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="wd-action">
      <div className="wd-action-head">
        <button
          type="button"
          className={`wd-button wd-button-${props.tone ?? 'default'}`}
          data-testid={`plugin-demo-action-${props.action}`}
          disabled={pending || props.disabled}
          onClick={() => { void click() }}
        >
          {pending ? `${props.label}…` : props.label}
        </button>
        {props.hint && <span className="wd-muted">{props.hint}</span>}
      </div>
      {outcome && <Receipt action={props.action} outcome={outcome} />}
    </div>
  )
}

export function ServerAction(props: {
  demo: DemoContext
  action: string
  label: string
  hint?: string
  input?: Record<string, unknown>
  tone?: 'default' | 'primary' | 'danger'
  onOutcome?(outcome: RunOutcome): void
}) {
  return (
    <ActionButton
      action={props.action}
      label={props.label}
      hint={props.hint}
      tone={props.tone}
      onOutcome={props.onOutcome}
      perform={() => props.demo.run(props.action, props.input)}
    />
  )
}
