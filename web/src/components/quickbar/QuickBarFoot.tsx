/**
 * The quick bar's last line: what is happening now on the left (sending, listening, a problem, the
 * modes a keyword opens) and the keys that work right now on the right, each named for what it
 * does in this state (2026-11-20, the user: "done ... it should be stop"). Plus the glyphs the bar
 * draws: a key, the microphone and the live level.
 */
import { MODES, type ModeMatch, type QuickMode } from './quickbar-modes';
import { personLine, type QuickPerson } from './quickbar-people';

export function QuickBarFoot({
  mode, recording, transcribing, micLive, counting, to, note, peopleFailed, onRetryPeople, typedMode, empty, onMode, canCapture,
}: {
  mode: QuickMode;
  recording: boolean;
  transcribing: boolean;
  micLive: boolean;
  counting: boolean;
  to: QuickPerson | null;
  note: string | null;
  peopleFailed: boolean;
  onRetryPeople: () => void;
  typedMode: ModeMatch | null;
  empty: boolean;
  onMode: (mode: QuickMode) => void;
  canCapture: boolean;
}) {
  const who = to?.title ?? 'CEO';
  const live = recording ? (micLive ? 'Listening' : 'Opening the microphone') : transcribing ? 'Finishing the last words' : null;

  let left: React.ReactNode;
  if (counting) left = <span className="qb-foot-send">Sending to {who}…</span>;
  else if (note) left = <span className="qb-foot-note" role="status">{note}</span>;
  else if (live) left = <span className="qb-foot-live"><span className="qb-dot" />{live}</span>;
  else if (peopleFailed && mode === 'send') {
    left = (
      <span className="qb-foot-note qb-foot-trouble" role="status">
        {/* The words shorten, never the button: it stays whole beside them. */}
        <span className="qb-foot-trouble-text" title={`Walnut is restarting or busy, trying again in a few seconds. Sends go to ${who}.`}>
          Walnut is restarting, trying again in a few seconds. Sends go to {who}.
        </span>
        <button type="button" className="qb-foot-retry" onClick={onRetryPeople}>Retry now</button>
      </span>
    );
  } else if (mode === 'send' && typedMode) {
    left = <span className="qb-foot-idle"><kbd className="qb-key">tab</kbd> {typedMode.mode.action}{typedMode.rest ? <> for “{typedMode.rest}”</> : null}</span>;
  } else if (mode === 'send' && empty) {
    left = (
      <span className="qb-modes" aria-label="Other things the bar does">
        {MODES.map((m) => (
          <button key={m.id} type="button" className="btn btn-sm btn-ghost qb-mode-pill" data-mode={m.id} onClick={() => onMode(m.id)} title={`${m.action}: type "${m.keywords[0]}" then Tab`}>
            {m.chip}<kbd className="qb-key">{m.keywords[0]}</kbd>
          </button>
        ))}
      </span>
    );
  } else if (mode === 'ask') left = <span className="qb-foot-idle">A quick answer, no task made</span>;
  else if (mode === 'send') left = <span className="qb-foot-idle">{to ? personLine(to) : ''}</span>;
  else left = <span className="qb-foot-idle" />;

  let keys: React.ReactNode;
  if (counting) keys = <><Key k="esc" />stop <Key k="↵" />send now</>;
  else if (recording) keys = <><Key k="tab" />more <Key k="esc" />stop listening <Key k="↵" />send</>;
  else if (mode === 'tasks' || mode === 'notes') keys = <><Key k="↑↓" />choose <Key k="↵" />open <Key k="esc" />back</>;
  else if (mode === 'ask') keys = <><Key k="↵" />ask <Key k="esc" />back</>;
  else keys = <>{!typedMode && <><Key k="tab" />more </>}<Key k="↵" />send{canCapture && <> <Key k="⇧⌘S" />screenshot</>} <Key k="esc" />close</>;

  return (
    <div className="qb-foot">
      {left}
      <span className="qb-keys">{keys}</span>
    </div>
  );
}

export function Key({ k }: { k: string }) {
  return <kbd className="qb-key">{k}</kbd>;
}

export function MicGlyph({ level }: { level: number }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style={{ transform: `scale(${1 + Math.min(level, 1) * 0.12})` }}>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Waveform({ level }: { level: number }) {
  const weights = [0.4, 0.7, 1, 0.8, 0.55, 0.9, 0.45];
  return (
    <span className="qb-wave" aria-hidden="true">
      {weights.map((w, i) => <span key={i} style={{ height: `${4 + Math.min(1, level * w * 1.4) * 16}px` }} />)}
    </span>
  );
}
