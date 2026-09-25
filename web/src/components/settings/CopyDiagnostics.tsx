/**
 * "Copy diagnostics": puts the redacted `open-walnut doctor` text on the
 * clipboard (GET /api/diagnostics?format=text, redacted server-side), so a
 * support thread gets build, claude, node, PATH and hosts in one paste.
 * Two looks, one behaviour: a muted inline link on the Settings build line, and
 * a regular Settings button in the Remote Hosts header (hosts section only).
 *
 * The first click fetches, then copies: collection takes seconds, and by then a
 * browser without the async clipboard (plain-HTTP LAN, Firefox) has expired the
 * click, so its execCommand fallback fails. That attempt keeps the text: the
 * next click copies it synchronously inside its own gesture, and the text is
 * shown in a read-only box to select by hand either way.
 */
import { useEffect, useRef, useState } from 'react'
import { apiGetText } from '@/api/client'
import { copyTextDeferred, copyTextRobust } from '@/utils/clipboard'
import { log } from '@/utils/log'
import { SettingsButton } from './inputs/SettingsButton'
import { diagnosticsQuery, type DiagnosticsSection } from './diagnostics-copy'

type CopyState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'copied' } | { kind: 'failed'; message: string }

export interface DiagnosticsCopy {
  state: CopyState
  copy: () => void
  /** The fetched text after a failed copy, for the manual-copy box. */
  fallbackText: string | null
}

const COPIED_MS = 2_000
/** The server bounds every probe; this only guards a wedged request. */
const FETCH_TIMEOUT_MS = 30_000
const REFUSED = 'the browser refused clipboard access'

export function useCopyDiagnostics(section: DiagnosticsSection): DiagnosticsCopy {
  const [state, setState] = useState<CopyState>({ kind: 'idle' })
  const [fallbackText, setFallbackText] = useState<string | null>(null)
  const cached = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busy = useRef(false)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const succeed = (text: string) => {
    busy.current = false
    cached.current = null
    setFallbackText(null)
    log.info('settings', 'diagnostics copied', { section, bytes: text.length })
    setState({ kind: 'copied' })
    timer.current = setTimeout(() => setState({ kind: 'idle' }), COPIED_MS)
  }
  const fail = (message: string, text: string | null) => {
    busy.current = false
    if (text !== null) {
      cached.current = text
      setFallbackText(text)
    }
    log.warn('settings', 'diagnostics copy failed', { section, error: message, haveText: text !== null })
    setState({ kind: 'failed', message })
  }

  const copy = () => {
    if (busy.current) return
    busy.current = true
    if (timer.current) clearTimeout(timer.current)
    setState({ kind: 'busy' })
    const kept = cached.current
    if (kept !== null) {
      // The last attempt fetched but could not copy: copy now, inside this click.
      void copyTextRobust(kept).then((r) => (r === 'failed' ? fail(REFUSED, kept) : succeed(kept)))
      return
    }
    let fetched: string | null = null
    // Started synchronously inside the click: Safari and the Mac app only honour
    // a clipboard write whose promise was minted within the gesture.
    const text = apiGetText('/api/diagnostics', diagnosticsQuery(section), { timeoutMs: FETCH_TIMEOUT_MS })
    text.then((t) => { fetched = t }, () => { /* reported below */ })
    copyTextDeferred(text)
      .then((result) => (result === 'failed' ? fail(REFUSED, fetched) : text.then(succeed)))
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err), fetched))
  }
  return { state, copy, fallbackText }
}

function failureText(message: string): string {
  return `Copy failed: ${message}`
}

/** Muted inline link for the build line; stays on that one row. */
export function CopyDiagnosticsLink({ copy }: { copy: DiagnosticsCopy }) {
  const { state } = copy
  const label = state.kind === 'busy' ? 'Collecting...' : state.kind === 'copied' ? 'Copied' : 'Copy diagnostics'
  return (
    <>
      <button
        type="button"
        // WebKit only tabs to buttons with an explicit tabindex (N20).
        tabIndex={0}
        className="settings-build-line-action"
        onClick={copy.copy}
        disabled={state.kind === 'busy'}
        aria-live="polite"
        data-testid="settings-copy-diagnostics"
        title="Copy build, Claude Code, Node, PATH and host details, with usernames masked"
      >
        {label}
      </button>
      {state.kind === 'failed' && (
        <span className="settings-build-line-error" role="alert" title={state.message}>{failureText(state.message)}</span>
      )}
    </>
  )
}

/** Header button for the Remote Hosts pane: the hosts section only. */
export function CopyHostDiagnosticsButton({ copy }: { copy: DiagnosticsCopy }) {
  const { state } = copy
  const label = state.kind === 'copied' ? 'Copied' : 'Copy host diagnostics'
  return (
    <>
      {state.kind === 'failed' && (
        <span className="settings-copy-diagnostics-error" role="alert" title={state.message}>{failureText(state.message)}</span>
      )}
      <SettingsButton
        onClick={copy.copy}
        busy={state.kind === 'busy'}
        busyLabel="Collecting..."
        reserve={['Copy host diagnostics', 'Copied']}
        data-testid="remote-hosts-copy-diagnostics"
        title="Copy each host's connection, daemon and preflight details, with usernames and hostnames masked"
      >
        {label}
      </SettingsButton>
    </>
  )
}

/** After a failed copy: the same text, read-only, to select and copy by hand. */
export function DiagnosticsFallback({ copy, testId }: { copy: DiagnosticsCopy; testId: string }) {
  if (copy.fallbackText === null) return null
  return (
    <div className="settings-diagnostics-fallback" data-testid={testId}>
      <p className="settings-diagnostics-fallback-note">The clipboard is not available here. Select the text below and copy it, or click the button again.</p>
      <textarea
        className="settings-input"
        readOnly
        value={copy.fallbackText}
        rows={10}
        spellCheck={false}
        aria-label="Diagnostics text"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  )
}
