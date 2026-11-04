/**
 * Connecting Notion: three steps the person takes in Notion and here, then the connection's
 * state with what it can see. Notion only lets a workspace's own connection read it, so the
 * simplest way that works for everyone is an internal connection's secret, pasted once.
 */
import { useState } from 'react'
import type { ImportStore, PublicState } from './store'

export const NOTION_INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations'

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function ConnectSteps({ store }: { store: ImportStore }) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function connect() {
    setBusy(true)
    setProblem(null)
    const outcome = await store.call('notion_connect', { token: secret })
    setBusy(false)
    if (outcome.ok) setSecret('')
    else setProblem(outcome.message)
  }

  return (
    <div className="ni-group" data-testid="ni-connect-steps">
      <div className="ni-row">
        <span className="ni-step">1</span>
        <div className="ni-row-copy">
          <span>Make a connection</span>
          <span className="ni-help">Choose <b>New integration</b>, pick your workspace, keep the type <b>Internal</b>, and save.</span>
        </div>
        <div className="ni-row-actions">
          <a className="ni-button" href={NOTION_INTEGRATIONS_URL} target="_blank" rel="noreferrer" data-testid="ni-open-notion">Open Notion</a>
        </div>
      </div>
      <div className="ni-row">
        <span className="ni-step">2</span>
        <div className="ni-row-copy">
          <span>Give it your pages</span>
          <span className="ni-help">On the connection's <b>Access</b> tab, choose the pages to import (their sub-pages come too). You can also open a page in Notion and use <b>•••</b> › <b>Connections</b>.</span>
        </div>
      </div>
      <div className="ni-row">
        <span className="ni-step">3</span>
        <div className="ni-row-copy">
          <span>Paste its secret</span>
          <span className="ni-help">On the <b>Configuration</b> tab, show and copy the <b>Internal Integration Secret</b>. Walnut keeps it in its secret store and only reads from Notion.</span>
          <form
            className="ni-inline-form"
            onSubmit={(event) => { event.preventDefault(); if (secret.trim() && !busy) void connect() }}
          >
            <input
              className="ni-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="ntn_…"
              aria-label="Notion secret"
              value={secret}
              onChange={(event) => { setSecret(event.target.value); setProblem(null) }}
              data-testid="ni-secret"
            />
            <button className="ni-button ni-primary" type="submit" disabled={!secret.trim() || busy} data-testid="ni-connect">
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </form>
          {problem && <span className="ni-help" data-tone="error" role="alert" data-testid="ni-connect-error">{problem}</span>}
        </div>
      </div>
    </div>
  )
}

export function ConnectedRow({ state, store }: { state: PublicState; store: ImportStore }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { notion } = state
  const access = notion.access
  const running = state.job?.phase === 'discovering' || state.job?.phase === 'importing'

  const [confirming, setConfirming] = useState(false)

  async function run(op: string) {
    setBusy(true)
    setProblem(null)
    const outcome = await store.call(op)
    setBusy(false)
    if (!outcome.ok) setProblem(outcome.message)
  }

  const sees = access ? `${plural(access.pages, 'page')}${access.databases ? ` and ${plural(access.databases, 'database')}` : ''}` : ''
  let detail: string
  const quiet = notion.quietFor ? ` Notion has not answered for ${notion.quietFor} s; Walnut keeps trying.` : ''
  // A look again keeps the last count on screen, saying it is looking.
  if (notion.checking && access) detail = `It can see ${sees}. Looking again for pages shared since…${quiet}`
  else if (notion.checking) detail = `Looking at what it can see…${quiet}`
  // A failed check says so first; the last good count is only what it saw before.
  else if (notion.error) detail = `The check did not finish: ${notion.error}${access ? ` Last time it could see ${sees}.` : ''}`
  else if (access) detail = `It can see ${sees}.${checkedLine(access.checkedAt)}`
  else detail = 'Checking what it can see…'

  return (
    <div className="ni-group" data-testid="ni-connected">
      <div className="ni-row">
        <span className="ni-dot" data-tone={notion.error ? 'error' : 'ok'} aria-hidden="true" />
        <div className="ni-row-copy">
          <span data-testid="ni-workspace">Connected to {notion.workspace}</span>
          <span className="ni-help" data-tone={notion.error ? 'error' : undefined} data-testid="ni-access">{detail}</span>
          {problem && <span className="ni-help" data-tone="error" role="alert">{problem}</span>}
        </div>
        {!confirming && (
          <div className="ni-row-actions">
            <button className="ni-button" disabled={busy || notion.checking} onClick={() => void run('notion_check')} data-testid="ni-check">Check again</button>
            <button className="ni-button" disabled={busy || running} onClick={() => setConfirming(true)} data-testid="ni-disconnect">Disconnect</button>
          </div>
        )}
      </div>
      {confirming && (
        <div className="ni-row" data-testid="ni-disconnect-confirm">
          <div className="ni-row-copy">
            <span>Disconnect from {notion.workspace}?</span>
            <span className="ni-help">Walnut forgets the secret. The notes you imported stay in your notes; connect again later to bring in changes.</span>
          </div>
          <div className="ni-row-actions">
            <button className="ni-button" disabled={busy} onClick={() => setConfirming(false)} data-testid="ni-disconnect-cancel">Cancel</button>
            <button className="ni-button ni-danger" disabled={busy || running} onClick={() => { setConfirming(false); void run('notion_disconnect') }} data-testid="ni-disconnect-yes">Disconnect</button>
          </div>
        </div>
      )}
      {access && access.pages + access.databases === 0 && !notion.checking && (
        <div className="ni-row" data-testid="ni-no-access">
          <div className="ni-row-copy">
            <span>No pages shared yet</span>
            <span className="ni-help" data-tone="warn">
              In Notion, open the connection's <b>Access</b> tab and choose the pages to import (or on a page: <b>•••</b> › <b>Connections</b>). Then press Check again.
            </span>
          </div>
          <div className="ni-row-actions">
            <a className="ni-button" href={NOTION_INTEGRATIONS_URL} target="_blank" rel="noreferrer">Open Notion</a>
          </div>
        </div>
      )}
    </div>
  )
}

/** When the last look was, once it is an hour old: pages shared since show only after Check again. */
function checkedLine(at: string): string {
  const hours = (Date.now() - Date.parse(at)) / 3_600_000
  if (!(hours >= 1)) return ''
  return hours < 24 ? ` Checked ${Math.floor(hours)} h ago.` : ` Checked on ${new Date(at).toLocaleDateString()}.`
}
