/**
 * Voice conversation in a session's composer seat (the experimental
 * `voice_conversation` flag): one big button, what is happening now in words,
 * what was heard and what is being said, Replay, and the keyboard to go back.
 * The full answer stays in the transcript above; only its short spoken part is
 * read aloud.
 */

import type { VoiceConversation } from '../../hooks/useVoiceConversation';
import type { VoicePhase } from '../../voice/conversation-machine';
import '@/styles/voice-conversation.css';

const STATUS: Record<VoicePhase, { title: string; hint: string; button: string }> = {
  listening: { title: 'Listening', hint: 'Pause to send', button: 'Send now' },
  transcribing: { title: 'Sending', hint: 'Turning speech into text', button: 'Sending' },
  waiting: { title: 'Working on it', hint: 'Tap to add more', button: 'Say more' },
  speaking: { title: 'Speaking', hint: 'Talk or tap to interrupt', button: 'Interrupt' },
  paused: { title: 'Paused', hint: 'Tap to talk', button: 'Talk' },
};

function OrbIcon({ phase }: { phase: VoicePhase }) {
  if (phase === 'transcribing' || phase === 'waiting') {
    return (
      <svg className="voice-orb-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="10" opacity="0.3" />
        <path d="M12 2a10 10 0 1 1 -10 10" strokeLinecap="round" />
      </svg>
    );
  }
  if (phase === 'speaking') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      </svg>
    );
  }
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
    </svg>
  );
}

export function VoiceTalkButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  // The mic's twin beside it in the composer: an input-box tool, drawn by .mic-btn, not the button family.
  return (
    <button
      type="button"
      className="mic-btn voice-talk-entry"
      onClick={onClick}
      disabled={disabled}
      title="Talk: a pause sends, the answer is read aloud"
      aria-label="Start a voice conversation"
      data-testid="voice-talk-entry"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      </svg>
    </button>
  );
}

/** `onStopRun` stops the session's turn (the composer's ■); shown whenever the turn runs (`running`), whatever the voice does. */
export function VoiceConversationBar({ voice, onStopRun, running }: { voice: VoiceConversation; onStopRun?: () => void; running?: boolean }) {
  const state = voice.state;
  const phase: VoicePhase = state?.phase ?? 'paused';
  const status = STATUS[phase];
  const ring = phase === 'listening' || phase === 'speaking' ? Math.min(1, voice.level) : 0;
  const engineLabel = voice.engine === 'elevenlabs' ? 'Voice: ElevenLabs' : voice.engine === 'device' ? 'Voice: built-in' : '';
  return (
    <div className={`voice-bar is-${phase}`} data-testid="voice-bar" data-phase={phase} role="group" aria-label="Voice conversation">
      <div className="voice-bar-inner">
      <button
        type="button"
        className="voice-orb"
        onClick={voice.tap}
        disabled={!state || phase === 'transcribing'}
        aria-label={status.button}
        data-testid="voice-orb"
        style={{ '--voice-level': ring.toFixed(3) } as React.CSSProperties}
      >
        <OrbIcon phase={phase} />
      </button>
      <div className="voice-bar-title" data-testid="voice-status">
        {state ? status.title : 'Opening the microphone'}
        <span className="voice-bar-hint" data-testid="voice-hint">{state ? (phase === 'listening' && state.heard ? 'Hearing you, pause to send' : status.hint) : ''}</span>
      </div>
      <div className="voice-bar-tools">
        {engineLabel && <span className="voice-bar-engine" data-testid="voice-engine">{engineLabel}</span>}
        {(running || phase === 'waiting') && onStopRun && (
          <button type="button" className="btn btn-sm" onClick={() => { voice.stoppedRun(); onStopRun(); }} data-testid="voice-stop-run" title="Stop the agent's turn">
            Stop
          </button>
        )}
        {/* Shown only when there is an answer to read again, so it never sits there looking clickable. */}
        {state?.lastSpoken && phase !== 'speaking' && phase !== 'transcribing' && !(phase === 'listening' && state.heard) && (
          <button type="button" className="btn btn-sm" onClick={voice.replay} data-testid="voice-replay" title="Read the last answer again">
            Replay
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={voice.stop} data-testid="voice-close" title="Back to the keyboard">
          Keyboard
        </button>
      </div>
      <div className="voice-bar-text" aria-live="polite">
        {state?.lastHeard && (
          <div className="voice-bar-line" data-testid="voice-heard"><span className="voice-bar-who">You</span>{state.lastHeard}</div>
        )}
        {state?.lastSpoken && (phase === 'speaking' || phase === 'listening' || phase === 'paused') && (
          <div className="voice-bar-line" data-testid="voice-spoken"><span className="voice-bar-who">Walnut</span>{state.lastSpoken}</div>
        )}
        {(state?.error || voice.micWarning || voice.engineNote) && (
          <div className="voice-bar-error" role="status" data-testid="voice-error">{state?.error ?? voice.micWarning ?? voice.engineNote}</div>
        )}
      </div>
      </div>
    </div>
  );
}
