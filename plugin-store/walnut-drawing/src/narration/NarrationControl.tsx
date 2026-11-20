/**
 * The Record button in the drawing's top bar (the drawing_narration experiment): Record, then a
 * red timer with Stop and the newest sentence heard, then "Saved". It shows only what the
 * recorder (recorder.ts) says; every step lives there.
 */
import { useEffect, useState } from 'react'
import type { NarrationRecorder, RecorderState } from './recorder'

export const NARRATION_CSS = `
.walnut-narration { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 46%; }
.walnut-narration-rec { border-color: var(--error, #ff3b30) !important; color: var(--error, #ff3b30) !important; font-variant-numeric: tabular-nums; }
.walnut-narration-rec:hover { background: color-mix(in srgb, var(--error, #ff3b30) 10%, transparent) !important; }
.walnut-narration-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error, #ff3b30); flex: 0 0 auto; animation: walnut-narration-pulse 1.4s ease-in-out infinite; }
@keyframes walnut-narration-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .walnut-narration-dot { animation: none; } }
.walnut-narration-caption { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--fg-secondary); }
.walnut-narration-note { font-size: 12px; color: var(--fg-muted); white-space: nowrap; }
.walnut-narration-error { font-size: 12px; color: var(--error, #ff3b30); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

const MicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function useRecorderState(recorder: NarrationRecorder): RecorderState {
  const [state, setState] = useState(recorder.current)
  useEffect(() => {
    setState(recorder.current)
    return recorder.subscribe(setState)
  }, [recorder])
  return state
}

export function NarrationControl({ recorder, path }: { recorder: NarrationRecorder; path: string | null }) {
  const state = useRecorderState(recorder)
  const [now, setNow] = useState(() => Date.now())
  const live = state.phase === 'recording' || state.phase === 'starting'
  useEffect(() => {
    if (!live) return undefined
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [live])

  if (live) {
    return (
      <span className="walnut-narration" data-phase={state.phase}>
        <button type="button" className="drawing-quiet-button walnut-narration-rec" onClick={() => void recorder.stop()}
          aria-label="Stop recording the walkthrough" title="Stop and save the walkthrough">
          <span className="walnut-narration-dot" aria-hidden="true" />
          <span>{state.phase === 'starting' ? 'Starting…' : elapsed(now - (state.startedAt ?? now))}</span>
          <span>Stop</span>
        </button>
        {(state.caption || state.pending > 0) && (
          <span className="walnut-narration-caption" role="status" aria-live="polite" title={state.caption}>
            {state.caption ? `“${state.caption}”` : 'Listening…'}{state.pending > 0 && state.caption ? ' …' : ''}
          </span>
        )}
      </span>
    )
  }
  if (state.phase === 'saving') return <span className="walnut-narration-note" role="status">Saving walkthrough…</span>
  if (state.phase === 'saved') return <span className="walnut-narration-note" role="status">Walkthrough saved</span>
  return (
    <span className="walnut-narration" data-phase={state.phase}>
      {state.phase === 'error' && (
        <>
          <span className="walnut-narration-error" role="alert" title={state.error}>{state.error}</span>
          {state.canRetry && <button type="button" className="drawing-quiet-button" onClick={() => void recorder.retrySave()}>Try again</button>}
          <button type="button" className="drawing-icon-button" aria-label="Dismiss" title={state.canRetry ? 'Let this walkthrough go' : 'Dismiss'} onClick={() => recorder.dismiss()}>{'\u00d7'}</button>
        </>
      )}
      {!(state.phase === 'error' && state.canRetry) && (
        <button type="button" className="drawing-quiet-button walnut-narration-start" disabled={!path}
          onClick={() => { if (path) void recorder.start(path) }}
          title={path ? 'Record a walkthrough: talk while you draw, and the assistant learns which part you meant' : 'Save the drawing first'}>
          <MicIcon /><span>Record</span>
        </button>
      )}
    </span>
  )
}
