/**
 * Raw view of a session (the session menu's "Raw input & output"): every turn's
 * full input exactly as the model received it, Walnut's `<system-reminder>` hints
 * included and nothing hidden, and the model's output exactly as it came back. It
 * is how a person checks which hints a message carried and whether the hint
 * schedule holds; the normal view keeps hiding the hints.
 *
 * Opened through a tiny store (openSessionRawView) and drawn by one host mounted in
 * App, because the menu that opens it closes at once.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { createPortal } from 'react-dom';
import { fetchSessionHistory } from '@/api/sessions';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { log } from '@/utils/log';
import { rawTurnsOf, type RawTurn } from '@/utils/raw-turns';
import '@/styles/session-raw-view.css';
import { ICON_CLOSE } from '../common/Icons';

let openSid: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function openSessionRawView(sessionId: string): void {
  openSid = sessionId;
  notify();
}

function closeSessionRawView(): void {
  openSid = null;
  notify();
}

/** Turns asked for per load; "Earlier turns" asks for more. */
const TURN_STEP = 20;

function Turn({ turn, index }: { turn: RawTurn; index: number }) {
  return (
    <section className="raw-turn" data-testid="raw-turn" data-hinted={turn.hinted ? '1' : '0'}>
      <header className="raw-turn-head">
        <span>Turn {index + 1}</span>
        <time>{new Date(turn.at).toLocaleString()}</time>
        {turn.hintKinds.length > 0 && <span className="raw-turn-hints">hints: {turn.hintKinds.join(', ')}</span>}
      </header>
      <div className="raw-turn-label">Input (as the model received it)</div>
      <pre className="raw-turn-pre" data-testid="raw-turn-input">{turn.input || '(this window starts mid-turn)'}</pre>
      <div className="raw-turn-label">Output</div>
      {turn.output.length === 0 && <EmptyState size="row" title="No output yet" />}
      {turn.output.map((p, i) => (
        <div key={i} className={`raw-part raw-part-${p.kind}`} data-testid="raw-turn-output">
          {p.kind === 'tool' ? (
            <>
              <div className="raw-part-tag">tool call: {p.text}</div>
              <pre className="raw-turn-pre">{p.input}</pre>
              {p.result !== undefined && (
                <>
                  <div className="raw-part-tag">result{p.resultCut ? ' (cut)' : ''}</div>
                  <pre className="raw-turn-pre">{p.result}</pre>
                </>
              )}
            </>
          ) : (
            <>
              {p.kind === 'thinking' && <div className="raw-part-tag">thinking</div>}
              <pre className="raw-turn-pre">{p.text}</pre>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

function RawViewDialog({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState(TURN_STEP);
  const [state, setState] = useState<{ loading: boolean; error?: string; messages: Parameters<typeof rawTurnsOf>[0] }>({ loading: true, messages: [] });

  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fetchSessionHistory(sessionId, { tail: turns * 40, turns, signal: ac.signal })
      .then((res) => setState({ loading: false, messages: res.messages }))
      .catch((err: Error) => {
        if (ac.signal.aborted) return;
        log.warn('raw-view', 'history load failed', { sessionId, error: err.message });
        setState({ loading: false, error: err.message, messages: [] });
      });
    return () => ac.abort();
  }, [sessionId, turns]);

  // Escape, scroll lock and nesting: the shared dialog hook.
  useModalOverlay(closeSessionRawView);

  const rows = useMemo(() => rawTurnsOf(state.messages), [state.messages]);

  return (
    <div className="raw-view-backdrop wn-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeSessionRawView(); }}>
      <div className="raw-view wn-dialog" role="dialog" aria-label="Raw input and output" data-testid="session-raw-view">
        <div className="raw-view-bar wn-dialog-head">
          {/* The title and the session id read as one title (the head's first child takes the room). */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <strong>Raw input &amp; output</strong>
            <span className="raw-view-sid">{sessionId}</span>
          </span>
          <button type="button" className="btn btn-icon raw-view-close wn-dialog-close" onClick={closeSessionRawView} aria-label="Close">{ICON_CLOSE}</button>
        </div>
        <div className="raw-view-body">
          {rows.length >= turns && (
            <button type="button" className="raw-view-more" onClick={() => setTurns((n) => n + TURN_STEP)} disabled={state.loading}>
              Earlier turns
            </button>
          )}
          {state.error && <UnavailableState size="section" title="Could not load the history" detail={state.error} />}
          {state.loading && rows.length === 0 && <LoadingState size="pane" title="Loading the turns…" />}
          {!state.loading && !state.error && rows.length === 0 && <EmptyState size="pane" title="No turns yet" hint="Each turn's raw input and output shows here once the session runs." />}
          {rows.map((t, i) => <Turn key={t.key} turn={t} index={i} />)}
        </div>
      </div>
    </div>
  );
}

export function SessionRawViewHost() {
  const sid = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => openSid,
  );
  if (!sid) return null;
  return createPortal(<RawViewDialog sessionId={sid} />, document.body);
}
