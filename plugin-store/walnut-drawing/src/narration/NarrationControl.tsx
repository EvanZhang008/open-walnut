/**
 * The walkthrough's two pieces of screen (the drawing_narration experiment), as the design drew
 * them: one pill in the drawing's top bar (Record, then a red timer with Stop, then Saving and
 * Saved) that keeps one size and one place in every state, so nothing in the bar ever moves; and
 * a dark caption strip over the bottom of the canvas with the newest sentence heard, so the words
 * never squeeze the bar. Both show only what the recorder (recorder.ts) says; every step lives there.
 */
import { useEffect, useState } from 'react'
import { elapsed, type NarrationRecorder, type RecorderState } from './recorder'

export const NARRATION_CSS = `
.walnut-narration-pill {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto;
  box-sizing: border-box; width: 128px; height: 28px; margin-right: 4px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 14px; background: transparent; color: var(--fg);
  font: inherit; font-size: 12px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums;
  cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.walnut-narration-pill:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--bg-hover); border-color: var(--border-strong); }
.walnut-narration-pill:disabled { opacity: .45; cursor: default; }
.walnut-narration-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.walnut-narration-pill[data-phase="recording"], .walnut-narration-pill[data-phase="starting"] {
  border-color: var(--error, #cf222e); color: var(--error, #cf222e);
  background: color-mix(in srgb, var(--error, #cf222e) 9%, transparent);
}
.walnut-narration-pill[data-phase="recording"]:hover { background: color-mix(in srgb, var(--error, #cf222e) 15%, transparent); }
.walnut-narration-pill[data-phase="saving"], .walnut-narration-pill[data-phase="saved"] { color: var(--fg-secondary); cursor: default; }
.walnut-narration-pill[data-phase="error"] { border-color: var(--error, #cf222e); color: var(--error, #cf222e); }
.walnut-narration-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error, #cf222e); flex: 0 0 auto; }
.walnut-narration-pill[data-phase="recording"] .walnut-narration-dot { animation: walnut-narration-pulse 1.4s ease-in-out infinite; }
.walnut-narration-pill[data-phase="saving"] .walnut-narration-dot, .walnut-narration-pill[data-phase="saved"] .walnut-narration-dot { background: var(--fg-muted); }
@keyframes walnut-narration-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .walnut-narration-pill[data-phase="recording"] .walnut-narration-dot { animation: none; } }
.walnut-narration-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.walnut-narration-strip {
  position: absolute; z-index: 4; left: 50%; bottom: 72px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; box-sizing: border-box; max-width: min(640px, calc(100% - 32px));
  min-height: 34px; padding: 7px 16px; border-radius: 17px;
  background: rgb(31 35 40 / 88%); color: #fff; box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  font-size: 13.5px; line-height: 20px; pointer-events: none;
}
/* Above the drawing's own note in that slot (Make a diagram), never on it. */
.drawing-diagram-note ~ .walnut-narration-strip { bottom: 116px; }
.walnut-narration-strip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.walnut-narration-strip-muted { color: rgb(255 255 255 / 65%); }
.walnut-narration-strip[data-tone="error"] { background: rgb(130 20 24 / 92%); }
.walnut-narration-strip button {
  pointer-events: auto; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; margin-right: -8px; padding: 0; border: 0; border-radius: 11px;
  background: transparent; color: inherit; font: inherit; font-size: 15px; cursor: pointer;
}
.walnut-narration-strip button:hover { background: rgb(255 255 255 / 16%); }
`

const MicIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: '0 0 auto' }}>
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)

export function useRecorderState(recorder: NarrationRecorder): RecorderState {
  const [state, setState] = useState(recorder.current)
  useEffect(() => {
    setState(recorder.current)
    return recorder.subscribe(setState)
  }, [recorder])
  return state
}

function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** The pill in the top bar: one button, one size, one place, whatever the recorder does. */
export function NarrationControl({ recorder, path }: { recorder: NarrationRecorder; path: string | null }) {
  const state = useRecorderState(recorder)
  const now = useClock(state.phase === 'recording')
  const { phase } = state
  const common = { type: 'button' as const, className: 'walnut-narration-pill', 'data-phase': phase }
  if (phase === 'recording' || phase === 'starting') {
    return (
      <button {...common} onClick={() => void recorder.stop()} aria-label="Stop recording the walkthrough" title="Stop and save the walkthrough">
        <span className="walnut-narration-dot" aria-hidden="true" />
        <span>{phase === 'starting' ? 'Starting…' : `${elapsed(now - (state.startedAt ?? now))} Stop`}</span>
      </button>
    )
  }
  if (phase === 'saving' || phase === 'saved') {
    return (
      <>
        <button {...common} aria-disabled="true" tabIndex={-1} title={phase === 'saving' ? 'Saving the walkthrough beside the drawing' : 'The walkthrough is saved beside the drawing'}>
          <span className="walnut-narration-dot" aria-hidden="true" />
          <span>{phase === 'saving' ? 'Saving…' : 'Saved'}</span>
        </button>
        {/* Announced outside the button (a button's words are not a live region); it takes no room. */}
        <span className="walnut-narration-sr" role="status">{phase === 'saving' ? 'Saving the walkthrough' : 'Walkthrough saved'}</span>
      </>
    )
  }
  if (phase === 'error' && state.canRetry) {
    return (
      <button {...common} onClick={() => void recorder.retrySave()} title="Save the walkthrough again">
        <span>Try again</span>
      </button>
    )
  }
  return (
    <button {...common} disabled={!path} onClick={() => { if (path) void recorder.start(path) }}
      title={path ? 'Record a walkthrough: talk while you draw, and the assistant learns which part you meant' : 'Save the drawing first'}>
      <span className="walnut-narration-dot" aria-hidden="true" />
      <span>Record</span>
    </button>
  )
}

/** The caption strip over the canvas: the newest sentence while recording, or what went wrong. */
export function NarrationStrip({ recorder }: { recorder: NarrationRecorder }) {
  const state = useRecorderState(recorder)
  const { phase } = state
  if (phase === 'error') {
    return (
      <div className="walnut-narration-strip" data-tone="error" role="alert">
        <span className="walnut-narration-strip-text" title={state.error}>{state.error}</span>
        <button type="button" aria-label="Dismiss" title={state.canRetry ? 'Let this walkthrough go' : 'Dismiss'} onClick={() => recorder.dismiss()}>{'\u00d7'}</button>
      </div>
    )
  }
  if (phase !== 'recording' && phase !== 'saving') return null
  const words = state.caption
  return (
    <div className="walnut-narration-strip walnut-narration-caption" role="status" aria-live="polite">
      <MicIcon />
      <span className="walnut-narration-strip-text" title={words || undefined}>
        {words ? `“${words}”` : <span className="walnut-narration-strip-muted">{phase === 'saving' ? 'Saving the walkthrough…' : 'Listening… talk while you draw'}</span>}
        {words && state.pending > 0 && <span className="walnut-narration-strip-muted"> …</span>}
      </span>
    </div>
  )
}
