/**
 * Microphone button for speech-to-text input.
 *
 * States: idle (gray) → recording (red pulse) → transcribing (spinner)
 * After transcription, a small ▾ chevron badge appears on the mic button.
 * Clicking it opens a dropdown with: retry models, vocabulary, copy audio path.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { SttDiffModal } from '@/components/common/SttDiffModal';
import { useSttStatus } from '@/hooks/useSttStatus';
import { fetchSttDetection, fetchVocab, addVocabWord, fetchRecordings, retranscribeRecording, MODEL_CATALOG, type GgmlModel, type VoiceRecording } from '@/api/stt';
import { registerVoiceInsertTarget } from '@/utils/voice-status';
import { log } from '@/utils/log';
import { KEEP_SELECTION_ATTR } from '@/utils/selection-guard';

interface MicButtonProps {
  /** Called with transcribed text */
  onTranscribe: (text: string) => void;
  /**
   * Opt in to live drafting: called with the running transcription of what has
   * been said so far, every ~2s while recording. Each call REPLACES the text of
   * the previous one, and the final onTranscribe replaces it too, so the words
   * appear in the caller's text box as the user speaks. Omit for final-only.
   */
  onDraft?: (text: string) => void;
  /**
   * When the user stops mid-sentence the draft is handed to onTranscribe straight
   * away so it is usable, and this is called with the authoritative text a moment
   * later. Apply it only if `provisional` is still sitting there untouched.
   */
  onRefine?: (finalText: string, provisional: string) => void;
  /**
   * Receives a stop-and-throw-away handle for the live recording. Call it when the
   * user acts on the dictated text themselves (sends it), so a transcription
   * landing afterwards cannot duplicate what they just sent.
   */
  controlRef?: React.MutableRefObject<{ discard: () => void } | null>;
  /** ISO 639-1 language hint */
  language?: string;
  /** Disable the button */
  disabled?: boolean;
  /** Button size */
  size?: 'sm' | 'md';
}

// How long the chevron stays after a SUCCESSFUL transcription. After a failure
// (or empty result) the chevron persists until the next recording — it's the
// recovery entry point, hiding it would strand the user.
const RETRY_DISMISS_MS = 10_000;

/**
 * Live mic waveform shown while recording. Five columns whose heights track
 * the input level (0..1) with fixed per-column weights so it reads as a voice
 * meter. A near-flat waveform = the mic isn't picking up sound (the user's cue
 * that something's wrong, before the auto-silence error fires).
 */
function MicWaveform({ level }: { level: number }) {
  const weights = [0.45, 0.75, 1, 0.7, 0.4];
  return (
    <span className="mic-waveform" aria-hidden="true">
      {weights.map((w, i) => {
        // Idle floor so columns are always faintly visible; scale up with level.
        const h = 3 + Math.min(1, level * w) * 15;
        return <span key={i} className="mic-waveform-bar" style={{ height: `${h}px` }} />;
      })}
    </span>
  );
}

