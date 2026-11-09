/**
 * Asked when a script is picked while another still runs in the session's
 * terminal: stop that one (Ctrl-C) and run this one, or keep it running. It
 * watches the running one: when it ends by itself meanwhile, the question is
 * moot and the dialog answers "ended" (the next script then simply runs).
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useScriptResults } from './script-results';

export type StopFirstAnswer = 'stop' | 'keep' | 'ended';

export function StopFirstDialog({ sessionId, running, runId, next, onAnswer }: {
  sessionId: string;
  /** The script still running, and its run. */
  running: string;
  runId: string;
  /** The script asked for. */
  next: string;
  onAnswer: (a: StopFirstAnswer) => void;
}) {
  const results = useScriptResults(sessionId);
  const still = [...results.values()].some((r) => r.runId === runId && r.state === 'running');
  useEffect(() => { if (!still) onAnswer('ended'); }, [still, onAnswer]);
  useModalOverlay(() => onAnswer('keep'));
  const again = running === next;
  return createPortal(
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label={`${running} is still running`} onMouseDown={() => onAnswer('keep')}>
      <div className="app-modal" data-testid="script-stop-first" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{running} is still running</div>
        <div className="app-modal-message">
          {again
            ? `Stop it and run ${next} again from the start? Ctrl-C stops it, as if you pressed it in the terminal.`
            : `Stop ${running} and run ${next}? Ctrl-C stops ${running}, as if you pressed it in the terminal. If it ends by itself first, ${next} runs then.`}
        </div>
        <div className="app-modal-actions">
          <button type="button" className="app-modal-btn" onClick={() => onAnswer('keep')}>Keep {running} running</button>
          <button type="button" className="app-modal-btn primary" autoFocus onClick={() => onAnswer('stop')}>{again ? 'Stop and run again' : `Stop and run ${next}`}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
