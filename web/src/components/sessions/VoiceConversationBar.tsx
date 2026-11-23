/**
 * Voice conversation's keys in a session's composer (the experimental `voice_conversation`
 * flag): Talk to start, then the state key, Replay and the way back to the keyboard. Only the
 * short spoken part of an answer is read aloud; the whole of it stays in the transcript.
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

/**
 * Voice conversation in the composer (2026-11-23, the user: the words he says show in the input
 * box, and the composer shows only a mic mark while it waits for his pause): the box keeps its
 * place, the live words go in it (ChatInput `voiceText`), and these keys stand where Talk was.
 * The round key is the conversation's state and its one control (a tap pauses, listens again, or
 * cuts the answer short); Replay reads the last answer again; the x key goes back to the keyboard.
 * Stopping the turn is the composer's own stop key. The full answer streams into the transcript.
 */
export function VoiceKeys({ voice }: { voice: VoiceConversation }) {
  const state = voice.state;
  const phase: VoicePhase = state?.phase ?? 'paused';
  const status = STATUS[phase];
  const ring = phase === 'listening' || phase === 'speaking' ? Math.min(1, voice.level) : 0;
  const engineLabel = voice.engine === 'elevenlabs' ? 'Voice: ElevenLabs' : voice.engine === 'device' ? 'Voice: built-in' : '';
  const title = state ? status.title : 'Opening the microphone';
  const hint = state ? (phase === 'listening' && state.heard ? 'Hearing you, pause to send' : status.hint) : '';
  const canReplay = !!state?.lastSpoken && phase !== 'speaking' && phase !== 'transcribing' && !(phase === 'listening' && state.heard);
  return (
    <span className={`voice-keys is-${phase}`} data-testid="voice-bar" data-phase={phase} data-engine={voice.engine ?? ''} role="group" aria-label="Voice conversation">
      <span className="voice-keys-status" data-testid="voice-status" aria-live="polite" title={hint}>{title}</span>
      {canReplay && (
        <button type="button" className="btn btn-icon" onClick={voice.replay} data-testid="voice-replay" title="Read the last answer again" aria-label="Read the last answer again">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="voice-key"
        onClick={voice.tap}
        disabled={!state || phase === 'transcribing'}
        aria-label={status.button}
        title={[title, hint, engineLabel].filter(Boolean).join(' \u00b7 ')}
        data-testid="voice-orb"
        style={{ '--voice-level': ring.toFixed(3) } as React.CSSProperties}
      >
        <OrbIcon phase={phase} />
      </button>
      <button type="button" className="btn btn-icon" onClick={voice.stop} data-testid="voice-close" title="Back to the keyboard" aria-label="Back to the keyboard">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </span>
  );
}

/** A line over the composer when voice mode has something to say about itself (an error, a silent mic, the voice it fell back to). */
export function voiceNotice(voice: VoiceConversation): string | null {
  return voice.state?.error ?? voice.micWarning ?? voice.engineNote ?? null;
}