export function MicButton({ onTranscribe, onDraft, onRefine, controlRef, language, disabled, size = 'md' }: MicButtonProps) {
  /**
   * Did this recording put any text anywhere? Tracked because the mic now KEEPS the
   * user's selection (see the mousedown note below), and something has to release it
   * when the recording produces nothing. Writing the text is normally what releases
   * it: the write focuses the composer and the browser collapses the selection.
   *
   * These three refs are that bookkeeping, per press:
   *  · `delivered` — a transcript, draft or refinement reached the consumer;
   *  · `armed` — a press started a recording (so a dropdown insert, which delivers
   *    text without a press, never triggers the release);
   *  · `sawLive` — the recorder (or its transcribe step) actually ran, so the release
   *    check cannot fire in the frame between the press and `isRecording` turning
   *    true, which would clear the very selection this whole change exists to keep.
   */
  const delivered = useRef(false);
  const armed = useRef(false);
  const sawLive = useRef(false);
  const sttOptions: Parameters<typeof useSpeechToText>[0] = {
    onTranscribe: (text) => { delivered.current = true; onTranscribe(text); },
    ...(onDraft ? { onDraft: (text: string) => { delivered.current = true; onDraft(text); } } : {}),
    ...(onRefine
      ? { onRefine: (final: string, provisional: string) => { delivered.current = true; onRefine(final, provisional); } }
      : {}),
    ...(language ? { language } : {}),
  };
  const { isSupported, isRecording, isTranscribing, error, toggleRecording, retryWithModel, retryLast, lastDebugPath, hasLastRecording, level, silenceWarning, discardRecording } = useSpeechToText(sttOptions);

  /**
   * A recording that ends without text must give the selection back.
   *
   * Four ordinary ways that happens: microphone permission denied, no sound
   * detected, an empty transcription, a failed POST. In every one of them nothing
   * ever writes into the composer, so nothing collapses the selection — and a
   * selection lingering inside a STREAMING reply keeps that reply's html frozen
   * (`useSelectionFrozen`) and auto-scroll paused, which reads as "the answer stopped
   * mid-sentence" with no visible cause. Before the mic opted out of the instant
   * clear, the press itself ended that; now this does, and only in the case where the
   * user got nothing for it.
   */
  useEffect(() => {
    if (isRecording || isTranscribing) { sawLive.current = true; return; }
    if (!armed.current || !(sawLive.current || error)) return;
    armed.current = false;
    sawLive.current = false;
    if (delivered.current) return;
    log.info('stt', 'recording ended with no text — releasing the selection it was holding');
    window.getSelection()?.removeAllRanges();
  }, [isRecording, isTranscribing, error]);
  // Hand the parent a stable way to abandon a live recording.
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { discard: discardRecording };
    return () => { controlRef.current = null; };
  }, [controlRef, discardRecording]);
  const sttStatus = useSttStatus();
  const navigate = useNavigate();

  // Dropdown state
  const [showChevron, setShowChevron] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<GgmlModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Vocab state
  const [vocabWords, setVocabWords] = useState<string[]>([]);
  const [vocabInput, setVocabInput] = useState('');
  const [vocabStatus, setVocabStatus] = useState<string | null>(null);
  const vocabInputRef = useRef<HTMLInputElement>(null);
  // Voice history (server-side recordings — survives lost responses)
  const [recordings, setRecordings] = useState<VoiceRecording[]>([]);
  const [retranscribingId, setRetranscribingId] = useState<string | null>(null);
  // Expanded history item: shows BOTH engines' full text + latency side by side
  // (the A/B comparison view). The most recent recording auto-expands on open.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Recording open in the full-size diff popup (null = closed)
  const [diffRec, setDiffRec] = useState<VoiceRecording | null>(null);
  // Per-recording "⋯" menu holding the row actions (Diff / Insert / Redo)
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);

  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Error bubble dismissal — re-arm whenever a new error arrives.
  const [errorDismissed, setErrorDismissed] = useState(false);
  useEffect(() => { setErrorDismissed(false); }, [error]);

  // Register this input as the sidebar Voice panel's insert target. Last mount
  // wins (the composer the user is looking at); onTranscribe already knows how
  // to insert at the caret of its own textarea.
  const onTranscribeStable = useRef(onTranscribe);
  onTranscribeStable.current = onTranscribe;
  useEffect(() => {
    registerVoiceInsertTarget((text) => onTranscribeStable.current(text));
  }, []);

  // Show chevron after transcription completes. On success it auto-dismisses;
  // on failure/empty (error set) it STAYS — it's the recovery entry point.
  const wasTranscribing = useRef(false);
  useEffect(() => {
    if (isTranscribing) {
      wasTranscribing.current = true;
    } else if (wasTranscribing.current) {
      wasTranscribing.current = false;
      if (hasLastRecording) {
        setShowChevron(true);
        clearTimeout(dismissTimer.current);
        if (!error) {
          dismissTimer.current = setTimeout(() => {
            setShowChevron(false);
            setDropdownOpen(false);
          }, RETRY_DISMISS_MS);
        }
      }
    }
  }, [isTranscribing, hasLastRecording, error]);

  // Hide on new recording
  useEffect(() => {
    if (isRecording) {
      setShowChevron(false);
      setDropdownOpen(false);
      clearTimeout(dismissTimer.current);
    }
  }, [isRecording]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  // Close the per-row action menu on outside click or when the dropdown closes.
  useEffect(() => {
    if (!dropdownOpen) setActionMenuId(null);
  }, [dropdownOpen]);
  useEffect(() => {
    if (!actionMenuId) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.mic-history-actions')) setActionMenuId(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActionMenuId(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [actionMenuId]);

  const handleChevronClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const opening = !dropdownOpen;
    setDropdownOpen(opening);
    if (!opening) return;

    setVocabStatus(null);
    // Fetch models + vocab in parallel on open
    const promises: Promise<void>[] = [];
    if (downloadedModels.length === 0 && !modelsLoading) {
      setModelsLoading(true);
      promises.push(
        fetchSttDetection()
          .then(det => setDownloadedModels(det.models))
          .catch(err => log.error('stt', `Failed to fetch models: ${err}`))
          .finally(() => setModelsLoading(false))
      );
    }
    promises.push(
      fetchVocab()
        .then(res => setVocabWords(res.words))
        .catch(() => {})
    );
    promises.push(
      fetchRecordings(8)
        .then(res => {
          setRecordings(res.recordings);
          // Auto-expand the most recent recording — the comparison the user
          // opened this panel to see.
          setExpandedId(res.recordings[0]?.id ?? null);
        })
        .catch(() => {})
    );
    await Promise.all(promises);
  }, [dropdownOpen, downloadedModels.length, modelsLoading]);

  // While the dropdown or diff popup is open, poll briefly so the shadow
  // engine's result (which lands a few seconds after the primary) appears
  // without reopening.
  useEffect(() => {
    if (!dropdownOpen && !diffRec) return;
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks > 10) { clearInterval(timer); return; } // ~30s then stop
      fetchRecordings(8).then(res => setRecordings(res.recordings)).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [dropdownOpen, !!diffRec]);

  // Keep an open diff popup in sync with refreshed recordings (its shadow
  // result may arrive while it's on screen).
  useEffect(() => {
    if (!diffRec) return;
    const fresh = recordings.find(r => r.id === diffRec.id);
    if (fresh && fresh !== diffRec) setDiffRec(fresh);
  }, [recordings, diffRec]);

  // Re-transcribe a stored recording server-side and insert the text.
  const handleRecordingRetry = useCallback(async (rec: VoiceRecording) => {
    setRetranscribingId(rec.id);
    try {
      const result = await retranscribeRecording(rec.id, language);
      if (result.text) {
        onTranscribe(result.text);
        setDropdownOpen(false);
        log.info('stt', `Recovered recording ${rec.id}: "${result.text.slice(0, 50)}"`);
      }
      // Refresh list so the item now shows its text
      fetchRecordings(8).then(res => setRecordings(res.recordings)).catch(() => {});
    } catch (err) {
      log.error('stt', `Recording retry failed: ${err}`);
    } finally {
      setRetranscribingId(null);
    }
  }, [language, onTranscribe]);

  // Insert a recording's text — primary or shadow, whichever the user picked.
  const handleTextInsert = useCallback((text?: string) => {
    if (text) {
      onTranscribe(text);
      setDropdownOpen(false);
    }
  }, [onTranscribe]);

  const handleRetryModel = useCallback(async (modelName: string) => {
    setDropdownOpen(false);
    clearTimeout(dismissTimer.current);
    await retryWithModel(modelName);
    dismissTimer.current = setTimeout(() => setShowChevron(false), RETRY_DISMISS_MS);
  }, [retryWithModel]);

  const handleCopyPath = useCallback(() => {
    if (lastDebugPath) {
      navigator.clipboard.writeText(lastDebugPath).catch(() => {});
      log.info('stt', `Copied debug audio path: ${lastDebugPath}`);
    }
    setDropdownOpen(false);
  }, [lastDebugPath]);

  const handleAddVocab = useCallback(async () => {
    const w = vocabInput.trim();
    if (!w) return;
    // Check client-side duplicate
    if (vocabWords.some(v => v.toLowerCase() === w.toLowerCase())) {
      setVocabStatus(`"${w}" already exists`);
      setVocabInput('');
      setTimeout(() => setVocabStatus(null), 2000);
      return;
    }
    try {
      const res = await addVocabWord(w);
      if (res.added) {
        setVocabWords(prev => [...prev, w]);
        setVocabStatus(`Added "${w}"`);
      } else {
        setVocabStatus(`"${w}" already exists`);
      }
      setVocabInput('');
      setTimeout(() => setVocabStatus(null), 2000);
    } catch (err) {
      setVocabStatus(`Error: ${err}`);
    }
  }, [vocabInput, vocabWords]);

  if (!isSupported) return null;

  const sttUnavailable = !sttStatus.isLoading && (!sttStatus.isConfigured || !sttStatus.isAvailable);
  // Never grey out for "not configured" — a disabled button with a hover-only tooltip is
  // undiscoverable (first-run users think voice input doesn't exist). Keep it clickable
  // and route the click to Settings → Voice instead.
  const isDisabled = disabled || isTranscribing;

  const btnClass = [
    'btn mic-btn',
    size === 'sm' && 'mic-btn-sm',
    sttUnavailable && 'mic-unconfigured',
    isRecording && 'mic-recording',
    isRecording && silenceWarning && 'mic-recording-silent',
    isTranscribing && 'mic-transcribing',
  ].filter(Boolean).join(' ');

  const title = sttUnavailable
    ? `${sttStatus.error ?? 'STT not configured'} — click to set up`
    : error
      ? `Error: ${error}`
      : isTranscribing
        ? 'Transcribing...'
        : isRecording
          ? (silenceWarning ?? 'Stop recording')
          : 'Voice input';

  // Plain function (not useCallback): we're past an early return, hooks are not allowed here.
  const handleClick = () => {
    if (sttUnavailable) {
      navigate('/settings#stt');
      return;
    }
    // Arm the release bookkeeping on the press that STARTS a recording (the same
    // click stops one, and stopping must not re-arm it).
    if (!isRecording) {
      armed.current = true;
      delivered.current = false;
      sawLive.current = false;
    }
    void toggleRecording();
  };

  /**
   * Reaching for the mic must not cost the user their text selection: they select a
   * passage in a reply and dictate a question about it. What actually took it away
   * was the instant-clear guard in `main.tsx`, which this button now opts out of
   * (`data-keep-selection`) — that is the fix, and removing it puts the bug back.
   *
   * Dropping the press's FOCUS is a floor, not a proven fix, and the honest version
   * of the measurement is: focusing a button collapses the document selection in
   * WebKit (Chromium keeps it), but on macOS a click does not focus a button at all,
   * so the press test passes in both engines without this line. It stays because
   * "does a click focus a button" is a platform setting (macOS Full Keyboard Access
   * turns it on), not an invariant — and this is the same trade the quote pill's
   * buttons already make. Keyboard focus is untouched: only a pointer press is
   * prevented, Tab still lands here.
   */
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) e.preventDefault();
  };

  // Right-click opens the history/retry dropdown — a persistent entry point
  // that survives page reloads (the chevron only appears after a transcription).
  const handleContextMenu = (e: React.MouseEvent) => {
    if (sttUnavailable || isRecording) return;
    e.preventDefault();
    setShowChevron(true);
    void handleChevronClick(e);
  };

  const modelDisplayName = (m: GgmlModel) => {
    const cat = MODEL_CATALOG.find(c => c.filename === m.name || c.name === m.name);
    return cat?.displayName ?? m.name.replace('ggml-', '').replace('.bin', '');
  };

  const fmtLatency = (ms?: number) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '');

  return (
    <div className="mic-btn-wrapper" ref={wrapperRef}>
      <button
        className={btnClass}
        // THE BUTTON ONLY, never the wrapper: the wrapper also holds this mic's
        // dropdown (retry with another model, re-insert a past transcript), and those
        // items write into the composer too. Opting the whole wrapper out of the
        // instant-clear guard would keep a minutes-old selection alive across a menu
        // press and let it become the anchor for a transcript that has nothing to do
        // with it. Only the press that IS "dictate about this passage" keeps it.
        // Spread from the constant the guard matches on, so the two cannot drift.
        {...{ [KEEP_SELECTION_ATTR]: '' }}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        type="button"
        disabled={isDisabled}
        aria-label={title}
        title={title}
      >
        {isTranscribing ? (
          <svg className="mic-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
          </svg>
        ) : isRecording ? (
          <MicWaveform level={level} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="1" width="6" height="12" rx="3" />
            <path d="M19 10v2a7 7 0 01-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </button>
      {/* Non-destructive dead-mic warning — shown WHILE recording; recording is never
          auto-stopped, and this clears itself the moment sound is detected again. */}
      {isRecording && silenceWarning && (
        <div className="mic-silence-warning" role="status">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{silenceWarning}</span>
        </div>
      )}
      {/* Transcription failure — visible bubble (title-attr tooltips are undiscoverable).
          Offers Retry when the audio is still held; dismissed by starting a new recording
          (toggleRecording clears error) or clicking ✕. */}
      {error && !isRecording && !isTranscribing && !errorDismissed && (
        <div className="mic-silence-warning mic-error-bubble" role="alert">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
          {hasLastRecording && (
            <button type="button" className="mic-error-retry" onClick={() => void retryLast()}>
              Retry
            </button>
          )}
          <button type="button" className="mic-error-dismiss" aria-label="Dismiss" onClick={() => setErrorDismissed(true)}>
            ✕
          </button>
        </div>
      )}
      {/* Chevron badge — appears after transcription (outside button to avoid nested interactive elements) */}
      {showChevron && !isRecording && !isTranscribing && (
        <span
          className="mic-chevron-badge"
          onClick={handleChevronClick}
          role="button"
          tabIndex={0}
          title="Retry, vocabulary, or copy audio"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      )}

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="mic-retry-dropdown">
          {/* Model retry */}
          <div className="mic-retry-header">Retry with model</div>
          {modelsLoading && <div className="mic-retry-item mic-retry-loading">Loading...</div>}
          {downloadedModels.map(m => {
            const name = MODEL_CATALOG.find(c => c.filename === m.name)?.name ?? m.name;
            return (
              <button key={m.name} className="mic-retry-item" onClick={() => handleRetryModel(name)} type="button">
                <span className="mic-retry-model-name">{modelDisplayName(m)}</span>
                <span className="mic-retry-model-size">{(m.sizeBytes / 1e9).toFixed(1)}G</span>
              </button>
            );
          })}
          {!modelsLoading && downloadedModels.length === 0 && (
            <div className="mic-retry-item mic-retry-empty">No models downloaded</div>
          )}

          {/* Vocabulary */}
          <div className="mic-retry-divider" />
          <div className="mic-retry-header">Vocabulary</div>
          {vocabWords.length > 0 && (
            <div className="mic-vocab-tags">
              {vocabWords.map(w => (
                <span key={w} className="mic-vocab-tag">{w}</span>
              ))}
            </div>
          )}
          <div className="mic-vocab-input-row">
            <input
              ref={vocabInputRef}
              className="mic-vocab-input"
              type="text"
              placeholder="Add word..."
              value={vocabInput}
              onChange={e => setVocabInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handleAddVocab(); }
                if (e.key === 'Escape') { setDropdownOpen(false); }
              }}
            />
            <button
              className="btn mic-vocab-add-btn"
              onClick={handleAddVocab}
              type="button"
              disabled={!vocabInput.trim()}
            >
              +
            </button>
          </div>
          {vocabStatus && <div className="mic-vocab-status">{vocabStatus}</div>}

          {/* Voice history — server-side recordings; every one is recoverable */}
          {recordings.length > 0 && (
            <>
              <div className="mic-retry-divider" />
              <div className="mic-retry-header">Recent voice input</div>
              {recordings.map(rec => {
                const time = rec.timestamp ? new Date(rec.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const text = rec.result?.text ?? '';
                const failed = !text;
                const expanded = expandedId === rec.id;
                return (
                  <div key={rec.id} className={`mic-history-item${failed ? ' mic-history-failed' : ''}${expanded ? ' mic-history-open' : ''}`}>
                    {/* Header row — click toggles the full A/B comparison */}
                    <div className="mic-history-main" role="button" tabIndex={0}
                      title={expanded ? 'Collapse' : 'Expand to compare both engines'}
                      onClick={() => setExpandedId(expanded ? null : rec.id)}>
                      <span className={`mic-history-caret${expanded ? ' mic-history-caret-open' : ''}`}>▸</span>
                      <span className="mic-history-time">{time}</span>
                      {!expanded && (
                        <span className="mic-history-text" title={failed ? (rec.error ?? 'No transcription') : text}>
                          {failed ? (rec.error ? `Failed: ${rec.error}` : 'No transcription') : text}
                        </span>
                      )}
                    </div>
                    <div className="mic-history-actions">
                      <button type="button" className="mic-history-btn mic-history-menu-btn" title="Actions"
                        aria-haspopup="menu" aria-expanded={actionMenuId === rec.id}
                        onClick={() => setActionMenuId(actionMenuId === rec.id ? null : rec.id)}>
                        {retranscribingId === rec.id ? '…' : '⋯'}
                      </button>
                      {actionMenuId === rec.id && (
                        <div className="mic-history-menu" role="menu">
                          {rec.secondary && (
                            <button type="button" className="mic-history-menu-item" title="Compare both engines in a popup"
                              onClick={() => { setActionMenuId(null); setDiffRec(rec); }}>
                              Diff
                            </button>
                          )}
                          {text && (
                            <button type="button" className="mic-history-menu-item" title="Insert this text"
                              onClick={() => { setActionMenuId(null); handleTextInsert(text); }}>
                              Insert
                            </button>
                          )}
                          <button type="button" className="mic-history-menu-item" title="Re-transcribe from stored audio"
                            disabled={retranscribingId === rec.id}
                            onClick={() => { setActionMenuId(null); void handleRecordingRetry(rec); }}>
                            Redo
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Expanded: both engines' FULL text + latency, each insertable —
                        the side-by-side comparison this panel exists for. */}
                    {expanded && (
                      <div className="mic-history-expanded">
                        <div className="mic-history-full">
                          <div className="mic-history-full-head">
                            <span className="mic-history-alt-engine">{rec.engine ?? 'primary'}</span>
                            <span className="mic-history-lat">{fmtLatency(rec.result?.durationMs)}</span>
                            {text && (
                              <button type="button" className="mic-history-btn" title="Insert this text"
                                onClick={() => handleTextInsert(text)}>
                                Insert
                              </button>
                            )}
                          </div>
                          <div className={`mic-history-full-text${failed ? ' mic-history-alt-error' : ''}`}>
                            {failed ? (rec.error ? `Failed: ${rec.error}` : 'No transcription') : text}
                          </div>
                        </div>
                        {rec.secondary ? (
                          <div className="mic-history-full">
                            <div className="mic-history-full-head">
                              <span className="mic-history-alt-engine">{rec.secondary.engine}</span>
                              <span className="mic-history-lat">{fmtLatency(rec.secondary.durationMs)}</span>
                              {rec.secondary.text && (
                                <button type="button" className="mic-history-btn" title="Insert the secondary engine's text"
                                  onClick={() => handleTextInsert(rec.secondary?.text)}>
                                  Insert
                                </button>
                              )}
                            </div>
                            <div className={`mic-history-full-text${rec.secondary.error ? ' mic-history-alt-error' : ''}`}>
                              {rec.secondary.error ? `Failed: ${rec.secondary.error}` : rec.secondary.text}
                            </div>
                          </div>
                        ) : (
                          <div className="mic-history-full-pending">secondary engine still running…</div>
                        )}
                      </div>
                    )}
                    {/* Collapsed: one-line shadow preview. Single-letter engine
                        badge — the full name ("WHISPER-SERVER") eats half the
                        row and hurts readability; it lives in the tooltip and
                        the expanded/diff views instead. */}
                    {!expanded && rec.secondary && (
                      <div className="mic-history-secondary">
                        <span className="mic-history-alt-engine mic-history-alt-badge" title={`Secondary engine: ${rec.secondary.engine}`}>
                          {(rec.secondary.engine?.[0] ?? '?').toUpperCase()}
                        </span>
                        <span
                          className={`mic-history-text${rec.secondary.error ? ' mic-history-alt-error' : ''}`}
                          title={rec.secondary.error ?? rec.secondary.text}
                        >
                          {rec.secondary.error ? `Failed: ${rec.secondary.error}` : rec.secondary.text}
                        </span>
                        {rec.secondary.text && (
                          <button type="button" className="mic-history-btn" title="Insert the secondary engine's text"
                            onClick={() => handleTextInsert(rec.secondary?.text)}>
                            Insert
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* Copy path */}
          {lastDebugPath && (
            <>
              <div className="mic-retry-divider" />
              <button className="mic-retry-item" onClick={handleCopyPath} type="button">
                <span>Copy audio path</span>
                <span className="mic-retry-model-size">📋</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Full-size A/B diff popup (word-level, latency per engine) */}
      {diffRec && (
        <SttDiffModal
          rec={diffRec}
          onInsert={(t) => { handleTextInsert(t); setDiffRec(null); }}
          onClose={() => setDiffRec(null)}
        />
      )}
    </div>
  );
}
